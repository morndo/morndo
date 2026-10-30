// morndo-update's composition root (design §4.6, §4.7, §6.1, §6.7, §8.1, §8.3, §8.4, §10.3): the one place the
// application's services meet real adapters — the paths from HOME, the HTTPS feed and artifacts, the
// versioned-directories installer, the SQLite store, the settings file, the system clock, the systemd or launchd
// manager this machine runs. The command line is parsed here and nowhere else; the exit codes are sysexits.h's,
// as in the rest of Morndo. The applies run as the machine's own units (§6.2): `morndo update` starts the apply
// unit and reports its record; the tick, the boot and the recovery units run the same services themselves.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  compareVersions, formatVersion, parseVersion, rollbackRestores, DEFAULT_SOAK_MINUTES,
  type Channel, type Platform, type ProtocolRange, type UpdateService, type Version, type Window,
} from "@morndo/domain";
import { ATTEMPT_ID, KeySetSchema, ManifestSchema, UpdateStatusSchema } from "@morndo/protocol";
import { ApplyService, type ApplyOutcome } from "./application/apply-service.ts";
import { planOf, type ApplyTiming } from "./application/apply-steps.ts";
import { CHECKOUT_SENTENCE, CheckService, type CheckOutcome } from "./application/check-service.ts";
import { doctor } from "./application/doctor-service.ts";
import { FEED_CHECK_MS, FRESH_VIEW_MS, applyUnitGate, controlPlaneSkew, deferSentence, nodeGate, nodeToGate } from "./application/fleet-follow.ts";
import type { RecoverOutcome } from "./application/recovery-service.ts";
import { RecoveryService } from "./application/recovery-service.ts";
import { planSettings } from "./application/settings-commands.ts";
import { formatStatus, readStatus } from "./application/status-service.ts";
import type {
  AlertSink, ArtifactStore, FleetNode, FleetView, ReleaseFeed, RoleProbe, ServiceManager, SettingsChange,
  UpdateHistory,
} from "./application/ports.ts";
import { ConfigBusy, ConfigFile, ConfigInvalid, ConfigWriteFailed } from "./adapters/config-file.ts";
import { ApplyingFileMarker } from "./adapters/applying-file.ts";
import { HttpsArtifacts } from "./adapters/artifacts-https.ts";
import { SqliteBackup } from "./adapters/backup-sqlite.ts";
import { FleetSocketView } from "./adapters/fleet-socket.ts";
import { FleetStatusView, machineNameOf, ownOnlineNodeOf } from "./adapters/fleet-status.ts";
import { DeadlineFeed } from "./adapters/feed-deadline.ts";
import { HttpsFeed } from "./adapters/feed-https.ts";
import { HoldFileWriter } from "./adapters/hold-file.ts";
import { DirsInstaller } from "./adapters/installer-dirs.ts";
import { LaunchdServices } from "./adapters/services-launchd.ts";
import { ServiceProbes, ownerOriginAllowed } from "./adapters/probes.ts";
import { SqliteRevocations } from "./adapters/revocations-sqlite.ts";
import { SqliteSchemas } from "./adapters/schema-sqlite.ts";
import { StateFileWriter } from "./adapters/state-file.ts";
import { SystemdServices, systemdUserManager } from "./adapters/services-systemd.ts";
import { databasePaths, updaterPaths } from "./adapters/paths.ts";
import { openUpdateStore, SqliteUpdateStore, UpdateDbFromFuture } from "./adapters/store-sqlite.ts";
import { SshSigVerifier, randomAttemptId } from "./adapters/verifier-sshsig.ts";

// Q4: the feed lives on the GitHub Pages of the public repository. A mirror may override it (§8.3): the address
// decides nothing about trust, the signatures do.
export const DEFAULT_FEED_BASE = "https://morndo.github.io/morndo/";

// sysexits.h, as the rest of Morndo reads it (§8.4): 64 usage; 65 a verification failed (EX_DATAERR); 70 the
// rollback itself failed (EX_SOFTWARE); 75 try later (EX_TEMPFAIL); 78 nothing to do on this machine, a setting
// to fix (EX_CONFIG); 1 a rolled-back update, or a doctor finding.
// The one budget of the install's closing check (§10.3): the key walk and the channel, together.
const FIRST_CHECK_MS = 60_000;
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 64;
const EXIT_DATAERR = 65;
const EXIT_SOFTWARE = 70;
const EXIT_TEMPFAIL = 75;
const EXIT_CONFIG = 78;

const USAGE = `usage: morndo-update update [--yes] [--now] [--detach] [--staged <v>]   check, then apply what stands staged (asks first on a terminal; --staged applies only <v>)
       morndo-update update --to <version> [--yes] [--now] [--detach] [--json]   check, stage exactly <version>, then ask and apply as update does
       morndo-update update --to <version> --check [--json]   stage exactly <version>; apply nothing
       morndo-update update --check [--json]        check the channel feed, verify, and stage what passes
       morndo-update update --status [--json]       what this machine believes, the last updates included
       morndo-update update --rollback [--yes] [--detach] [--typed rollback]   back to the previous Version (a restore asks for the typed word; --typed carries it under --yes)
       morndo-update update --rollback --preview --json   what a rollback would drop, as JSON; writes and starts nothing
       morndo-update update apply --version <v> [--attempt <id>]   one apply, as the apply unit runs it
       morndo-update update tick | boot | recover   the timer's, the boot unit's and the recovery unit's commands
       morndo-update update --channel stable|latest set the channel
       morndo-update update auto apply|stage|off    set the mode
       morndo-update update pin <version>           hold this machine at a Version
       morndo-update update unpin                   remove the pin
       morndo-update update window <HH:MM-HH:MM>|any   local hours for automatic applies, or any
       morndo-update install --role control-plane|node [--channel stable|latest] [--force]
       morndo-update doctor [--json]                re-verify the installed tree`;

// A settings write's own failures (§8.4): a file that is not the settings shape, a permission to fix, or a lock
// another command still holds. Anything else propagates. null: this error is not one of those.
const settingsWriteCode = (error: unknown, io: { err(s: string): void }): number | null => {
  if (error instanceof ConfigInvalid) { io.err(`${error.message}\n`); return EXIT_CONFIG; }
  if (error instanceof ConfigWriteFailed) {
    io.err(`${error.message}\n`);
    return error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS" ? EXIT_CONFIG : EXIT_TEMPFAIL;
  }
  if (error instanceof ConfigBusy) { io.err(`${error.message}\n`); return EXIT_TEMPFAIL; }
  return null;
};
// UpdateConfigSchema's window (§8.3): 24-hour, zero-padded. A window past midnight (22:00-06:00) matches.
const WINDOW_TEXT = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const windowOf = (text: string): Window => {
  const [start, end] = text.split("-");
  const minutes = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  return { start: minutes(start!), end: minutes(end!) };
};
// §4.7: a machine whose services no manager runs — no systemd user manager, no launchd — stages only (§6.1's
// step 1 without step 2): --check works, nothing applies, nothing runs.
const NO_MANAGER = "no service manager runs here (neither systemd nor launchd): this machine stages only; --check still works";

// The machine's own word for its platform, the Manifest's `platform` for this Artifact (§9.3). Nothing else ships.
export function platformWord(platform: NodeJS.Platform, arch: string): Platform | null {
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  return null;
}

// One line per check outcome (§8.1), the sentence a phone or a terminal reads alike. The JSON carries the outcome
// itself; this is its prose. A `--to` refusal names the Version in the domain's own words; a plain check's skip
// stays the one sentence it always was.
type ToLine = { to: true; channel: string; pin: string | null; current: string; highestCommitted: string | null };
const toSentence = (o: CheckOutcome & { kind: "skipped" }, ctx: ToLine): string => {
  const v = o.version ?? "";
  switch (o.reason) {
    case "no_entry": return `${v} is not in the ${ctx.channel} feed (--to takes a Version the machine's own channel lists; switch with --channel first)`;
    case "withdrawn": return `${v} was withdrawn; it is not offered`;
    case "pinned": return `this machine is pinned to ${ctx.pin ?? ""}; morndo update unpin first`;
    case "bad_here": return `${v} failed on this machine before and is not tried again`;
    case "downgrade_refused": return `${v} is lower than the running ${ctx.current}; morndo update --rollback goes back to the previous Version`;
    case "below_committed": return `${v} is at or below ${ctx.highestCommitted ?? ""}, the highest Version this machine has run; an apply never takes one (RL2); morndo update --rollback goes back one Version`;
    case "halted": return `the rollout of ${v} is halted (RL12): it is resumed on the control plane, not by naming it here`;
    case "not_newer": return `Up to date: ${v} is already running.`;
    default: return `Skipped: ${o.reason}. Nothing was staged.`;
  }
};
const checkLine = (o: CheckOutcome, to?: ToLine): string => {
  if (to !== undefined && o.kind === "skipped") return toSentence(o, to);
  switch (o.kind) {
    case "staged": return `Staged ${o.version}. It applies at the next update --yes, the tick's window, or the next boot.`;
    case "up_to_date": return `Up to date: ${o.current}.`;
    case "feed_verified": return `The ${o.channel} feed checks out (seq ${o.seq}); the update timer looks for a newer Version.`;
    case "refused": return `Refused: ${o.step} (${o.detail}). Nothing was staged.`;
    case "skipped": return `Skipped: ${o.reason}. Nothing was staged.`;
    case "busy": return "Busy: another process holds the apply lock.";
    case "unreachable": return `Unreachable: ${o.detail}.`;
    case "failed": return `Failed: ${o.detail}. Nothing was staged; the next check tries again.`;
    case "not_ours": return o.detail;
  }
};
// A plain check's skip exits 0. A `--to` refusal exits by what the named Version is: not one this machine may
// take (64), a pin to lift (78), a halt or a control plane to wait on (75), or the Version already running (0).
export const checkCode = (o: CheckOutcome, toAsk = false): number => {
  if (toAsk && o.kind === "skipped") {
    if (o.reason === "not_newer") return EXIT_OK;
    if (o.reason === "pinned") return EXIT_CONFIG;
    if (o.reason === "halted") return EXIT_TEMPFAIL;
    if (o.reason === "no_entry" || o.reason === "withdrawn" || o.reason === "bad_here" || o.reason === "downgrade_refused" || o.reason === "below_committed") return EXIT_USAGE;
  }
  return o.kind === "refused" ? EXIT_DATAERR
    : o.kind === "busy" || o.kind === "unreachable" || o.kind === "failed" ? EXIT_TEMPFAIL
    : o.kind === "not_ours" ? EXIT_CONFIG
    : EXIT_OK;
};

// One line per apply outcome (§8.1), and its exit (§8.4): committed 0, rolled back 1, rollback failed 70, and
// 75 for everything that asks to be tried again — deferred, busy, an attempt that never finished.
const applyLine = (o: ApplyOutcome): string => {
  switch (o.kind) {
    case "committed": return `Committed ${o.version}.`;
    case "boot_started": return `Swapped to ${o.version} before the services start; the recovery unit judges them.`;
    case "deferred": return `Deferred: ${o.reason} (${o.blockers.join(", ")}).`;
    case "abandoned": return `Not applied: ${o.reason}. The old Version runs.`;
    case "rolled_back": return `Rolled back to ${o.version}: ${o.reason}.`;
    case "rollback_failed": return `The rollback failed: ${o.reason}. This machine needs a person.`;
    case "rollback_waiting": return `The rollback waits: ${o.reason}.`;
    case "busy": return "Busy: another process holds the apply lock.";
    case "nothing_staged": return "Nothing stands staged.";
    case "no_previous": return "No previous Version to roll back to.";
    case "not_ours": return o.detail;
  }
};
const applyCode = (o: ApplyOutcome): number =>
  o.kind === "committed" || o.kind === "boot_started" ? EXIT_OK
  : o.kind === "rolled_back" ? EXIT_FAILED
  : o.kind === "rollback_failed" ? EXIT_SOFTWARE
  : o.kind === "no_previous" || o.kind === "not_ours" ? EXIT_CONFIG
  : EXIT_TEMPFAIL;

// The rollback preview's clock words (§11.4): a moment as a person reads one, and an age in the largest whole
// unit that is not zero — the span of writes a restore would drop, printed before the word is asked for.
const stampOf = (ms: number): string => {
  const t = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())} ${two(t.getHours())}:${two(t.getMinutes())}`;
};
const ageWords = (ms: number): string => {
  if (ms < 60_000) return "less than a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
};

// The recovery unit's outcome to one line and one exit (§6.6, §8.4).
const recoverLine = (o: RecoverOutcome): string => {
  switch (o.kind) {
    case "nothing_open": return "Nothing to recover.";
    case "abandoned": return "An attempt that never swapped is abandoned; the old Version runs.";
    case "committed": return `Committed ${o.version}.`;
    case "rolled_back": return `Rolled back to ${o.version}: ${o.reason}.`;
    case "rollback_failed": return `The rollback failed: ${o.reason}. This machine needs a person.`;
    case "rollback_waiting": return `The rollback waits: ${o.reason}.`;
    case "busy": return "Busy: another process holds the apply lock.";
    case "unknown_record": return `An open record this build does not know (${o.detail}); nothing was done.`;
  }
};
const recoverCode = (o: RecoverOutcome): number =>
  o.kind === "committed" || o.kind === "nothing_open" || o.kind === "abandoned" ? EXIT_OK
  : o.kind === "rolled_back" ? EXIT_FAILED
  : o.kind === "busy" || o.kind === "rollback_waiting" ? EXIT_TEMPFAIL
  : EXIT_SOFTWARE;

const systemClock = { now: (): number => Date.now() };
const realSleeper = { sleep: (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms)) };

// The machine's own parts a test replaces wholesale; production builds the real ones below. Used nowhere else.
export type UpdaterDeps = {
  services?: ServiceManager;
  probe?: RoleProbe;
  feed?: ReleaseFeed;
  artifacts?: ArtifactStore;
  /** The fleet's word, both roles' gates and the control plane's reporting (§7); tests fake it. */
  fleet?: FleetView;
  /** The node's own drawn delay (§7) comes from here; tests fix the draw. */
  random?: () => number;
  timing?: Partial<ApplyTiming>;
  /** §10.3's tree the program runs from; production discovers it around argv[1]. */
  tree?: string;
  /** The one budget of the install's closing check (§10.3); 60 s by default, tests shorten it. */
  firstCheckMs?: number;
};

export async function runUpdater(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: { out(s: string): void; err(s: string): void; tty?: boolean; ask?: (prompt: string) => Promise<string> },
  deps: UpdaterDeps = {},
): Promise<number> {
  // §10.2 step 1, before any command: TLS with Node's own certificate checks. Switching them off is not a mode this
  // program has; a wrapper that set it would strip the first layer for every fetch at once.
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    io.err("refusing to run with NODE_TLS_REJECT_UNAUTHORIZED=0: TLS checks are off\n");
    return EXIT_CONFIG;
  }
  // Every path derives from HOME (§5): a relative or unset one would scatter the updater's files through the
  // working directory, so it is refused before anything is read.
  const home = env.HOME ?? "";
  if (home === "" || !isAbsolute(home)) {
    io.err(`HOME must name an absolute path (the updater's paths derive from it), not ${JSON.stringify(env.HOME ?? "")}\n`);
    return EXIT_CONFIG;
  }

  // ---- the command line (§8.1): parsed here and nowhere else
  const [command = "", ...flags] = argv;
  if (command !== "update" && command !== "doctor" && command !== "install") { io.err(`${USAGE}\n`); return EXIT_USAGE; }
  const json = flags.includes("--json");

  type Parsed
    = { cmd: "check"; to?: Version }
    | { cmd: "status" }
    | { cmd: "doctor" }
    | { cmd: "update"; yes: boolean; now: boolean; detach: boolean; staged?: string; to?: Version }
    | { cmd: "rollback"; yes: boolean; detach: boolean; preview: boolean; typed?: string }
    | { cmd: "apply-unit"; version: string; attempt?: string }
    | { cmd: "tick" } | { cmd: "boot" } | { cmd: "recover" }
    | { cmd: "settings"; change: SettingsChange }
    | { cmd: "install"; role: "control-plane" | "node"; channel: Channel; force: boolean };
  const usage = (): number => { io.err(`${USAGE}\n`); return EXIT_USAGE; };
  let parsed: Parsed;
  if (command === "doctor") {
    if (flags.some(f => f !== "--json")) return usage();
    parsed = { cmd: "doctor" };
  } else if (command === "install") {
    let role: "control-plane" | "node" | null = null;
    let channel: Channel | null = null;
    let force = false;
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--role" && (flags[i + 1] === "control-plane" || flags[i + 1] === "node")) { role = flags[i + 1] as "control-plane" | "node"; i++; }
      else if (flags[i] === "--channel" && (flags[i + 1] === "stable" || flags[i + 1] === "latest")) { channel = flags[i + 1] as Channel; i++; }
      else if (flags[i] === "--force") force = true;
      else return usage();
    }
    if (role === null) return usage();
    parsed = { cmd: "install", role, channel: channel ?? "stable", force };
  } else {
    // update: one subcommand, or one flag set — never two asks in one line. Bare `update` is the ask itself.
    // `--to <version>` is its own ask (§8.1): stage that Version, then apply as bare update does, or `--check`
    // to stage only. Anything else riding `--to` is usage, before a feed is fetched or a file is written.
    const toAt = flags.flatMap((flag, index) => flag === "--to" ? [index] : []);
    if (toAt.length > 0) {
      if (toAt.length !== 1) return usage();
      const at = toAt[0]!;
      const raw = flags[at + 1];
      const version = raw === undefined || raw.startsWith("--") ? null : parseVersion(raw);
      if (version === null) return usage();
      const rest = flags.filter((_, index) => index !== at && index !== at + 1);
      if (rest.includes("--check")) {
        if (!rest.every(flag => flag === "--check" || flag === "--json")) return usage();
        parsed = { cmd: "check", to: version };
      } else {
        let yes = false, now = false, detach = false;
        for (const flag of rest) {
          if (flag === "--yes") yes = true;
          else if (flag === "--now") now = true;
          else if (flag === "--detach") detach = true;
          else if (flag === "--json") continue;
          else return usage();
        }
        if (detach && now) return usage();
        parsed = { cmd: "update", yes, now, detach, to: version };
      }
    } else if (flags.includes("--rollback")) {
      // The ask's own words: --yes answers it, --detach hands the walk to §5's unit (PR 6c), --preview --json is
      // the hub's read-only look, and --typed carries the word a restore demands even under --yes (§11.4, review
      // round 1) — the hub's --yes must not skip what a terminal would make a person type.
      let yes = false, detach = false, preview = false, asJson = false, typed: string | undefined;
      let wellFormed = true;
      for (let i = 0; i < flags.length; i++) {
        const f = flags[i]!;
        if (f === "--rollback") continue;
        else if (f === "--yes") yes = true;
        else if (f === "--detach") detach = true;
        else if (f === "--preview") preview = true;
        else if (f === "--json") asJson = true;
        else if (f === "--typed") {
          const word = flags[i + 1];
          if (word === undefined || word.startsWith("--")) { wellFormed = false; break; }
          typed = word;
          i += 1;
        } else { wellFormed = false; break; }
      }
      if (!wellFormed) return usage();
      // The preview is exactly the hub's form — a look, nothing to answer or start: no --yes to answer, no unit
      // to detach, no word to carry; and --json rides the rollback for it alone.
      if (preview && (!asJson || yes || detach || typed !== undefined)) return usage();
      if (!preview && asJson) return usage();
      // The word answers --yes's ask: a terminal types it at the prompt, not on the command line.
      if (typed !== undefined && !yes) return usage();
      if (typed !== undefined && typed !== "rollback") {
        io.err(`--typed wants the word rollback — the same word the terminal asks for when a restore drops writes — not ${JSON.stringify(typed)}\n`);
        return EXIT_USAGE;
      }
      parsed = { cmd: "rollback", yes, detach, preview, ...(typed === undefined ? {} : { typed }) };
    } else if (flags.length === 0 || flags[0] === "--yes" || flags[0] === "--now" || flags[0] === "--json" || flags[0] === "--detach" || flags[0] === "--staged") {
      // `--staged <v>` (PR 6c round 2, R3) names the Version the hub's Updates screen pressed — the only one this
      // run applies (the guard below), so a Release staged between the screen's look and the press never starts by
      // a press of an older name. It rides --yes: the hub's own command, whose ask that flag has already answered.
      let yes = false, now = false, detach = false, staged: string | undefined;
      for (let i = 0; i < flags.length; i++) {
        const f = flags[i]!;
        if (f === "--yes") yes = true;
        else if (f === "--now") now = true;
        else if (f === "--json") continue;                  // read above; the outcome's JSON stays one shape
        else if (f === "--detach") detach = true;
        else if (f === "--staged") {
          const v = flags[i + 1];
          if (v === undefined || v.startsWith("--")) return usage();
          staged = v;
          i += 1;
        } else return usage();
      }
      if (detach && now) return usage();   // two asks: --now's file is removed by a waited start (§6.2); --detach cannot own it
      if (staged !== undefined && !yes) return usage();
      parsed = { cmd: "update", yes, now, detach, ...(staged === undefined ? {} : { staged }) };
    } else if (flags[0] === "tick" && flags.length === 1) parsed = { cmd: "tick" };
    else if (flags[0] === "boot" && flags.length === 1) parsed = { cmd: "boot" };
    else if (flags[0] === "recover" && flags.length === 1) parsed = { cmd: "recover" };
    else if (flags[0] === "apply") {
      // "rollback" is the one instance name that is not a Version: the apply unit the rollback command starts
      // (§5) is named for what it does, and what it does is not an apply of a staged Version. §5.4's attempt id
      // rides the command line when the unit was handed one (its template reads MORNDO_ATTEMPT from the
      // environment file the agent wrote); an empty value is absence — systemd's own expansion of an unset
      // variable — and the shape is judged where the apply runs, not here.
      const versionAt = (i: number): boolean => flags[i] !== undefined && flags[i] === "--version";
      if (flags.length === 3 && versionAt(1) && (flags[2] === "rollback" || parseVersion(flags[2]!) !== null)) {
        parsed = { cmd: "apply-unit", version: flags[2]! };
      } else if (flags.length === 5 && versionAt(1) && flags[3] === "--attempt" && parseVersion(flags[2]!) !== null) {
        parsed = { cmd: "apply-unit", version: flags[2]!, attempt: flags[4]! };
      } else if (flags.length === 4 && versionAt(1) && flags[3]!.startsWith("--attempt=")
        && (flags[2] === "rollback" || parseVersion(flags[2]!) !== null)) {
        // the unit's own form: `--attempt=${MORNDO_ATTEMPT}` stays one word when the value is unset (systemd.service(5):
        // "${FOO}" is one argument), so an empty value reaches here as "--attempt=" and is judged below, by name
        parsed = { cmd: "apply-unit", version: flags[2]!, attempt: flags[3]!.slice("--attempt=".length) };
      } else return usage();
    } else if (flags[0] === "--channel" && flags.length === 2 && (flags[1] === "stable" || flags[1] === "latest")) {
      parsed = { cmd: "settings", change: { kind: "channel", channel: flags[1] } };
    } else if (flags[0] === "--channel") return usage();
    else if (flags[0] === "auto" && flags.length === 2 && (flags[1] === "apply" || flags[1] === "stage" || flags[1] === "off")) {
      parsed = { cmd: "settings", change: { kind: "mode", mode: flags[1] } };
    } else if (flags[0] === "auto") return usage();
    else if (flags[0] === "pin" && flags.length === 2) {
      const version = parseVersion(flags[1] ?? "");
      if (version === null) {
        io.err(`${JSON.stringify(flags[1])} is not a Version\n`);
        return EXIT_USAGE;
      }
      parsed = { cmd: "settings", change: { kind: "pin", version } };
    } else if (flags[0] === "pin") return usage();
    else if (flags[0] === "unpin" && flags.length === 1) parsed = { cmd: "settings", change: { kind: "unpin" } };
    else if (flags[0] === "unpin") return usage();
    else if (flags[0] === "window" && flags.length === 2 && flags[1] === "any") {
      parsed = { cmd: "settings", change: { kind: "windowAny" } };
    } else if (flags[0] === "window" && flags.length === 2 && WINDOW_TEXT.test(flags[1] ?? "")) {
      const window = windowOf(flags[1]!);
      // Equal ends wrap, in the domain, to every minute of the day (windowContains). That is `window any`.
      if (window.start === window.end) {
        io.err(`a window whose start equals its end is ambiguous (the domain reads it as all day); use "window any" for any hour\n`);
        return EXIT_USAGE;
      }
      parsed = { cmd: "settings", change: { kind: "window", window } };
    } else if (flags[0] === "window") return usage();
    else if (flags.includes("--check") && flags.every(f => f === "--check" || f === "--json")) parsed = { cmd: "check" };
    else if (flags.includes("--status") && flags.every(f => f === "--status" || f === "--json")) parsed = { cmd: "status" };
    else return usage();
  }

  // The environment every command stands in (§8.3): where the feed is, which platform this is, what the settings
  // say. A setting that cannot be read as written is a fix, not a guess (EX_CONFIG, one sentence).
  let feedBase = DEFAULT_FEED_BASE;
  if (env.MORNDO_UPDATE_FEED !== undefined) {
    if (!env.MORNDO_UPDATE_FEED.startsWith("https://")) {
      io.err(`MORNDO_UPDATE_FEED must be an https:// URL, not ${JSON.stringify(env.MORNDO_UPDATE_FEED)}\n`);
      return EXIT_CONFIG;
    }
    feedBase = env.MORNDO_UPDATE_FEED.endsWith("/") ? env.MORNDO_UPDATE_FEED : `${env.MORNDO_UPDATE_FEED}/`;
  }
  if (env.MORNDO_ORIGIN !== undefined && !ownerOriginAllowed(env.MORNDO_ORIGIN)) {
    io.err(`MORNDO_ORIGIN must be https, or http on localhost or 127.0.0.1, not ${JSON.stringify(env.MORNDO_ORIGIN)}\n`);
    return EXIT_CONFIG;
  }
  const platform = platformWord(process.platform, process.arch);
  if (platform === null) {
    io.err(`no Morndo build for ${process.platform}-${process.arch}: nothing to update with\n`);
    return EXIT_CONFIG;
  }
  const paths = updaterPaths(home);
  const settings = new ConfigFile(paths.config);
  try { settings.read(); }
  catch (error) {
    if (!(error instanceof ConfigInvalid)) throw error;
    io.err(`${error.message}\n`);
    return EXIT_CONFIG;
  }

  // The settings commands (§8.1, §8.3): the file was read once, above. They edit that file and nothing else — no
  // service manager, no feed, no store. A switch stops updates, not this edit; the sentence says it still holds.
  if (parsed.cmd === "settings") {
    // Read-only: the current link, when this updater owns the install. No store, no manager, no feed.
    const currentText = new DirsInstaller({ releases: paths.releases }).layout().current;
    const running = currentText === null ? null : parseVersion(currentText);
    const plan = planSettings(settings.read(), parsed.change, {
      disableUpdates: env.MORNDO_DISABLE_UPDATES === "1",
      disableAutoUpdate: env.MORNDO_DISABLE_AUTOUPDATE === "1",
    }, running);
    try { settings.change(plan.change); }
    catch (error) {
      const code = settingsWriteCode(error, io);
      if (code === null) throw error;
      return code;
    }
    io.out(`${plan.sentence}\n`);
    return EXIT_OK;
  }

  // The store is every command's (§5): the state directory is the store's own, private before anything lands in it.
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  let store: SqliteUpdateStore;
  try { store = openUpdateStore({ db: paths.db, lock: paths.lock }); }
  catch (error) {
    if (!(error instanceof UpdateDbFromFuture)) throw error;
    io.err(`${error.message} Run the newer Morndo once, or remove ${paths.db} to start its record empty.\n`);
    return EXIT_CONFIG;
  }
  try {
    const installer = new DirsInstaller({ releases: paths.releases });
    const verifier = new SshSigVerifier();
    const dbPaths = databasePaths(home, env);

    // The manager this machine runs (§4.7), asked for once: systemd where a user manager answers, launchd on
    // macOS, and null — stage only — where neither does. The applies' doors all answer 78 for null.
    let managerMemo: ServiceManager | null | undefined = deps.services !== undefined ? deps.services : undefined;
    const manager = async (): Promise<ServiceManager | null> => {
      if (managerMemo !== undefined) return managerMemo;
      if (process.platform === "darwin") managerMemo = new LaunchdServices({ home });
      else if (await systemdUserManager()) managerMemo = new SystemdServices({ home, units: join(home, ".config/systemd/user") });
      else managerMemo = null;
      return managerMemo;
    };
    // The probes over the machine's own doors (§6.3): the hub on this machine, the fleet on its socket, the
    // agent from the status file it rewrites.
    const probe: RoleProbe = deps.probe ?? new ServiceProbes({
      hubUrl: `http://127.0.0.1:${env.MORNDO_PORT ?? 8790}`,
      fleetSocket: env.MORNDO_FLEET_SOCKET || join(home, ".local/state/morndo-fleet/fleet.sock"),
      nodeStatus: join(home, ".local/state/morndo-node/status.json"),
      ownerPath: {
        ...(env.MORNDO_ORIGIN !== undefined ? { origin: env.MORNDO_ORIGIN } : {}),
        managerLane: true,
      },
    });
    const alerts: AlertSink = {
      raise: (kind, detail) => { io.err(`${kind}: ${detail}\n`); },
    };
    // The fleet's word (§7), by role: a control plane — running the hub and the fleet, as the boot apply asks —
    // asks the fleet over its socket and tells it what it committed and what halted; a node reads what its own
    // agent last wrote down. A test's fleet replaces whichever this machine is.
    const nodeStatusPath = join(home, ".local/state/morndo-node/status.json");
    const socketFleetView = new FleetSocketView({
      socketPath: env.MORNDO_FLEET_SOCKET || join(home, ".local/state/morndo-fleet/fleet.sock"),
      clock: systemClock,
    });
    const nodeFleetView = new FleetStatusView({ path: join(home, ".local/state/morndo-node/fleet-view.json") });
    let fleetMemo: FleetView | undefined;
    const fleetOf = async (): Promise<FleetView> => {
      if (deps.fleet !== undefined) return deps.fleet;
      if (fleetMemo !== undefined) return fleetMemo;
      const m = await manager();
      const running = m === null ? [] : m.services();
      fleetMemo = running.includes("hub") && running.includes("fleet") ? socketFleetView : nodeFleetView;
      return fleetMemo;
    };
    // §7's machine name — the node name the agent reports, "control-plane" without one — the updater's own state
    // file, and the soak this machine's settings name (§4.5; null is the domain's default).
    const machineName = machineNameOf(nodeStatusPath);
    const stateSink = new StateFileWriter({ path: join(paths.state, "state.json") });
    const soakOf = (): number => settings.read().soakMinutes ?? DEFAULT_SOAK_MINUTES;
    // §5.4's attempt id, minted where no other source can name one — the control plane's own applies: 16 random
    // bytes, base64url, the same shape the fleet's own ids come in.
    const mintAttempt = randomAttemptId;
    // The control plane's skew gate (§7, RL11), the same at every apply door: the fleet's own node list against
    // the target's Manifest protocol range, asked live over the socket. A hold defers (75) and state.json names
    // it — "skew_blocked:" with the nodes, or a fleet that could not be asked at all; a target whose staged
    // record cannot be read never runs either. Null is the gate open.
    // The fleet's node list as the last successful read saw it (review of #111): the boot apply runs before the
    // fleet starts, so it decides on that list, if it is no older than ten minutes; with none, it applies nothing
    // and the tick does it later.
    const nodesKeptFile = join(paths.state, "fleet-nodes.json");
    // A list older than the fleet view's own freshness bound is no word at all (review of #111 at 927859b).
    const keptNodes = (): FleetNode[] | null => {
      try {
        const v = JSON.parse(readFileSync(nodesKeptFile, "utf8")) as { at?: unknown; nodes?: unknown };
        if (typeof v.at !== "number" || systemClock.now() - v.at > FRESH_VIEW_MS) return null;
        return Array.isArray(v.nodes) ? v.nodes as FleetNode[] : null;
      } catch { return null; }
    };
    const keepingNodes = (real: FleetView, boot: boolean): Pick<FleetView, "nodes"> => ({
      nodes: async () => {
        let live: FleetNode[] | null = null;
        try { live = await real.nodes(); } catch { live = null; }
        if (live !== null) {
          writeFileSync(nodesKeptFile, `${JSON.stringify({ at: systemClock.now(), nodes: live })}\n`, { mode: 0o600 });
          return live;
        }
        const kept = boot ? keptNodes() : null;
        if (kept !== null) return kept;
        throw new Error("the fleet cannot be asked for its nodes");
      },
    });
    const skewGate = async (o: {
      running: string | null; target: string; targetProtocol: ProtocolRange | null; boot?: boolean;
    }): Promise<number | null> => {
      const target = parseVersion(o.target);
      const running = parseVersion(o.running ?? "");
      if (target === null || running === null || o.targetProtocol === null) {
        stateSink.write({ state: "waiting", version: o.running ?? o.target, reason: "the staged record cannot be read", at: systemClock.now() });
        io.err("the staged record cannot be read\n");
        return EXIT_TEMPFAIL;
      }
      // This machine's own node agent is updated in this very install: it never holds the control plane (6d's
      // two-machine run found it counted — no Release dropping a protocol could ever have applied here).
      const gate = await controlPlaneSkew({
        fleet: keepingNodes(await fleetOf(), o.boot === true), controlPlane: running, target, targetProtocol: o.targetProtocol,
        ownNode: ownOnlineNodeOf(nodeStatusPath),
      });
      if (gate.ok) return null;
      if (gate.error.reason === "fleet_unreachable" && o.boot === true) {
        stateSink.write({ state: "waiting", version: o.running ?? o.target, target: o.target, reason: "fleet_unreachable", at: systemClock.now() });
        io.out("the boot apply waits: the fleet has not told this machine its nodes yet, so the tick applies it once the fleet answers\n");
        return EXIT_OK;
      }
      if (gate.error.reason === "fleet_unreachable") {
        stateSink.write({ state: "waiting", version: o.running ?? o.target, target: o.target, reason: "fleet_unreachable", at: systemClock.now() });
        io.err("the fleet cannot be asked for its nodes, so the apply waits (RL11)\n");
        return EXIT_TEMPFAIL;
      }
      const nodes = gate.error.nodes.join(", ");
      stateSink.write({ state: "waiting", version: o.running ?? o.target, target: o.target, reason: `skew_blocked: ${nodes}`, at: systemClock.now() });
      const unknown = gate.error.unknown;
      io.err(unknown.length === 0
        ? `the target would drop an agent protocol these joined nodes still speak (RL11): ${nodes}\n`
        : `the target would drop an agent protocol these joined nodes still speak, or their protocol is unknown (RL11): ${nodes}; unknown: ${unknown.join(", ")} (revoke a node that will not come back)\n`);
      return EXIT_TEMPFAIL;
    };
    // The staged Manifest's protocol range, what skew asks about (RL11): re-read from the store's own copy, the
    // same bytes the apply's plan stands on — or null, when there is nothing staged to read.
    const protocolOf = (version: string): ProtocolRange | null => {
      const text = store.manifestOf(version);
      if (text === null) return null;
      try {
        const parsed = ManifestSchema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data.protocol : null;
      } catch { return null; }
    };
    const checkOnce = async (switches: { disableUpdates: boolean }, ask?: { to: Version }, o: { feedOnly?: boolean; feed?: ReleaseFeed } = {}): Promise<CheckOutcome> =>
      await new CheckService({
        feed: o.feed ?? deps.feed ?? new HttpsFeed({ base: feedBase }),
        artifacts: deps.artifacts ?? new HttpsArtifacts({ dir: paths.downloads }),
        verifier, installer, store, settings, clock: systemClock, platform, switches,
        fleet: await fleetOf(), state: stateSink,
      }).check(ask, o.feedOnly === true ? { feedOnly: true } : {});
    // The sentences a `--to` refusal prints: the channel and the pin are the settings', the running Version the
    // installer's. Absent when this run did not name a Version.
    const toLine = (to: Version | undefined): ToLine | undefined => {
      if (to === undefined) return undefined;
      const pin = settings.read().pin;
      return { to: true, channel: settings.read().channel, pin: pin === null ? null : formatVersion(pin), current: installer.layout().current ?? "", highestCommitted: store.highestCommitted() };
    };
    // RL11, before any check: a node never takes a Version above its control plane. A checkout, a disabled
    // updater and a control plane are not this gate's — the check answers the first two, and a control plane
    // has no control plane above it.
    const toGate = async (target: Version): Promise<number | null> => {
      if (env.MORNDO_DISABLE_UPDATES === "1") return null;
      const layout = installer.layout();
      if (layout.method !== "updater" || layout.current === null || parseVersion(layout.current) === null) return null;
      const m = await manager();
      const running = m === null ? [] : m.services();
      if (running.includes("hub") && running.includes("fleet")) return null;
      const word = await (await fleetOf()).view().catch(() => null);
      const gate = nodeToGate({ word, now: systemClock.now(), target });
      if (gate.ok) return null;
      io.err(`${gate.sentence}\n`);
      return EXIT_TEMPFAIL;
    };
    const applyWith = async (services: ServiceManager): Promise<ApplyService> => new ApplyService({
      services, probe,
      schemas: new SqliteSchemas({ paths: dbPaths }),
      backup: new SqliteBackup({ paths: dbPaths, backups: join(paths.state, "backups") }),
      revocations: new SqliteRevocations({ paths: dbPaths, backups: join(paths.state, "backups"), releases: paths.releases }),
      hold: new HoldFileWriter({ home, env }),
      applying: new ApplyingFileMarker({ state: paths.state }),
      installer, store, clock: systemClock, sleeper: realSleeper, alerts, verifier,
      state: stateSink, soakMinutes: soakOf(), mintAttempt,
      ...(deps.timing !== undefined ? { timing: deps.timing } : {}),
    });
    const printOutcome = (line: string, code: number): number => {
      if (code === EXIT_OK) io.out(`${line}\n`);
      else io.err(`${line}\n`);
      return code;
    };

    if (parsed.cmd === "check") {
      if (parsed.to !== undefined) {
        const held = await toGate(parsed.to);
        if (held !== null) return held;
      }
      const outcome = await checkOnce(
        { disableUpdates: env.MORNDO_DISABLE_UPDATES === "1" },
        parsed.to === undefined ? undefined : { to: parsed.to },
      );
      const code = checkCode(outcome, parsed.to !== undefined);
      if (json) io.out(`${JSON.stringify({ outcome })}\n`);            // the hub and the tests read this shape
      else return printOutcome(checkLine(outcome, toLine(parsed.to)), code);
      return code;
    }

    if (parsed.cmd === "status") {
      // Even an install that is not ours is an answer, never a failure: the reader asked what this machine believes.
      const s = readStatus({ installer, store, settings });
      if (json) {
        io.out(`${JSON.stringify(UpdateStatusSchema.parse(s))}\n`);
        return EXIT_OK;
      }
      // The owner-path line is text only, and only where the hub runs: a node has no owner path to judge.
      const m = await manager();
      const runsHub = m !== null && m.services().includes("hub");
      const ownerOrigin = runsHub ? (env.MORNDO_ORIGIN === undefined ? "unset" : "set") : null;
      io.out(`${formatStatus(s, { ownerOrigin })}\n`);
      return EXIT_OK;
    }

    if (parsed.cmd === "doctor") {
      // The install's own word re-checked against what was signed (§8.1). A checkout ends the questions at
      // its sentence (RL14); anything else is a finding, and the exit code separates fixable (1) from not ours (78).
      const report = await doctor({ installer, store, clock: systemClock });
      if (json) io.out(`${JSON.stringify(report)}\n`);
      else {
        for (const finding of report.findings) io.err(`${finding.area}: ${finding.detail}\n`);
        if (report.ok) io.out("ok: the install checks out\n");
        io.out(`free space: ${report.freeBytes} bytes\n`);
      }
      if (report.findings.some(finding => finding.area === "install")) return EXIT_CONFIG;
      return report.ok ? EXIT_OK : EXIT_FAILED;
    }

    // Everything below moves the machine, or asks its manager to; every path needs one.
    const services = await manager();
    const needManager = (): ServiceManager | null => {
      if (services === null) io.err(`${NO_MANAGER}\n`);
      return services;
    };
    const applyNowFile = join(paths.state, "apply-now");
    // The attempt id the apply unit runs under (§5.4): a unit instance carries only its Version, so the starter
    // writes the id here first (the node agent: the fleet's; morndo update --yes: a fresh one), and the unit reads
    // it once (its template's EnvironmentFile) and removes it.
    const applyEnvFile = join(paths.state, "apply.env");
    // The principal's confirmed rollback (§11.4), for the apply unit to find: written by `update --rollback` once the
    // word is typed (or --yes), naming the Version it leaves, and consumed by the unit. The unit's own command line is
    // one anyone can type; without this record it runs no rollback (review of 2026-10-22).
    const rollbackConfirmedFile = join(paths.state, "rollback-confirmed");
    // The apply unit's own answer (§8.1, §8.4): its instance, when it ended, its exit and the lines it said. systemd
    // forgets an inactive unit's exit status once it unloads the unit, so the command that started the unit reads
    // this instead; an apply that left no record (deferred, refused, busy) still answers in its own words.
    const applyResultFile = join(paths.state, "apply-result.json");
    // What a run of the apply unit started at `startedAt` answered: the record that run began, as §8.1 says, or the
    // unit's own result; a start that failed with neither is a unit that never ran.
    const answerOfUnit = (instance: string, startedAt: number, startError: string | null): number => {
      const last = store.recentUpdates(1)[0] ?? null;
      if (last !== null && last.startedAt >= startedAt) return recordExit(last, io);
      type Result = { instance?: unknown; at?: unknown; code?: unknown; lines?: unknown };
      const readResult = (): Result | null => {
        try { return JSON.parse(readFileSync(applyResultFile, "utf8")) as Result; } catch { return null; }
      };
      const result = readResult();
      if (result !== null && result.instance === instance && typeof result.at === "number" && result.at >= startedAt
        && typeof result.code === "number" && Array.isArray(result.lines)) {
        for (const line of result.lines) if (typeof line === "string") printOutcome(line, result.code);
        return result.code;
      }
      if (startError !== null) {
        io.err(`the apply unit did not run: ${startError}\n`);
        return EXIT_TEMPFAIL;
      }
      io.err("the apply unit recorded nothing; try again\n");
      return EXIT_TEMPFAIL;
    };
    const ROLLBACK_CONFIRMED_FOR_MS = 10 * 60_000;

    if (parsed.cmd === "update") {
      // §8.1's update: the check first, printed exactly as --check prints it; then the ask, then the apply unit.
      // `--to` is the same walk of the Version it names. A node above its control plane never reaches the check.
      if (parsed.to !== undefined) {
        const held = await toGate(parsed.to);
        if (held !== null) return held;
      }
      const outcome = await checkOnce(
        { disableUpdates: env.MORNDO_DISABLE_UPDATES === "1" },
        parsed.to === undefined ? undefined : { to: parsed.to },
      );
      const line = checkLine(outcome, toLine(parsed.to));
      const code = checkCode(outcome, parsed.to !== undefined);
      if (code !== EXIT_OK) return printOutcome(line, code);           // refused, unreachable, not ours: as the check answered
      if (json) io.out(`${JSON.stringify({ outcome })}\n`);
      else io.out(`${line}\n`);
      let staged = store.staged();
      // Already running, or a skip that exits 0: nothing of some other Version starts.
      if (parsed.to !== undefined && outcome.kind !== "staged") return EXIT_OK;
      // The pressed Version (R3): what stands staged must be the one the screen named, or nothing starts.
      // The check above may have staged a newer Release between the screen's look and the press.
      if (parsed.staged !== undefined && (staged === null || staged.version !== parsed.staged)) {
        io.err(`what stands staged is ${staged?.version ?? "nothing"}, not ${parsed.staged}: nothing was started (--staged names the Version the screen pressed)\n`);
        return EXIT_TEMPFAIL;
      }
      if (staged === null || !installer.has(staged.version)) return EXIT_OK;   // up to date: nothing to apply
      const m = needManager();
      if (m === null) return EXIT_CONFIG;
      if (!parsed.yes) {
        if (io.tty !== true) {
          io.err("morndo update needs --yes, or a terminal to ask in (the services restart for a few seconds; lanes keep running)\n");
          return EXIT_USAGE;
        }
        const ask = io.ask ?? askOnTerminal;
        const answer = await ask("Apply now? Morndo's services restart for a few seconds; lanes keep running. [y/N] ");
        if (answer !== "y" && answer !== "yes") {
          io.out("Not applying. The staged Version stays; morndo update --yes applies it, or the tick's window does.\n");
          return EXIT_OK;
        }
      }
      // Retiring a newer staged record is part of applying the named Version: it waits until the principal has
      // confirmed (`--yes`, or yes at the prompt). A `--check`, and a no above, leave that record where it stood.
      // What stands staged must then be the named one, or nothing starts.
      if (parsed.to !== undefined && outcome.kind === "staged") {
        store.retireStagedAbove(outcome.version);
        staged = store.staged();
        if (staged === null || staged.version !== outcome.version) {
          io.err(`what stands staged is ${staged?.version ?? "nothing"}, not ${outcome.version}: nothing was started (--staged names the Version the screen pressed)\n`);
          return EXIT_TEMPFAIL;
        }
      }
      // The attempt the unit runs under (§5.4): the control plane mints its own; a node takes the one the fleet
      // offered it for this Version, and without such an offer applies nothing — a rollback under an id the fleet
      // never issued would halt nothing.
      const running = m.services();
      let attempt = mintAttempt();
      if (!running.includes("hub") || !running.includes("fleet")) {
        const offer = (await (await fleetOf()).view().catch(() => null))?.offer ?? null;
        if (offer === null || offer.version !== staged.version) {
          io.err(`the fleet has not offered ${staged.version} to this node, so it applies nothing yet; the control plane's Updates page or its rollout moves it\n`);
          return EXIT_TEMPFAIL;
        }
        attempt = offer.attempt;
      }
      // §6.2's `--now`: a file the apply unit reads, because arguments cannot cross a unit boundary.
      if (parsed.now) writeFileSync(applyNowFile, "");
      writeFileSync(applyEnvFile, `MORNDO_ATTEMPT=${attempt}\n`, { mode: 0o600 });
      // PR 6c's --detach — the hub's one command: start the unit, answer at once. The exit is the start's, not
      // the walk's; the unit writes its own record, and a later --status reads it (§8.1).
      if (parsed.detach) {
        try {
          await m.runApply(staged.version, { wait: false });
        } catch (error) {
          io.err(`the apply unit did not start: ${error instanceof Error ? error.message : String(error)}\n`);
          return EXIT_TEMPFAIL;
        }
        io.out(`Started the apply unit for ${staged.version}; it walks the steps from here — morndo update --status tells how it ends.\n`);
        return EXIT_OK;
      }
      const startedAt = Date.now();
      let startError: string | null = null;
      // A unit whose apply ended in one of §8.4's own exits counts as a success to systemd (the unit's
      // SuccessExitStatus); a failed start is a crash, or a unit that never ran — the answer below tells which.
      try { await m.runApply(staged.version); }
      catch (error) { startError = error instanceof Error ? error.message : String(error); }
      rmSync(applyNowFile, { force: true });                           // a unit that never read it leaves none behind
      return answerOfUnit(staged.version, startedAt, startError);
    }

    if (parsed.cmd === "apply-unit") {
      // Every line the unit says goes into its result too, for the command that started it (applyResultFile).
      const lines: string[] = [];
      const said = { out: (t: string) => { lines.push(t.replace(/\n$/, "")); io.out(t); }, err: (t: string) => { lines.push(t.replace(/\n$/, "")); io.err(t); } };
      const code = await applyUnit(said);
      const temp = `${applyResultFile}.new`;
      writeFileSync(temp, `${JSON.stringify({ instance: parsed.version, at: Date.now(), code, lines })}\n`, { mode: 0o600 });
      renameSync(temp, applyResultFile);
      return code;
    }

    async function applyUnit(io: { out(t: string): void; err(t: string): void }): Promise<number> {
      if (parsed.cmd !== "apply-unit") return EXIT_SOFTWARE;
      const printOutcome = (line: string, code: number): number => {
        if (code === EXIT_OK) io.out(`${line}\n`);
        else io.err(`${line}\n`);
        return code;
      };
      // What the apply unit runs (§6.2): one apply, of the Version the unit was named for, in its own process.
      // The instance named "rollback" runs the principal's own rollback (§8.1) — the one `morndo update
      // --rollback` starts, so that no service the walk stops is its parent.
      const m = needManager();
      if (m === null) return EXIT_CONFIG;
      const goBack = "Going back to an older Version is morndo update --rollback: it says what a restore drops and asks first.";
      const running = installer.layout().current;
      // apply.env is read once, by the unit that was started for it: gone now, a later start cannot reuse its id.
      rmSync(applyEnvFile, { force: true });
      if (parsed.version === "rollback") {
        // Only the rollback `update --rollback` confirmed, for the Version still running, and lately.
        let confirmed: { from?: unknown; at?: unknown } | null = null;
        try { confirmed = JSON.parse(readFileSync(rollbackConfirmedFile, "utf8")) as { from?: unknown; at?: unknown }; }
        catch { confirmed = null; }
        rmSync(rollbackConfirmedFile, { force: true });
        if (confirmed === null || confirmed.from !== running || typeof confirmed.at !== "number"
          || Date.now() - confirmed.at > ROLLBACK_CONFIRMED_FOR_MS) {
          io.err(`${goBack}\n`);
          return EXIT_USAGE;
        }
        const outcome = await (await applyWith(m)).rollback();
        return printOutcome(applyLine(outcome), applyCode(outcome));
      }
      // An apply moves up only (RL2): a Version at or below the running one is never an apply's target.
      const asked = parseVersion(parsed.version);
      const runningVersion = running === null ? null : parseVersion(running);
      if (asked !== null && runningVersion !== null && compareVersions(asked, runningVersion) <= 0) {
        io.err(`${goBack}\n`);
        return EXIT_USAGE;
      }
      // §5.4's attempt id, handed to the unit by whoever asked for it: the agent's update.apply writes it into the
      // environment file the unit's template reads; an empty value is absence — systemd's own expansion of an
      // unset variable. An id of no shape is a usage error before anything runs; a node refuses an apply without
      // one outright, because its rollback would halt nothing.
      const attempt = parsed.attempt === undefined || parsed.attempt === "" ? null : parsed.attempt;
      if (attempt === null && parsed.attempt !== undefined) {
        io.err(`no attempt id reached this apply: whoever starts the apply unit writes MORNDO_ATTEMPT into ${applyEnvFile} first ` +
          "(the node agent for the fleet's update.apply, morndo update --yes on the control plane); nothing ran\n");
        return EXIT_USAGE;
      }
      if (attempt !== null && !ATTEMPT_ID.test(attempt)) {
        io.err("--attempt wants an id the fleet issued (16 bytes, base64url)\n");
        return EXIT_USAGE;
      }
      const staged = store.staged();
      if (staged === null) { io.err("nothing stands staged to apply\n"); return EXIT_TEMPFAIL; }
      if (staged.version !== parsed.version) {
        io.err(`the staged version changed: ${staged.version} is staged, not ${parsed.version}\n`);
        return EXIT_TEMPFAIL;
      }
      // On a node, even the principal's explicit "Update now" keeps RL11 and RL12 (§8.3): a fresh view, the
      // control plane at or above the target, and a Rollout not halted — here or in the fleet, all under the
      // attempt id the fleet issued this apply. The soak and the jitter, the fleet's own pacing, are the parts
      // "now" skips. The control plane asks its own skew gate instead (§7) and mints its own id.
      const runningServices = m.services();
      if (!runningServices.includes("hub") || !runningServices.includes("fleet")) {
        if (attempt === null) {
          io.err("a node applies only under an attempt id the fleet issued (update.apply carries it; §5.4)\n");
          return EXIT_USAGE;
        }
        const targetProtocol = protocolOf(parsed.version);
        const word = await (await fleetOf()).view().catch(() => null);
        const gate = targetProtocol === null ? null
          : applyUnitGate({ word, now: systemClock.now(), target: asked!, targetProtocol, localHalts: store.halts() });
        if (gate === null) { io.err("the staged record cannot be read\n"); return EXIT_TEMPFAIL; }
        if (!gate.ok) { io.err(`${deferSentence(gate.error.reason)}\n`); return EXIT_TEMPFAIL; }
        const now = existsSync(applyNowFile);
        if (now) rmSync(applyNowFile, { force: true });
        const outcome = await (await applyWith(m)).apply({ now, attempt });
        return printOutcome(applyLine(outcome), applyCode(outcome));
      }
      const held = await skewGate({ running, target: parsed.version, targetProtocol: protocolOf(parsed.version) });
      if (held !== null) return held;
      const now = existsSync(applyNowFile);
      if (now) rmSync(applyNowFile, { force: true });
      const outcome = await (await applyWith(m)).apply({ now, ...(attempt === null ? {} : { attempt }) });
      return printOutcome(applyLine(outcome), applyCode(outcome));
    }

    if (parsed.cmd === "rollback") {
      // §8.1's rollback: the principal's own Update against the commit that put the running Version here.
      // §11.4's ask comes first, on a preview the store and the links answer alone — no service is touched
      // before the word is typed — because a restore drops every write since the Backup. Then §5's own unit:
      // the walk stops services, and the hub runs this very command for the web app (PR 6), so a rollback in
      // this process could stop its own parent.
      const layout = installer.layout();
      if (layout.method !== "updater" || layout.current === null || parseVersion(layout.current) === null) {
        io.err(`${CHECKOUT_SENTENCE}\n`);
        return EXIT_CONFIG;
      }
      if (layout.previous === null) {
        io.err("No previous Version to roll back to.\n");
        return EXIT_CONFIG;
      }
      // The commit that owns the Backups a restore would use (§6.5): the same owner the walk itself finds.
      const owner = store.recentUpdates(200)
        .find(row => row.state === "committed" && formatVersion(row.target) === layout.current) ?? null;
      const restores = rollbackRestores(planOf(owner?.migrations ?? null));
      // Each Backup's own moment: the file's mtime where there is one, the update's start where there is not.
      const dropped = restores.map(db => {
        const file = join(paths.state, "backups", owner?.id ?? "", `${db}.db`);
        let at = owner?.startedAt ?? systemClock.now();
        try { at = statSync(file).mtimeMs; } catch { /* no file: the update's own start stands in for it */ }
        return { db, at };
      });
      // The hub's read-only look (review round 1): the same preview the human text prints, as one JSON object the
      // hub parses — each Backup's own moment as ISO text — with nothing written and nothing started.
      if (parsed.preview) {
        io.out(`${JSON.stringify({
          from: layout.current, to: layout.previous,
          restores: dropped.map(({ db, at }) => ({ db, at: new Date(at).toISOString() })),
        })}\n`);
        return EXIT_OK;
      }
      io.out(restores.length === 0
        ? `Back to ${layout.previous} from ${layout.current}; no database is restored.\n`
        : `Back to ${layout.previous} from ${layout.current}.\n`);
      for (const { db, at } of dropped) {
        io.out(`The ${db} database goes back to its backup from ${stampOf(at)} (${ageWords(systemClock.now() - at)} of writes since are dropped).\n`);
      }
      // §11.4's word under --yes (review round 1): --yes answers the [y/N], never the typed word. A restore that
      // drops writes refuses --yes alone, naming what it would drop and the way on — the hub's own command, which
      // always runs --yes, gets its word from --typed.
      if (parsed.yes && restores.length > 0 && parsed.typed === undefined) {
        const names = dropped.map(({ db, at }) => `the ${db} database's backup from ${stampOf(at)} (${ageWords(systemClock.now() - at)} of writes dropped)`);
        io.err(`--yes alone cannot go on: rolling back restores ${names.join(", ")}; add --typed rollback, the word the terminal asks for.\n`);
        return EXIT_USAGE;
      }
      if (!parsed.yes) {
        if (io.tty !== true) {
          io.err(restores.length === 0
            ? "morndo update --rollback needs --yes, or a terminal to ask in (the services restart for a few seconds; lanes keep running)\n"
            : "morndo update --rollback would restore a database's backup and drop the writes since: it needs --yes, or a terminal to type the word in\n");
          return EXIT_USAGE;
        }
        const ask = io.ask ?? askOnTerminal;
        const answer = restores.length === 0
          ? await ask(`Roll back to ${layout.previous}? Morndo's services restart for a few seconds; lanes keep running. [y/N] `)
          : await ask("Type rollback to go on: ");
        // A restore needs the word itself (§11.4): "y" is not it, exactly because the writes dropped are real.
        const goOn = restores.length === 0 ? answer === "y" || answer === "yes" : answer === "rollback";
        if (!goOn) {
          io.out("Not rolled back.\n");
          return EXIT_OK;
        }
      }
      const m = needManager();
      if (m === null) return EXIT_CONFIG;
      const startedAt = Date.now();
      writeFileSync(rollbackConfirmedFile, `${JSON.stringify({ from: layout.current, at: startedAt })}\n`, { mode: 0o600 });
      // PR 6c's --detach, the hub's rollback command: start §5's morndo-update-apply@rollback.service instance
      // and answer at once; the unit walks the machine back and records its own end.
      if (parsed.detach) {
        try {
          await m.runApply("rollback", { wait: false });
        } catch (error) {
          io.err(`the apply unit did not start: ${error instanceof Error ? error.message : String(error)}\n`);
          return EXIT_TEMPFAIL;
        }
        io.out("Started the rollback unit; it walks the machine back from here — morndo update --status tells how it ends.\n");
        return EXIT_OK;
      }
      let startError: string | null = null;
      try {
        await m.runApply("rollback");            // §5: the morndo-update-apply@rollback.service instance
      } catch (error) {
        // The confirmation was for this run of the unit only: a unit that failed must not leave it valid for a
        // later start of the rollback instance that no one confirmed.
        rmSync(rollbackConfirmedFile, { force: true });
        startError = error instanceof Error ? error.message : String(error);
      }
      return answerOfUnit("rollback", startedAt, startError);
    }

    if (parsed.cmd === "tick") {
      // The timer's own command (§6.1, §8.3): the switches and the mode stop it before anything is fetched; then
      // the check — the feed at most every six hours (§7) — and, in mode apply, the automatic apply inside its
      // window, behind the node's own gate (§6.7) or the control plane's skew gate (§7, RL11). The control
      // plane's word to the fleet is its state file (§4.5): the fleet reads it itself, so the tick tells it
      // nothing — a commit or a halt the fleet missed is a word it still owes itself, on its own next read.
      if (env.MORNDO_DISABLE_UPDATES === "1" || env.MORNDO_DISABLE_AUTOUPDATE === "1") return EXIT_OK;
      const read = settings.read();
      if (read.mode === "off") return EXIT_OK;
      const m = await manager();
      const running = m === null ? [] : m.services();
      const controlPlane = running.includes("hub") && running.includes("fleet");
      // The feed itself at most every six hours (§7): between asks the tick still follows the Rollout, so a
      // control plane that committed five minutes ago is not waited out. A check that never carried the feed's
      // word does not count — a fetch that failed an hour ago is retried now, not in six hours.
      const lastFeed = store.lastFeedCheck();
      let code = EXIT_OK;
      if (lastFeed === null || systemClock.now() - lastFeed.at >= FEED_CHECK_MS) {
        const outcome = await checkOnce({ disableUpdates: false });
        printOutcome(checkLine(outcome), checkCode(outcome));
        code = checkCode(outcome);
      }
      if (read.mode !== "apply") return code;
      const staged = store.staged();
      if (staged === null || !installer.has(staged.version)) return code;
      if (m === null) { io.err(`${NO_MANAGER}\n`); return EXIT_CONFIG; }
      let attempt: string | undefined;
      if (!controlPlane) {
        // The node's gate (§6.7, §7, RL11, RL12, §5.4): a fresh fleet view, the control plane at or above the
        // target, the fleet's Rollout of this very Version — committed, past its soak, past this node's own drawn
        // delay, and offered to this node, whose attempt id the Update runs under — and not halted anywhere.
        // Every refusal is a deferral (exit 75), said again next tick.
        const word = await (await fleetOf()).view().catch(() => null);
        const target = parseVersion(staged.version);
        const targetProtocol = protocolOf(staged.version);
        const current = installer.layout().current;
        if (target === null || targetProtocol === null) {
          stateSink.write({ state: "waiting", version: current ?? staged.version, reason: "the staged record cannot be read", at: systemClock.now() });
          io.err("the staged record cannot be read; it is tried again next tick\n");
          return EXIT_TEMPFAIL;
        }
        const gate = nodeGate({
          word, now: systemClock.now(), node: machineName, target, targetProtocol, store,
          random: deps.random ?? Math.random,
        });
        if (!gate.ok) {
          stateSink.write({ state: "waiting", version: current ?? staged.version, reason: gate.error.reason, at: systemClock.now() });
          io.err(`${deferSentence(gate.error.reason)}; tried again next tick\n`);
          return EXIT_TEMPFAIL;
        }
        attempt = gate.attempt;
      } else {
        // The control plane's own gate before an apply (§7, RL11): no Release that drops an agent protocol a
        // joined node still speaks, and no apply at all without the fleet's own node list.
        const held = await skewGate({
          running: installer.layout().current, target: staged.version, targetProtocol: protocolOf(staged.version),
        });
        if (held !== null) return held;
      }
      // The automatic walk (§6.3, §8.3): safeToApply with automatic true — the window is the settings' own, and
      // attending is always "nobody is" until the hub reports an attending signal (PR 6). The attempt is the
      // offer's on a node; the control plane mints its own inside the walk.
      const applied = await (await applyWith(m)).apply({
        now: false, automatic: true, window: read.window, ...(attempt === undefined ? {} : { attempt }),
      });
      return printOutcome(applyLine(applied), applyCode(applied));
    }

    if (parsed.cmd === "boot") {
      // §6.7's boot apply: only when something stands staged, updates are on, no pin holds the machine, and this
      // machine is its own control plane (it runs the hub and the fleet). Then the feed is fetched once more —
      // a Version withdrawn or turned bad here while the machine was down never starts — and the walk that
      // follows stops nothing, swaps, and leaves the judging to the recovery unit. A feed that cannot be reached
      // at boot leaves the old Version running; the tick tries again once the network is back.
      if (env.MORNDO_DISABLE_UPDATES === "1" || env.MORNDO_DISABLE_AUTOUPDATE === "1") return EXIT_OK;
      const staged = store.staged();
      if (staged === null || !installer.has(staged.version)) return EXIT_OK;
      const read = settings.read();
      if (read.mode === "off" || read.pin !== null) return EXIT_OK;
      const m = needManager();
      if (m === null) return EXIT_OK;                                   // no manager here: the tick decides later
      const running = m.services();
      if (!running.includes("hub") || !running.includes("fleet")) return EXIT_OK;   // a node, not a control plane
      const outcome = await checkOnce({ disableUpdates: false });
      if (outcome.kind !== "staged") {
        io.out(`the boot apply does not run: ${checkLine(outcome)}\n`);
        return EXIT_OK;
      }
      // The control plane's own gate before an apply (§7, RL11), here too: a Release that drops a protocol a
      // joined node still speaks never starts at boot either, and the hold is named for the waiting record.
      const stagedNow = store.staged();
      if (stagedNow !== null) {
        const held = await skewGate({
          running: installer.layout().current, target: stagedNow.version, targetProtocol: protocolOf(stagedNow.version), boot: true,
        });
        if (held !== null) return held;
      }
      const applied = await (await applyWith(m)).apply({ now: false, boot: true });
      return printOutcome(applyLine(applied), applyCode(applied));
    }

    if (parsed.cmd === "recover") {
      // The recovery unit's own command (§6.6): finish whatever an open record names.
      const m = needManager();
      if (m === null) return EXIT_CONFIG;
      const outcome = await new RecoveryService({
        services: m, probe,
        backup: new SqliteBackup({ paths: dbPaths, backups: join(paths.state, "backups") }),
        revocations: new SqliteRevocations({ paths: dbPaths, backups: join(paths.state, "backups"), releases: paths.releases }),
        hold: new HoldFileWriter({ home, env }),
        applying: new ApplyingFileMarker({ state: paths.state }),
        installer, store, clock: systemClock, sleeper: realSleeper, alerts,
        state: stateSink, soakMinutes: soakOf(),
        ...(deps.timing !== undefined ? { timing: deps.timing } : {}),
      }).recover();
      return printOutcome(recoverLine(outcome), recoverCode(outcome));
    }

    // ---- `morndo install` (§10.3): the unpacked archive this program runs from, installed by role.
    const tree = deps.tree ?? runningTree();
    if (tree === null || !existsSync(join(tree, "app", "VERSION"))) {
      io.err("this program does not run from an unpacked release tree (no app/VERSION above it); nothing was installed\n");
      return EXIT_DATAERR;
    }
    const versionText = readFileSync(join(tree, "app", "VERSION"), "utf8").trim();
    const version = parseVersion(versionText);
    if (version === null) {
      io.err(`the tree's app/VERSION is ${JSON.stringify(versionText)}, not a Version; nothing was installed\n`);
      return EXIT_DATAERR;
    }
    // The tree against its own files.json: what install.sh verified on the way in is verified again here, by the
    // program that is about to copy it.
    // The list is read once here and its digest pinned: verification checks the list is that one, and the copy
    // checks it again and hashes every file as it writes it, so what was verified is what is installed.
    const listDigest = installer.listDigestAt(tree);              // null when unreadable: verifyTreeAt says so
    const findings = await installer.verifyTreeAt(tree, listDigest);
    if (findings.length > 0) {
      io.err(`the tree does not check out against its own files.json (${findings[0]!.path}: ${findings[0]!.problem}); nothing was installed\n`);
      return EXIT_DATAERR;
    }
    // The trust anchor the tree ships (§10.1): root signs the key set, once, and the store starts from it.
    // Read through the verified list, like the files the copy hashes: the bytes parsed here are the bytes that were checked.
    let keyDoc: unknown;
    try { keyDoc = JSON.parse(installer.readListed(tree, listDigest!, "trust/keys.json").toString("utf8")); }
    catch {
      io.err("the tree ships no readable trust/keys.json; nothing was installed\n");
      return EXIT_DATAERR;
    }
    const keySet = KeySetSchema.safeParse(keyDoc);
    if (!keySet.success) {
      io.err("the tree's trust/keys.json is not a key set; nothing was installed\n");
      return EXIT_DATAERR;
    }
    if (installer.layout().current !== null) {
      io.err("already installed: use morndo update\n");
      return EXIT_CONFIG;
    }
    const m = needManager();
    if (m === null) return EXIT_CONFIG;
    // Linger before anything starts (§5): without it the services would die with the login session that
    // installed them. The command is printed for the person to run; nothing has been written yet.
    if (!(await m.lingerEnabled())) {
      io.err(`the user's services would stop at logout; enable lingering first:\n  loginctl enable-linger\n`);
      return EXIT_CONFIG;
    }
    // The launcher links, checked before anything is written: a slot in ~/.local/bin that is not a link is
    // someone's real file, and this install never touches it. lstat, not existsSync — a broken link is a
    // leftover this install replaces, and existsSync would not even see it.
    const binDir = join(home, ".local/bin");
    mkdirSync(binDir, { recursive: true });
    const launchers = readdirSync(join(tree, "bin"));
    for (const name of launchers) {
      const link = join(binDir, name);
      let st: ReturnType<typeof lstatSync> | null = null;
      try { st = lstatSync(link); } catch { st = null; }
      if (st !== null && !st.isSymbolicLink()) {
        io.err(`${link} exists and is not a link; remove it first; nothing was installed\n`);
        return EXIT_CONFIG;
      }
    }
    // The unit files, checked before anything is written too: a unit of one of our names that Morndo did not
    // write is someone's own, and only --force replaces it — kept beside it as <name>.before-morndo.
    const roleServices: readonly UpdateService[] = parsed.role === "control-plane" ? ["hub", "fleet", "node"] : ["node"];
    const foreign = await m.foreignUnits(versionText, { services: roleServices }, { tree });   // not installed yet: the tree's own units
    if (foreign.length > 0 && !parsed.force) {
      io.err(`${foreign.join(", ")}: not written by Morndo; move ${foreign.length === 1 ? "it" : "them"} away, or run with --force to keep ${foreign.length === 1 ? "it" : "them"} as <name>.before-morndo; nothing was installed\n`);
      return EXIT_CONFIG;
    }
    try { installer.installTree({ tree, version: versionText, at: systemClock.now(), filesSha256: listDigest! }); }
    catch (error) {
      io.err(`${error instanceof Error ? error.message : String(error)}; nothing was installed\n`);
      return EXIT_DATAERR;
    }
    installer.swap({ current: versionText, previous: null });
    installer.setGood(versionText);
    // The store's first words: this Version committed, the tree's key set trusted. The channel goes into the
    // settings only when the file is absent — a user's config is never rewritten (§11.6) — through the same
    // locked write a settings command uses.
    store.recordCommitted(versionText, systemClock.now(), null);
    store.saveTrust({ keySet: keySet.data, highestFeedSeq: { stable: 0, latest: 0 } });
    if (!existsSync(paths.config)) {
      try { settings.change({ kind: "channel", channel: parsed.channel }); }
      catch (error) {
        const code = settingsWriteCode(error, io);
        if (code === null) throw error;
        return code;
      }
    }
    // The launchers the tree ships, linked into ~/.local/bin through `current`, so an update moves them too.
    for (const name of launchers) {
      const link = join(binDir, name);
      rmSync(link, { force: true });                                    // a leftover link from a removed install; the preflight kept real files out of this
      symlinkSync(`../share/morndo-releases/current/bin/${name}`, link);
    }
    // The units for the role (§5): the update units always, the role's services as the role runs them. A node
    // that has not joined yet does not start — it has nothing to run until the principal joins it.
    for (const keep of await m.renderUnits(versionText, { services: roleServices }, { replaceForeign: parsed.force })) {
      io.out(`kept the unit Morndo replaced as ${keep}\n`);
    }
    const UPDATE_UNITS = ["morndo-update.timer", "morndo-update-boot.service", "morndo-update-recover.service", "morndo-update-recover.timer"] as const;
    const joined = existsSync(join(home, ".config/morndo-node/config.json"));
    const startable: readonly UpdateService[] = parsed.role === "control-plane"
      ? ["hub", "fleet", ...(joined ? (["node"] as const) : [])]
      : joined ? (["node"] as const) : [];
    await m.enable([...UPDATE_UNITS, ...startable.map(s => `morndo-${s}.service`)]);
    io.out(`Morndo ${versionText} installed (${parsed.role}, channel ${parsed.channel}).\n`);
    // §10.3's last step: the Feed read and verified, so its word is on record from the first minute. Only that: no
    // offer is judged, nothing is staged and no artifact is fetched (the timer's check does that, minutes later), and
    // the whole check gets one budget (FIRST_CHECK_MS), each fetch what is left of it, so the install does not hang on
    // a host that does not answer. Best effort — an
    // unreachable or refusing feed is said and recorded by the check itself and the install stands; the doctor then
    // reports the feed as it is, never as verified.
    // The launchers are linked into binDir, but a login shell only puts ~/.local/bin on PATH when the folder already
    // existed at login (Ubuntu's ~/.profile), so a first install can end in "command not found". Said last, once,
    // and never an exit code of its own.
    const pathNote = (): void => {
      const here = (env.PATH ?? "").split(":").some(entry => entry !== "" && resolve(entry) === binDir);
      if (here) return;
      io.err(`${binDir} is not on PATH, so the morndo commands are not found yet: start a new login (the shell adds it when the folder exists), or add this line to ~/.profile and open a new shell:\n  export PATH="$HOME/.local/bin:$PATH"\n`);
    };
    const firstCheck = async (): Promise<void> => {
      try {
        const outcome = await checkOnce({ disableUpdates: env.MORNDO_DISABLE_UPDATES === "1" }, undefined, {
          feedOnly: true,
          feed: new DeadlineFeed({
            until: systemClock.now() + (deps.firstCheckMs ?? FIRST_CHECK_MS), now: () => systemClock.now(),
            open: left => deps.feed ?? new HttpsFeed({ base: feedBase, timeoutMs: Math.min(8_000, left), deadlineMs: Math.min(15_000, left) }),
          }),
        });
        printOutcome(checkLine(outcome), checkCode(outcome));
      } catch (error) {
        io.err(`the first check failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    };
    if (!joined) {
      io.out("the agent waits to join: morndo-node join <code>, then systemctl --user start morndo-node\n");
      await firstCheck();
      pathNote();
      return EXIT_OK;
    }
    // §6.4's health deadline is the install's own patience: each service gets the whole of it to answer.
    for (const s of startable) {
      const deadline = systemClock.now() + 90_000;
      for (;;) {
        const report = await probe.health(s);
        if (report !== null && report.version === versionText) { io.out(`${s}: healthy at ${versionText}\n`); break; }
        if (systemClock.now() >= deadline) { io.out(`${s}: no answer within 90 s\n`); break; }
        await realSleeper.sleep(1_000);
      }
    }
    await firstCheck();
    pathNote();
    return EXIT_OK;
  } finally {
    store.close();
  }
}

// The apply unit's record, to one line and one exit (§8.1, §8.4): committed 0; rolled back 1; a rollback that
// failed 70; anything else — an attempt that never finished, was abandoned, or was deferred — 75. A
// rollback-kind record's target is where the machine went back to, not the Version it left (§6.5's two records).
function recordExit(row: UpdateHistory, io: { out(s: string): void; err(s: string): void }): number {
  const target = formatVersion(row.target);
  if (row.state === "committed") { io.out(`Committed ${target}.\n`); return EXIT_OK; }
  if (row.state === "rolled_back") {
    if (row.kind === "rollback") { io.out(`Rolled back to ${target}.\n`); return EXIT_FAILED; }
    io.out(`Rolled back from ${target}: the previous Version runs.\n`);
    return EXIT_FAILED;
  }
  if (row.state === "rollback_failed") { io.err(`The rollback failed at ${target}; this machine needs a person.\n`); return EXIT_SOFTWARE; }
  io.err(`The apply did not finish (${row.state}); try again.\n`);
  return EXIT_TEMPFAIL;
}

// The prompt on a real terminal: one line read from stdin, lowercased and trimmed, as [y/N] asks.
const askOnTerminal = async (prompt: string): Promise<string> => {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(prompt)).trim().toLowerCase(); }
  finally { rl.close(); }
};

// §10.3: the tree this program runs from — the directory above the entry that ships app/VERSION, following the
// real path, so a launcher's link (bin/morndo-update → ../app/…) lands in the unpacked archive it names.
function runningTree(): string | null {
  const start = process.argv[1];
  if (start === undefined) return null;
  let dir: string;
  try { dir = dirname(realpathSync(start)); } catch { return null; }
  for (let up = 0; up < 8 && dir !== "/"; up++) {
    if (existsSync(join(dir, "app", "VERSION"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
