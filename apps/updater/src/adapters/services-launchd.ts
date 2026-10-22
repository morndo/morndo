// The launchd ServiceManager (design §4.6, §5, U19: launchctl(1) as the mirror the design cites): macOS's
// answer to services-systemd. The labels are com.morndo.<service>; a stop is bootout, a start bootstraps the
// plist — kickstart -k for a job that is already loaded — and the restart count probation judges comes from
// launchctl print's "runs =" line, counted from this adapter's own start. The apply runs as a detached child
// of the launcher (launchd has no transient units), setsid so no job's end takes it along. tmuxInAgentUnit is
// false here on purpose: launchd stops a job's processes, not a control group, so the tmux server an agent
// started does not ride along with the job's death — the hazard RL13 guards on systemd has no macOS counterpart.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UPDATE_SCOPE_SERVICES, type UpdateService } from "@morndo/domain";
import type { ServiceManager } from "../application/ports.ts";
import { updaterPaths } from "./paths.ts";
import { legacyService } from "./services-systemd.ts";
import { foreignIn, placeUnits, type UnitDir } from "./unit-files.ts";

// The same shape as services-systemd's: one program, one argument list, no shell.
export type Run = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const execFileRun: Run = (file, args) => new Promise(resolve => {
  execFile(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
    resolve({
      code: error === null ? 0 : typeof error.code === "number" ? error.code : 127,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
    });
  });
});

// Morndo's labels (§5): hub, fleet and node become com.morndo.<service>.
const label = (s: UpdateService): string => `com.morndo.${s}`;
const SERVICE_PLISTS = new Set(UPDATE_SCOPE_SERVICES.map(s => `${label(s)}.plist`));
const isPlist = (name: string): boolean => name.startsWith("com.morndo.") && name.endsWith(".plist");

// The second line of every plist a render writes, right after the XML declaration (a comment may not come before
// it): what marks the file as Morndo's to replace or remove.
export const PLIST_MARK = "<!-- Morndo's own job: every update rewrites it. -->";
const withMark = (text: string): string => {
  const [first, ...rest] = text.split("\n");
  return first!.startsWith("<?xml") ? [first, PLIST_MARK, ...rest].join("\n") : `<?xml version="1.0" encoding="UTF-8"?>\n${PLIST_MARK}\n${text}`;
};

// A systemd unit name to its launchd label, for `enable` — the one place the two managers' vocabularies meet.
// The update timer's unit and its service both map to the one job that runs the tick; the boot unit has no
// counterpart (launchd has no ordering, so the boot apply happens at the tick's first safe point instead), and
// the apply template is never enabled — it is a person's or the tick's own call.
const plistOfUnit = (name: string): string | null => {
  const base = name.replace(/^morndo-/, "").replace(/\.(service|timer)$/, "");
  if (base === "update" || base === "update-recover") return `com.morndo.${base}.plist`;
  if ((UPDATE_SCOPE_SERVICES as readonly string[]).includes(base)) return `com.morndo.${base}.plist`;
  return null;
};

// The "runs = N" line of `launchctl print`'s state section; a job with no line, or none an answer carries,
// has not run.
const runsOf = (text: string): number => {
  const found = /^\s*runs\s*=\s*(\d+)\s*$/m.exec(text);
  return found === null ? 0 : Number(found[1]);
};

// launchd is macOS only, where every process has a uid and getuid always answers; the fallback only keeps
// the type whole on a platform this adapter never runs on.
const uidOf = (): number => (typeof process.getuid === "function" ? process.getuid() : 0);

export class LaunchdServices implements ServiceManager {
  private readonly home: string;
  private readonly agentsDir: string;
  private readonly releases: string;
  private readonly run: Run;
  private readonly domainTarget: string;   // gui/<uid>: the user's domain, in launchctl's own spelling
  // runs = as read right after this adapter's own start: restarts() counts from here.
  private readonly runsAtStart = new Map<UpdateService, number>();

  constructor(o: { home: string; run?: Run; uid?: number; agentsDir?: string }) {
    this.home = o.home;
    this.agentsDir = o.agentsDir ?? join(o.home, "Library/LaunchAgents");
    this.releases = updaterPaths(o.home).releases;
    this.run = o.run ?? execFileRun;
    this.domainTarget = `gui/${o.uid ?? uidOf()}`;
  }

  services(): UpdateService[] {
    return UPDATE_SCOPE_SERVICES.filter(s => existsSync(join(this.agentsDir, `${label(s)}.plist`)));
  }

  async stop(s: UpdateService): Promise<void> {
    await this.checked(["bootout", this.target(s)]);
  }

  async start(s: UpdateService): Promise<void> {
    // A loaded job is restarted in place (kickstart -k); a bootout leaves the label unloaded, and only
    // bootstrap brings a plist's job back.
    const before = await this.run("launchctl", ["print", this.target(s)]);
    if (before.code === 0) await this.checked(["kickstart", "-k", this.target(s)]);
    else await this.checked(["bootstrap", this.domainTarget, join(this.agentsDir, `${label(s)}.plist`)]);
    // the count probation judges is "since our start", so the baseline is read right after the start
    const after = await this.run("launchctl", ["print", this.target(s)]);
    this.runsAtStart.set(s, runsOf(after.stdout));
  }

  async restarts(s: UpdateService): Promise<number> {
    // A stopped job has no line to read; that is zero runs since ours, not a failure to count.
    const out = await this.run("launchctl", ["print", this.target(s)]);
    return Math.max(0, runsOf(out.stdout) - (this.runsAtStart.get(s) ?? 0));
  }

  async renderUnits(version: string, role?: { services: readonly UpdateService[] }, o?: { replaceForeign?: boolean }): Promise<string[]> {
    // The templates carry @HOME@ because launchd has no %h: the home is written in at render time. No
    // daemon-reload follows — launchd has none; a start bootstraps whatever plist it finds here. A role, when
    // given, narrows the service plists to that role's — `morndo install`'s rendering for the role asked for.
    // Each plist gets Morndo's mark as its second line, the first comment after the XML declaration.
    const from = join(this.releases, version, "units", "launchd");
    const shipped = this.shipped(from, role);
    if (shipped.length === 0) throw new Error(`${from}: a Version ships no launchd templates`);
    mkdirSync(this.agentsDir, { recursive: true });
    return placeUnits(this.unitDir(), shipped.map(name => ({ name, text: withMark(readFileSync(join(from, name), "utf8").replaceAll("@HOME@", this.home)) })),
      o?.replaceForeign === true);
  }

  async foreignUnits(version: string, role?: { services: readonly UpdateService[] }): Promise<string[]> {
    return foreignIn(this.unitDir(), this.shipped(join(this.releases, version, "units", "launchd"), role));
  }

  private shipped(from: string, role?: { services: readonly UpdateService[] }): string[] {
    const wanted = (name: string): boolean =>
      role === undefined || !SERVICE_PLISTS.has(name) || role.services.some(s => `${label(s)}.plist` === name);
    return readdirSync(from).filter(n => isPlist(n) && wanted(n));
  }

  private unitDir(): UnitDir {
    return {
      dir: this.agentsDir, isUnit: isPlist, marked: t => t.split("\n", 2)[1] === PLIST_MARK,
      legacy: (n, t) => legacyService(n, t.match(/<key>ProgramArguments<\/key>\s*<array>[\s\S]*?<\/array>/)?.[0] ?? ""),
    };
  }

  async tmuxInAgentUnit(): Promise<boolean> {
    // False by design, not by omission: see this file's header. The systemd adapter carries the guard.
    return false;
  }

  async runApply(version: string): Promise<void> {
    // launchd has no transient units, so the apply runs as a child of this program, detached with setsid — the
    // macOS mirror of the apply unit's rule (§5, U19): no service's end, and no terminal's hangup, takes the
    // walk along. It is waited on here, so the caller reads the apply's own exit, not the child's spawn.
    const done = await new Promise<{ code: number | null }>(resolve => {
      const child = spawn(join(this.home, ".local/bin/morndo-update"), ["update", "apply", "--version", version],
        { detached: true, stdio: "ignore" });
      child.on("error", () => resolve({ code: 127 }));
      child.on("exit", code => resolve({ code }));
    });
    if (done.code !== 0) throw new Error(`morndo-update apply --version ${version}: exit ${done.code ?? "?"}`);
  }

  async enable(units: readonly string[]): Promise<void> {
    // The unit names come in systemd's vocabulary (the install names one list for both managers); each maps to
    // the plist launchd knows, the ones with no counterpart skip, and each plist is bootstrapped — which starts
    // the job too, the `--now` half of enable.
    for (const name of units) {
      const plist = plistOfUnit(name);
      if (plist === null) continue;
      await this.checked(["bootstrap", this.domainTarget, join(this.agentsDir, plist)]);
    }
  }

  async lingerEnabled(): Promise<boolean> {
    // True by design: launchd user agents load at login and keep running under the user's GUI session — the
    // notion systemd calls linger has no loginctl here, and nothing to check.
    return true;
  }

  private target(s: UpdateService): string { return `${this.domainTarget}/${label(s)}` }

  // A failing launchctl is a failing stop, start or restart: stderr carries the words, never just a code.
  private async checked(args: string[]): Promise<void> {
    const out = await this.run("launchctl", args);
    if (out.code !== 0) {
      throw new Error(`launchctl ${args.join(" ")}: ${out.stderr.trim() !== "" ? out.stderr.trim() : `exit ${out.code}`}`);
    }
  }
}
