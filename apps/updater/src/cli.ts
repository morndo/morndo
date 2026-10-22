// morndo-update's composition root (design §4.6, §4.7, §6.1, §6.7, §8.1, §8.3, §8.4, §10.3): the one place the
// application's services meet real adapters — the paths from HOME, the HTTPS feed and artifacts, the
// versioned-directories installer, the SQLite store, the settings file, the system clock, the systemd or launchd
// manager this machine runs. The command line is parsed here and nowhere else; the exit codes are sysexits.h's,
// as in the rest of Morndo. The applies run as the machine's own units (§6.2): `morndo update` starts the apply
// unit and reports its record; the tick, the boot and the recovery units run the same services themselves.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { compareVersions, formatVersion, parseVersion, rollbackRestores, type Channel, type Platform, type UpdateService } from "@morndo/domain";
import { KeySetSchema, UpdateStatusSchema } from "@morndo/protocol";
import { ApplyService, type ApplyOutcome } from "./application/apply-service.ts";
import { planOf, type ApplyTiming } from "./application/apply-steps.ts";
import { CHECKOUT_SENTENCE, CheckService, type CheckOutcome } from "./application/check-service.ts";
import { doctor } from "./application/doctor-service.ts";
import type { RecoverOutcome } from "./application/recovery-service.ts";
import { RecoveryService } from "./application/recovery-service.ts";
import { formatStatus, readStatus } from "./application/status-service.ts";
import type {
  AlertSink, ArtifactStore, ReleaseFeed, RoleProbe, ServiceManager, UpdateHistory,
} from "./application/ports.ts";
import { ConfigFile, ConfigInvalid } from "./adapters/config-file.ts";
import { ApplyingFileMarker } from "./adapters/applying-file.ts";
import { HttpsArtifacts } from "./adapters/artifacts-https.ts";
import { SqliteBackup } from "./adapters/backup-sqlite.ts";
import { HttpsFeed } from "./adapters/feed-https.ts";
import { HoldFileWriter } from "./adapters/hold-file.ts";
import { DirsInstaller } from "./adapters/installer-dirs.ts";
import { LaunchdServices } from "./adapters/services-launchd.ts";
import { ServiceProbes } from "./adapters/probes.ts";
import { SqliteRevocations } from "./adapters/revocations-sqlite.ts";
import { SqliteSchemas } from "./adapters/schema-sqlite.ts";
import { SystemdServices, systemdUserManager } from "./adapters/services-systemd.ts";
import { databasePaths, updaterPaths } from "./adapters/paths.ts";
import { openUpdateStore, SqliteUpdateStore, UpdateDbFromFuture } from "./adapters/store-sqlite.ts";
import { SshSigVerifier } from "./adapters/verifier-sshsig.ts";

// Q4: the feed lives on the GitHub Pages of the public repository. A mirror may override it (§8.3): the address
// decides nothing about trust, the signatures do.
export const DEFAULT_FEED_BASE = "https://morndo.github.io/morndo/";

// sysexits.h, as the rest of Morndo reads it (§8.4): 64 usage; 65 a verification failed (EX_DATAERR); 70 the
// rollback itself failed (EX_SOFTWARE); 75 try later (EX_TEMPFAIL); 78 nothing to do on this machine, a setting
// to fix (EX_CONFIG); 1 a rolled-back update, or a doctor finding.
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 64;
const EXIT_DATAERR = 65;
const EXIT_SOFTWARE = 70;
const EXIT_TEMPFAIL = 75;
const EXIT_CONFIG = 78;

const USAGE = `usage: morndo-update update [--yes] [--now]       check, then apply what stands staged (asks first on a terminal)
       morndo-update update --check [--json]        check the channel feed, verify, and stage what passes
       morndo-update update --status [--json]       what this machine believes, the last updates included
       morndo-update update --rollback [--yes]      back to the previous Version (a restore asks for the typed word)
       morndo-update update apply --version <v>     one apply, as the apply unit runs it
       morndo-update update tick | boot | recover   the timer's, the boot unit's and the recovery unit's commands
       morndo-update install --role control-plane|node [--channel stable|latest] [--force]
       morndo-update doctor [--json]                re-verify the installed tree
morndo update --to, --channel, pin and auto arrive with the settings step.`;

const NOT_YET_SENTENCE = "morndo update --to, --channel, pin and auto arrive with the settings step.";
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
// itself; this is its prose.
const checkLine = (o: CheckOutcome): string => {
  switch (o.kind) {
    case "staged": return `Staged ${o.version}. It applies at the next update --yes, the tick's window, or the next boot.`;
    case "up_to_date": return `Up to date: ${o.current}.`;
    case "refused": return `Refused: ${o.step} (${o.detail}). Nothing was staged.`;
    case "skipped": return `Skipped: ${o.reason}. Nothing was staged.`;
    case "busy": return "Busy: another process holds the apply lock.";
    case "unreachable": return `Unreachable: ${o.detail}.`;
    case "failed": return `Failed: ${o.detail}. Nothing was staged; the next check tries again.`;
    case "not_ours": return o.detail;
  }
};
export const checkCode = (o: CheckOutcome): number =>
  o.kind === "refused" ? EXIT_DATAERR
  : o.kind === "busy" || o.kind === "unreachable" || o.kind === "failed" ? EXIT_TEMPFAIL
  : o.kind === "not_ours" ? EXIT_CONFIG
  : EXIT_OK;

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
  timing?: Partial<ApplyTiming>;
  /** §10.3's tree the program runs from; production discovers it around argv[1]. */
  tree?: string;
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
  // `--to`, `--channel`, pin and auto are named so a script written against the design's table meets one
  // sentence, not silence (§8.1). They are `update`'s missing settings step, not `install`'s words: install's
  // own --channel is here today.
  if (command === "update" && flags.some(f => ["--to", "--channel", "pin", "auto"].includes(f))) {
    io.err(`${NOT_YET_SENTENCE}\n`);
    return EXIT_USAGE;
  }

  type Parsed
    = { cmd: "check" }
    | { cmd: "status" }
    | { cmd: "doctor" }
    | { cmd: "update"; yes: boolean; now: boolean }
    | { cmd: "rollback"; yes: boolean }
    | { cmd: "apply-unit"; version: string }
    | { cmd: "tick" } | { cmd: "boot" } | { cmd: "recover" }
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
    // The rollback is read before the update's own set so `--rollback --yes` and `--yes --rollback` are one ask.
    if (flags.includes("--rollback") && flags.every(f => f === "--rollback" || f === "--yes")) {
      parsed = { cmd: "rollback", yes: flags.includes("--yes") };
    } else if (flags.length === 0 || flags[0] === "--yes" || flags[0] === "--now" || flags[0] === "--json") {
      if (flags.some(f => f !== "--yes" && f !== "--now" && f !== "--json")) return usage();
      parsed = { cmd: "update", yes: flags.includes("--yes"), now: flags.includes("--now") };
    } else if (flags[0] === "tick" && flags.length === 1) parsed = { cmd: "tick" };
    else if (flags[0] === "boot" && flags.length === 1) parsed = { cmd: "boot" };
    else if (flags[0] === "recover" && flags.length === 1) parsed = { cmd: "recover" };
    else if (flags[0] === "apply") {
      // "rollback" is the one instance name that is not a Version: the apply unit the rollback command starts
      // (§5) is named for what it does, and what it does is not an apply of a staged Version.
      if (flags.length !== 3 || flags[1] !== "--version"
        || (flags[2] !== "rollback" && parseVersion(flags[2]!) === null)) return usage();
      parsed = { cmd: "apply-unit", version: flags[2]! };
    } else if (flags.includes("--check") && flags.every(f => f === "--check" || f === "--json")) parsed = { cmd: "check" };
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
    });
    const alerts: AlertSink = {
      raise: (kind, detail) => { io.err(`${kind}: ${detail}\n`); },
    };
    const checkOnce = async (switches: { disableUpdates: boolean }): Promise<CheckOutcome> =>
      await new CheckService({
        feed: deps.feed ?? new HttpsFeed({ base: feedBase }),
        artifacts: deps.artifacts ?? new HttpsArtifacts({ dir: paths.downloads }),
        verifier, installer, store, settings, clock: systemClock, platform, switches,
      }).check();
    const applyWith = (services: ServiceManager): ApplyService => new ApplyService({
      services, probe,
      schemas: new SqliteSchemas({ paths: dbPaths }),
      backup: new SqliteBackup({ paths: dbPaths, backups: join(paths.state, "backups") }),
      revocations: new SqliteRevocations({ paths: dbPaths, backups: join(paths.state, "backups"), releases: paths.releases }),
      hold: new HoldFileWriter({ home, env }),
      applying: new ApplyingFileMarker({ state: paths.state }),
      installer, store, clock: systemClock, sleeper: realSleeper, alerts, verifier,
      ...(deps.timing !== undefined ? { timing: deps.timing } : {}),
    });
    const printOutcome = (line: string, code: number): number => {
      if (code === EXIT_OK) io.out(`${line}\n`);
      else io.err(`${line}\n`);
      return code;
    };

    if (parsed.cmd === "check") {
      const outcome = await checkOnce({ disableUpdates: env.MORNDO_DISABLE_UPDATES === "1" });
      if (json) io.out(`${JSON.stringify({ outcome })}\n`);            // the hub and the tests read this shape
      else return printOutcome(checkLine(outcome), checkCode(outcome));
      return checkCode(outcome);
    }

    if (parsed.cmd === "status") {
      // Even an install that is not ours is an answer, never a failure: the reader asked what this machine believes.
      const s = readStatus({ installer, store, settings });
      io.out(json ? `${JSON.stringify(UpdateStatusSchema.parse(s))}\n` : `${formatStatus(s)}\n`);
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
    // The principal's confirmed rollback (§11.4), for the apply unit to find: written by `update --rollback` once the
    // word is typed (or --yes), naming the Version it leaves, and consumed by the unit. The unit's own command line is
    // one anyone can type; without this record it runs no rollback (review of 2026-10-22).
    const rollbackConfirmedFile = join(paths.state, "rollback-confirmed");
    const ROLLBACK_CONFIRMED_FOR_MS = 10 * 60_000;

    if (parsed.cmd === "update") {
      // §8.1's update: the check first, printed exactly as --check prints it; then the ask, then the apply unit.
      const outcome = await checkOnce({ disableUpdates: env.MORNDO_DISABLE_UPDATES === "1" });
      const line = checkLine(outcome);
      const code = checkCode(outcome);
      if (code !== EXIT_OK) return printOutcome(line, code);           // refused, unreachable, not ours: as the check answered
      if (json) io.out(`${JSON.stringify({ outcome })}\n`);
      else io.out(`${line}\n`);
      const staged = store.staged();
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
      // §6.2's `--now`: a file the apply unit reads, because arguments cannot cross a unit boundary.
      if (parsed.now) writeFileSync(applyNowFile, "");
      try {
        await m.runApply(staged.version);
      } catch (error) {
        rmSync(applyNowFile, { force: true });
        io.err(`the apply unit did not run: ${error instanceof Error ? error.message : String(error)}\n`);
        return EXIT_TEMPFAIL;
      }
      rmSync(applyNowFile, { force: true });                           // a unit that never read it leaves none behind
      // The unit's record is the answer (§8.1): the exit follows the state it ended in.
      const last = store.recentUpdates(1)[0] ?? null;
      if (last === null) {
        io.err("the apply unit recorded nothing; try again\n");
        return EXIT_TEMPFAIL;
      }
      return recordExit(last, io);
    }

    if (parsed.cmd === "apply-unit") {
      // What the apply unit runs (§6.2): one apply, of the Version the unit was named for, in its own process.
      // The instance named "rollback" runs the principal's own rollback (§8.1) — the one `morndo update
      // --rollback` starts, so that no service the walk stops is its parent.
      const m = needManager();
      if (m === null) return EXIT_CONFIG;
      const goBack = "Going back to an older Version is morndo update --rollback: it says what a restore drops and asks first.";
      const running = installer.layout().current;
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
        const outcome = await applyWith(m).rollback();
        return printOutcome(applyLine(outcome), applyCode(outcome));
      }
      // An apply moves up only (RL2): a Version at or below the running one is never an apply's target.
      const asked = parseVersion(parsed.version);
      const runningVersion = running === null ? null : parseVersion(running);
      if (asked !== null && runningVersion !== null && compareVersions(asked, runningVersion) <= 0) {
        io.err(`${goBack}\n`);
        return EXIT_USAGE;
      }
      const staged = store.staged();
      if (staged === null) { io.err("nothing stands staged to apply\n"); return EXIT_TEMPFAIL; }
      if (staged.version !== parsed.version) {
        io.err(`the staged version changed: ${staged.version} is staged, not ${parsed.version}\n`);
        return EXIT_TEMPFAIL;
      }
      const now = existsSync(applyNowFile);
      if (now) rmSync(applyNowFile, { force: true });
      const outcome = await applyWith(m).apply({ now });
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
      io.out(restores.length === 0
        ? `Back to ${layout.previous} from ${layout.current}; no database is restored.\n`
        : `Back to ${layout.previous} from ${layout.current}.\n`);
      for (const { db, at } of dropped) {
        io.out(`The ${db} database goes back to its backup from ${stampOf(at)} (${ageWords(systemClock.now() - at)} of writes since are dropped).\n`);
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
      writeFileSync(rollbackConfirmedFile, `${JSON.stringify({ from: layout.current, at: Date.now() })}\n`, { mode: 0o600 });
      try {
        await m.runApply("rollback");            // §5: the morndo-update-apply@rollback.service instance
      } catch (error) {
        io.err(`the apply unit did not run: ${error instanceof Error ? error.message : String(error)}\n`);
        return EXIT_TEMPFAIL;
      }
      // The unit's record is the answer (§8.1): the exit follows the state it ended in.
      const last = store.recentUpdates(1)[0] ?? null;
      if (last === null) {
        io.err("the apply unit recorded nothing; try again\n");
        return EXIT_TEMPFAIL;
      }
      return recordExit(last, io);
    }

    if (parsed.cmd === "tick") {
      // The timer's own command (§6.1, §8.3): the switches and the mode stop it before anything is fetched;
      // then the check, and — in mode apply — the automatic apply inside its window.
      if (env.MORNDO_DISABLE_UPDATES === "1" || env.MORNDO_DISABLE_AUTOUPDATE === "1") return EXIT_OK;
      const read = settings.read();
      if (read.mode === "off") return EXIT_OK;
      const outcome = await checkOnce({ disableUpdates: false });
      printOutcome(checkLine(outcome), checkCode(outcome));
      if (read.mode !== "apply") return checkCode(outcome);
      const staged = store.staged();
      if (staged === null || !installer.has(staged.version)) return checkCode(outcome);
      const m = needManager();
      if (m === null) return EXIT_CONFIG;
      // The automatic walk (§6.3, §8.3): safeToApply with automatic true — the window is the settings' own, and
      // attending is always "nobody is" until the hub reports an attending signal (PR 6).
      const applied = await applyWith(m).apply({ now: false, automatic: true, window: read.window });
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
      const applied = await applyWith(m).apply({ now: false, boot: true });
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
    const findings = await installer.verifyTreeAt(tree, null);
    if (findings.length > 0) {
      io.err(`the tree does not check out against its own files.json (${findings[0]!.path}: ${findings[0]!.problem}); nothing was installed\n`);
      return EXIT_DATAERR;
    }
    // The trust anchor the tree ships (§10.1): root signs the key set, once, and the store starts from it.
    let keyDoc: unknown;
    try { keyDoc = JSON.parse(readFileSync(join(tree, "trust", "keys.json"), "utf8")); }
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
    const foreign = await m.foreignUnits(versionText, { services: roleServices });
    if (foreign.length > 0 && !parsed.force) {
      io.err(`${foreign.join(", ")}: not written by Morndo; move ${foreign.length === 1 ? "it" : "them"} away, or run with --force to keep ${foreign.length === 1 ? "it" : "them"} as <name>.before-morndo; nothing was installed\n`);
      return EXIT_CONFIG;
    }
    installer.installTree({ tree, version: versionText, at: systemClock.now() });
    installer.swap({ current: versionText, previous: null });
    installer.setGood(versionText);
    // The store's first words: this Version committed, the tree's key set trusted. The channel goes into the
    // settings only when the file is absent — a user's config is never rewritten (§11.6).
    store.recordCommitted(versionText, systemClock.now(), null);
    store.saveTrust({ keySet: keySet.data, highestFeedSeq: { stable: 0, latest: 0 } });
    if (!existsSync(paths.config)) {
      mkdirSync(dirname(paths.config), { recursive: true, mode: 0o700 });
      writeFileSync(paths.config, `${JSON.stringify({ channel: parsed.channel }, null, 2)}\n`, { mode: 0o600 });
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
    if (!joined) {
      io.out("the agent waits to join: morndo-node join <code>, then systemctl --user start morndo-node\n");
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
