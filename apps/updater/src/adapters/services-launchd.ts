// The launchd ServiceManager (design §4.6, §5, U19: launchctl(1) as the mirror the design cites): macOS's
// answer to services-systemd. The labels are com.morndo.<service>; a stop is bootout, a start bootstraps the
// plist — kickstart -k for a job that is already loaded — and the restart count probation judges comes from
// launchctl print's "runs =" line, counted from this adapter's own start. tmuxInAgentUnit is false here on
// purpose: launchd stops a job's processes, not a control group, so the tmux server an agent started does
// not ride along with the job's death — the hazard RL13 guards on systemd has no macOS counterpart.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UPDATE_SCOPE_SERVICES, type UpdateService } from "@morndo/domain";
import type { ServiceManager } from "../application/ports.ts";
import { updaterPaths } from "./paths.ts";

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

  async renderUnits(version: string): Promise<void> {
    // The templates carry @HOME@ because launchd has no %h: the home is written in at render time. No
    // daemon-reload follows — launchd has none; a start bootstraps whatever plist it finds here.
    const from = join(this.releases, version, "units", "launchd");
    const shipped = readdirSync(from).filter(n => n.startsWith("com.morndo.") && n.endsWith(".plist"));
    if (shipped.length === 0) throw new Error(`${from}: a Version ships no launchd templates`);
    mkdirSync(this.agentsDir, { recursive: true });
    for (const name of shipped) {
      const text = readFileSync(join(from, name), "utf8").replaceAll("@HOME@", this.home);
      // atomic like every updater write (§5): a whole plist lands by rename, never half of one by a crash.
      // A leftover temp from a killed render is removed first, so it cannot keep an old mode through create.
      const temp = join(this.agentsDir, `.${name}.new`);
      rmSync(temp, { force: true });
      writeFileSync(temp, text);
      renameSync(temp, join(this.agentsDir, name));
    }
    for (const name of readdirSync(this.agentsDir)) {
      if (!name.startsWith("com.morndo.") || !name.endsWith(".plist")) continue;
      if (!shipped.includes(name)) rmSync(join(this.agentsDir, name));
    }
  }

  async tmuxInAgentUnit(): Promise<boolean> {
    // False by design, not by omission: see this file's header. The systemd adapter carries the guard.
    return false;
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
