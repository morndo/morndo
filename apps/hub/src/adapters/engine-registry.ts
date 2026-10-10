// Engine-lane registry: one small JSON file per process, `<dir>/<pid>.json`, written by the engine lane
// (name, status busy|idle, pid, engine, pidStartTicks, bootId). Read on every poll: a directory of small files,
// no cache and no `lanes` process. A file counts only when its pid is alive (checked before the file is opened),
// the file name's pid is the body's, and pidStartTicks and bootId are exactly the live process's start tick
// (field 22 of /proc/<pid>/stat) and this boot's id (/proc/sys/kernel/random/boot_id). No wall clock and no
// tolerance: a WSL clock step moves btime, so an absolute start time drifts (deploy of #18, 2026-10-08).
// startedAt and pidStartedAt are not compared. A file without both fields is an old writer and does not govern.
// The writer (engine-layer src/engines/lane.py, read 2026-10-09) stamps those two fields from /proc.
// process.kill: https://nodejs.org/api/process.html#processkillpid-signal (read 2026-10-08).
// readdir/readFile: https://nodejs.org/api/fs.html#fspromisesreaddirpath-options (read 2026-10-08).
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { processAlive, processIdentity, type ProcessIdentity } from "@morndo/node-ops";
import { log as hubLog } from "./log.ts";
import type { LaneReport, LaneStatuses } from "../application/ports.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// One registry file, or null when it isn't this live process. The caller has already skipped a dead pid.
// No pidStartTicks or bootId means the file does not govern.
export function parseEngineFile(text: string, filePid: number, live: ProcessIdentity | null): LaneReport | null {
  if (live === null) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!isRecord(value)) return null;
  const { name, status, engine, pid, pidStartTicks, bootId } = value;
  if (typeof name !== "string" || name === "") return null;
  if (status !== "busy" && status !== "idle") return null;
  if (typeof engine !== "string" || engine === "") return null;
  if (typeof pid !== "number" || pid !== filePid) return null;
  if (typeof pidStartTicks !== "number" || !Number.isInteger(pidStartTicks) || pidStartTicks !== live.ticks) return null;
  if (typeof bootId !== "string" || bootId === "" || bootId !== live.bootId) return null;
  return { name, status, engine };
}

export type EngineRegistryOptions = {
  readDir?: (dir: string) => Promise<string[]>;
  readFile?: (path: string) => Promise<string>;
  alive?: (pid: number) => boolean;
  // Live start tick and boot id, or null when they cannot be read. Null means the file does not govern.
  identity?: (pid: number) => ProcessIdentity | null | Promise<ProcessIdentity | null>;
  log?: { warn(message: string): void; info(message: string): void };
};

const FILE_PID = /^(\d+)\.json$/;

// `dir` on every call. A failed directory read is no reports for that poll: one warning when the failures start,
// one info line when they stop. A bad file is skipped and is not a directory failure. The files of one poll are
// read together.
export function engineRegistry(dir: string, o: EngineRegistryOptions = {}): LaneStatuses {
  const readDir = o.readDir ?? (path => readdir(path));
  const read = o.readFile ?? (path => readFile(path, "utf8"));
  const alive = o.alive ?? processAlive;
  const identity = o.identity ?? processIdentity;
  const out = o.log ?? hubLog;
  let down = false;
  return async () => {
    let names: string[];
    try { names = await readDir(dir); }
    catch (e) {
      if (!down) {
        down = true;
        out.warn(`engine registry unreadable (${e instanceof Error ? e.message : "unknown"})`);
      }
      return [];
    }
    if (down) {
      down = false;
      out.info("engine registry readable again");
    }
    const live = names.flatMap(file => {
      const m = FILE_PID.exec(file);
      if (!m) return [];
      const pid = Number(m[1]);
      if (!alive(pid)) return [];
      return [{ file, pid }];
    });
    const reports = await Promise.all(live.map(async ({ file, pid }): Promise<LaneReport | null> => {
      let proc: ProcessIdentity | null;
      try { proc = await identity(pid); } catch { return null; }
      let text: string;
      try { text = await read(join(dir, file)); } catch { return null; }
      return parseEngineFile(text, pid, proc);
    }));
    return reports.filter((r): r is LaneReport => r !== null);
  };
}

// Unset, empty, `0` or `off` never reaches here: config already turned those into null. A fleet with no node name
// stays off, so this machine's registry is never matched to a worker on another machine.
export function engineLanesFor(c: { engineSessions?: string | null; engineNode?: string | null; fleetSocket?: string | null }): {
  lanes: LaneStatuses | null; engineNode: string | null; notice: string | null;
} {
  if (!c.engineSessions) return { lanes: null, engineNode: null, notice: null };
  if (c.fleetSocket && !c.engineNode) {
    return {
      lanes: null, engineNode: null,
      notice: "MORNDO_ENGINE_SESSIONS is set but MORNDO_ENGINE_NODE is not, so engine-lane status stays off while a fleet is in use",
    };
  }
  return { lanes: engineRegistry(c.engineSessions), engineNode: c.engineNode ?? null, notice: null };
}
