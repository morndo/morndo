// What this machine reports about itself (docs/design/fleet-core/README.md §5.4, `health`): memory, memory pressure, the
// free disk under the home directory, the load, and whether its tmux server answers. On Linux, MemAvailable comes from
// /proc/meminfo (proc(5)) and the pressure from /proc/pressure/memory (PSI, "some" and "full" avg10:
// https://docs.kernel.org/accounting/psi.html, read 2026-10-06). Elsewhere (macOS) memAvailable is os.freemem() and
// the pressure fields are null. wallClock, spoolDepth and drops are the agent's own, so they are not here.
import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { freemem, loadavg, totalmem } from "node:os";
import { promisify } from "node:util";
import type { Health } from "@morndo/protocol";
import { tmuxArgv } from "./tmux-cli.ts";

const run = promisify(execFile);

export type HealthProbe = Omit<Health, "wallClock" | "spoolDepth" | "drops" | "jobs">;

// "MemAvailable:   123456 kB" → bytes; null without that line.
export function memAvailableFrom(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
  return m ? Number(m[1]) * 1024 : null;
}

// "some avg10=1.50 avg60=… total=…" and "full avg10=…": the 10-second averages, in percent; null for a missing line.
export function psiFrom(pressure: string): { some10: number | null; full10: number | null } {
  const avg10 = (kind: "some" | "full") => {
    const m = new RegExp(`^${kind} avg10=(\\d+(?:\\.\\d+)?)`, "m").exec(pressure);
    return m ? Number(m[1]) : null;
  };
  return { some10: avg10("some"), full10: avg10("full") };
}

const text = async (path: string) => { try { return await readFile(path, "utf8"); } catch { return null; } };

// `tmuxSocket`: the tmux -L socket the node's lanes run on (its policy's); null or absent, the default server.
// tmuxOk: that server answers list-sessions.
export async function healthProbe(home: string, o: { tmuxSocket?: string | null } = {}): Promise<HealthProbe> {
  const [meminfo, pressure, diskFreeHome, tmuxOk] = await Promise.all([
    text("/proc/meminfo"),
    text("/proc/pressure/memory"),
    statfs(home).then(s => s.bavail * s.bsize, () => 0),
    run("tmux", tmuxArgv(o.tmuxSocket ?? null, ["list-sessions"]), { timeout: 3000 }).then(() => true, () => false),
  ]);
  const psi = pressure === null ? { some10: null, full10: null } : psiFrom(pressure);
  return {
    memTotal: totalmem(), memAvailable: (meminfo === null ? null : memAvailableFrom(meminfo)) ?? freemem(),
    psiSome10: psi.some10, psiFull10: psi.full10, diskFreeHome, load1: loadavg()[0] ?? 0, tmuxOk,
  };
}
