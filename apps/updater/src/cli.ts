// morndo-update's composition root (design §4.6, §4.7, §8.1, §8.3, §8.4): the one place the application's services
// meet real adapters — the paths from HOME, the HTTPS feed and artifacts, the versioned-directories installer, the
// SQLite store, the settings file, the system clock. The command line is parsed here and nowhere else; the exit
// codes are sysexits.h's, as in the rest of Morndo. What this step owns is the check and the stage: the apply
// commands answer with one sentence until the apply step lands (§8.1).
import { mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Platform } from "@morndo/domain";
import { UpdateStatusSchema } from "@morndo/protocol";
import { CheckService, type CheckOutcome } from "./application/check-service.ts";
import { doctor } from "./application/doctor-service.ts";
import { formatStatus, readStatus } from "./application/status-service.ts";
import { ConfigFile, ConfigInvalid } from "./adapters/config-file.ts";
import { HttpsArtifacts } from "./adapters/artifacts-https.ts";
import { HttpsFeed } from "./adapters/feed-https.ts";
import { DirsInstaller } from "./adapters/installer-dirs.ts";
import { updaterPaths } from "./adapters/paths.ts";
import { openUpdateStore, UpdateDbFromFuture } from "./adapters/store-sqlite.ts";
import { SshSigVerifier } from "./adapters/verifier-sshsig.ts";

// Q4: the feed lives on the GitHub Pages of the public repository. A mirror may override it (§8.3): the address
// decides nothing about trust, the signatures do.
export const DEFAULT_FEED_BASE = "https://morndo.github.io/morndo/";

// sysexits.h, as the rest of Morndo reads it (§8.4): 64 usage; 65 a verification failed (EX_DATAERR); 75 try later
// (EX_TEMPFAIL); 78 nothing to do on this machine, a setting to fix (EX_CONFIG); 1 a doctor finding.
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 64;
const EXIT_DATAERR = 65;
const EXIT_TEMPFAIL = 75;
const EXIT_CONFIG = 78;

const USAGE = `usage: morndo-update update --check [--json]      check the channel feed, verify, and stage what passes
       morndo-update update --status [--json]      what this machine believes
       morndo-update doctor [--json]              re-verify the installed tree
The apply commands (update, --now, --to, --rollback, --channel, pin, auto) arrive with the apply step.`;

const APPLIES_NOTHING = "morndo update applies nothing yet: use --check to check and stage, --status to see the state.";

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
    case "staged": return `Staged ${o.version}. It applies in a later release of the updater; nothing was restarted.`;
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

const systemClock = { now: (): number => Date.now() };

export async function runUpdater(argv: string[], env: NodeJS.ProcessEnv, io: { out(s: string): void; err(s: string): void }):
Promise<number> {
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

  const [command = "", ...flags] = argv;
  if (command !== "update" && command !== "doctor") { io.err(`${USAGE}\n`); return EXIT_USAGE; }
  const json = flags.includes("--json");
  if (command === "update") {
    // The apply commands are named so a script written against the design's table meets one sentence, not silence.
    const applies = ["--now", "--to", "--rollback", "--channel", "pin", "auto"];
    if (flags.length === 0 || flags.some(f => applies.includes(f))) {
      io.err(`${APPLIES_NOTHING}\n`);
      return EXIT_USAGE;
    }
    const wants = flags.filter(f => f === "--check" || f === "--status");
    if (wants.length !== 1 || flags.some(f => f !== "--json" && f !== wants[0])) {
      io.err(wants.length === 0 ? `${APPLIES_NOTHING}\n` : `${USAGE}\n`);
      return EXIT_USAGE;
    }
  } else if (flags.some(f => f !== "--json")) { io.err(`${USAGE}\n`); return EXIT_USAGE; }
  const check = command === "update" && flags.includes("--check");
  const status = command === "update" && flags.includes("--status");

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
  let store;
  try { store = openUpdateStore({ db: paths.db, lock: paths.lock }); }
  catch (error) {
    if (!(error instanceof UpdateDbFromFuture)) throw error;
    io.err(`${error.message} Run the newer Morndo once, or remove ${paths.db} to start its record empty.\n`);
    return EXIT_CONFIG;
  }
  try {
    const installer = new DirsInstaller({ releases: paths.releases });

    if (check) {
      const outcome = await new CheckService({
        feed: new HttpsFeed({ base: feedBase }),
        artifacts: new HttpsArtifacts({ dir: paths.downloads }),
        verifier: new SshSigVerifier(),
        installer, store, settings, clock: systemClock, platform,
        switches: { disableUpdates: env.MORNDO_DISABLE_UPDATES === "1" },
      }).check();
      if (json) io.out(`${JSON.stringify({ outcome })}\n`);            // the hub and the tests read this shape
      else {
        const line = `${checkLine(outcome)}\n`;
        if (checkCode(outcome) === EXIT_OK) io.out(line);
        else io.err(line);
      }
      return checkCode(outcome);
    }

    if (status) {
      // Even an install that is not ours is an answer, never a failure: the reader asked what this machine believes.
      const s = readStatus({ installer, store, settings });
      io.out(json ? `${JSON.stringify(UpdateStatusSchema.parse(s))}\n` : `${formatStatus(s)}\n`);
      return EXIT_OK;
    }

    // doctor: the install's own word re-checked against what was signed (§8.1). A checkout ends the questions at
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
  } finally {
    store.close();
  }
}
