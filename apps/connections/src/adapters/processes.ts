// The holder is this process. A helper is accepted only when its ancestors include that identity.
// Start ticks and boot id come from node-ops, so the launcher and the helper describe a pid the same way.
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import type { Holder } from "@morndo/domain";
import { processAlive, processIdentity } from "@morndo/node-ops";
import type { ProcId, Processes } from "../application/ports.ts";

function ppid(pid: number): number | null {
  let stat: string;
  try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); }
  catch { return null; }
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const parent = Number(stat.slice(close + 1).trim().split(/\s+/)[1]);
  return Number.isInteger(parent) && parent > 0 ? parent : null;
}

// When a process started, as a window: its start time in clock ticks since boot (field 22 of /proc/<pid>/stat; 100 ticks a second on Linux) added
// to the boot time of /proc/stat, which is known only to the whole second, so `from` can be up to a second early and `to` is the latest it can be.
// Null for anything that is not a readable process.
export function processStartWindow(pid: number): { from: number; to: number } | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const ticks = Number(stat.slice(close + 1).trim().split(/\s+/)[19]);
    const btime = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
    if (close < 0 || !Number.isFinite(ticks) || !Number.isFinite(btime)) return null;
    const from = Math.floor((btime + ticks / 100) * 1000);
    return { from, to: from + 1000 };
  } catch { return null; }
}

export function processStartMs(pid: number): number | null {
  return processStartWindow(pid)?.from ?? null;
}

export function selfId(): ProcId | null {
  const id = processIdentity(process.pid);
  if (!id) return null;
  return { pid: process.pid, startedAt: id.ticks, bootId: id.bootId };
}

export function selfHolder(lane: string | null): Holder | null {
  const id = selfId();
  if (!id) return null;
  return { node: hostname(), pid: id.pid, startedAt: id.startedAt, bootId: id.bootId, lane };
}

export class ProcProcesses implements Processes {
  identity(pid: number): ProcId | null {
    const id = processIdentity(pid);
    if (!id) return null;
    return { pid, startedAt: id.ticks, bootId: id.bootId };
  }

  ancestors(pid: number): readonly ProcId[] {
    const out: ProcId[] = [];
    let current = pid;
    for (let depth = 0; depth < 64; depth++) {
      const id = this.identity(current);
      if (!id) break;
      out.push(id);
      const parent = ppid(current);
      if (parent === null || parent <= 1 || parent === current) break;
      current = parent;
    }
    return out;
  }

  alive(id: ProcId): boolean {
    const current = this.identity(id.pid);
    return current !== null && current.startedAt === id.startedAt && current.bootId === id.bootId && processAlive(id.pid);
  }
}
