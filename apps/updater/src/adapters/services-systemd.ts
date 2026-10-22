// The systemd ServiceManager (design §4.6, §5, §6.2 step 6): everything the apply and the install need from the
// machine's service manager goes through `systemctl --user` — stop, start, the restart count probation judges, the
// rendering of a Version's units into ~/.config/systemd/user with the daemon-reload after, the apply's own
// transient unit, `morndo install`'s enable --now, and linger — and, before any stop of the node agent, the RL13
// guard: whether the tmux server sits inside the agent unit's control group, which systemd's stop empties
// (systemd.kill(5), systemd 255, the design's U18). The cgroup root and /proc are constructor options so a test
// walks a fake tree, not this machine's.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UPDATE_SCOPE_SERVICES, type UpdateService } from "@morndo/domain";
import type { ServiceManager } from "../application/ports.ts";
import { updaterPaths } from "./paths.ts";
import { foreignIn, placeUnits, type UnitDir } from "./unit-files.ts";

// One program, one argument list, no shell (execFile): what a test scripts, what systemctl answers.
export type Run = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const execFileRun: Run = (file, args) => new Promise(resolve => {
  execFile(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
    resolve({
      // a non-zero exit is a number; a spawn failure (ENOENT and friends) is not, and reads as 127
      code: error === null ? 0 : typeof error.code === "number" ? error.code : 127,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
    });
  });
});

// Whether a systemd user manager answers here (§4.7): `systemctl --user show-environment` prints the manager's
// own environment only when one runs for this user (systemctl(1), systemd 255). Anything else — no user manager,
// no systemd at all — reads as "not this machine's manager", and the updater stages only.
export async function systemdUserManager(run: Run = execFileRun): Promise<boolean> {
  return (await run("systemctl", ["--user", "show-environment"])).code === 0;
}

// Morndo's unit names (§5): hub, fleet and node become morndo-<s>.service.
const unit = (s: UpdateService): string => `morndo-${s}.service`;
const SERVICE_UNITS = new Set(UPDATE_SCOPE_SERVICES.map(s => unit(s)));
const isUnitFile = (name: string): boolean => name.endsWith(".service") || name.endsWith(".timer");

// The first line of every unit file a render writes: what marks the file as Morndo's to replace or remove.
export const UNIT_MARK = "# Morndo's own unit: every update rewrites it. Put changes in a drop-in (<unit>.d/*.conf).";

// Every pid cgroup.procs names, one per line; a group or file that cannot be read hides no tmux.
const readPids = (path: string): string[] => {
  try { return readFileSync(path, "utf8").split("\n").map(line => line.trim()).filter(line => line !== ""); }
  catch { return []; }
};

export class SystemdServices implements ServiceManager {
  private readonly units: string;
  private readonly releases: string;
  private readonly run: Run;
  private readonly user: string;
  private readonly cgroupRoot: string;
  private readonly procRoot: string;
  // NRestarts as read right after this adapter's own start of each service: restarts() counts from here,
  // whatever systemd's lifetime counter holds (§6.2 step 9 judges "since our start").
  private readonly restartsAtStart = new Map<UpdateService, number>();

  constructor(o: { home: string; units: string; run?: Run; user?: string; cgroupRoot?: string; procRoot?: string }) {
    this.units = o.units;
    this.releases = updaterPaths(o.home).releases;
    this.run = o.run ?? execFileRun;
    this.user = o.user ?? (process.env.USER ?? homedir().split("/").pop() ?? "morndo");
    this.cgroupRoot = o.cgroupRoot ?? "/sys/fs/cgroup";
    this.procRoot = o.procRoot ?? "/proc";
  }

  services(): UpdateService[] {
    return UPDATE_SCOPE_SERVICES.filter(s => existsSync(join(this.units, unit(s))));
  }

  async stop(s: UpdateService): Promise<void> {
    await this.checked(["--user", "stop", unit(s)]);
  }

  async start(s: UpdateService): Promise<void> {
    await this.checked(["--user", "start", unit(s)]);
    this.restartsAtStart.set(s, await this.nRestarts(s));
  }

  async restarts(s: UpdateService): Promise<number> {
    // systemd resets NRestarts when someone else starts the unit again; that must never read as a negative
    // count, which probation would take for "no restarts since ours" anyway.
    return Math.max(0, await this.nRestarts(s) - (this.restartsAtStart.get(s) ?? 0));
  }

  async renderUnits(version: string, role?: { services: readonly UpdateService[] }, o?: { replaceForeign?: boolean }): Promise<string[]> {
    // §6.2 step 6: the target's units are in place before `current` moves, so the reload that follows the
    // swap sees them. launchd's templates sit beside these in units/launchd/ and are not systemd's. A role, when
    // given, narrows the service units to that role's — `morndo install`'s rendering for the role it was asked
    // for — and the update units always come along. Each file gets Morndo's mark as its first line.
    const from = join(this.releases, version, "units");
    const shipped = this.shipped(from, role);
    if (shipped.length === 0) throw new Error(`${from}: a Version ships no units`);
    mkdirSync(this.units, { recursive: true });
    const kept = placeUnits(this.unitDir(), shipped.map(name => ({ name, text: `${UNIT_MARK}\n${readFileSync(join(from, name), "utf8")}` })),
      o?.replaceForeign === true);
    await this.checked(["--user", "daemon-reload"]);
    return kept;
  }

  async foreignUnits(version: string, role?: { services: readonly UpdateService[] }): Promise<string[]> {
    return foreignIn(this.unitDir(), this.shipped(join(this.releases, version, "units"), role));
  }

  private shipped(from: string, role?: { services: readonly UpdateService[] }): string[] {
    const wanted = (name: string): boolean =>
      role === undefined || !SERVICE_UNITS.has(name) || role.services.some(s => unit(s) === name);
    return readdirSync(from).filter(n => isUnitFile(n) && wanted(n));
  }

  private unitDir(): UnitDir {
    return { dir: this.units, isUnit: n => n.startsWith("morndo-") && isUnitFile(n), marked: t => t.startsWith(`${UNIT_MARK}\n`) };
  }

  async tmuxInAgentUnit(): Promise<boolean> {
    const { stdout } = await this.checked(["--user", "show", "-p", "ControlGroup", "--value", unit("node")]);
    const group = stdout.trim();
    // an empty answer is a unit with no processes (not loaded, or stopped): nothing rides along with a stop
    return group !== "" && this.tmuxInCgroup(join(this.cgroupRoot, group));
  }

  async runApply(version: string, o?: { wait?: boolean }): Promise<void> {
    // §6.2's apply runs as its own oneshot unit: `systemctl --user start` on a oneshot returns only when the
    // unit's run has ended (systemctl(1), systemd 255), so whoever asked for the apply — a person at a terminal,
    // the tick — can die without interrupting the walk, and the exit code the unit recorded is the answer.
    // PR 6c's --detach adds --no-block: the start is asked for, not waited on, and the unit's own record is
    // how it ended.
    await this.checked(["--user", ...(o?.wait === false ? ["--no-block"] : []), "start", `morndo-update-apply@${version}.service`]);
  }

  async enable(units: readonly string[]): Promise<void> {
    if (units.length > 0) await this.checked(["--user", "enable", "--now", ...units]);
  }

  async lingerEnabled(): Promise<boolean> {
    // Linger keeps the user's units running after logout (loginctl(1), systemd 255); without it, `morndo
    // install` would leave a machine whose services die with its login session.
    const out = await this.run("loginctl", ["show-user", this.user, "-p", "Linger", "--value"]);
    return out.code === 0 && out.stdout.trim() === "yes";
  }

  // RL13: the group's own processes and every sub-group's, depth first — a fresh machine's tmux server
  // lands in a sub-group the agent's own cgroup.procs does not name.
  private tmuxInCgroup(dir: string): boolean {
    for (const pid of readPids(join(dir, "cgroup.procs"))) {
      try {
        if (readFileSync(join(this.procRoot, pid, "comm"), "utf8").startsWith("tmux")) return true;
      } catch { /* the process left between the two reads: it is not evidence of tmux */ }
    }
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    return entries.filter(e => e.isDirectory()).some(e => this.tmuxInCgroup(join(dir, e.name)));
  }

  private async nRestarts(s: UpdateService): Promise<number> {
    const { stdout } = await this.checked(["--user", "show", "-p", "NRestarts", "--value", unit(s)]);
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(n) ? 0 : n;
  }

  // A failing systemctl is a failing stop, start or reload: the words come back in stderr, never just a code.
  private async checked(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const out = await this.run("systemctl", args);
    if (out.code !== 0) {
      throw new Error(`systemctl ${args.join(" ")}: ${out.stderr.trim() !== "" ? out.stderr.trim() : `exit ${out.code}`}`);
    }
    return out;
  }
}
