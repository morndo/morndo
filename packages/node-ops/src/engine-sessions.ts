// Anti-corruption adapter over the engine layer's lane registry (ADR-0030), read-only, on this machine. A lane of another
// engine (Codex, Cursor, ...) runs `engine-lane` in its tmux window and records itself in
// $ENGINES_SESSIONS/<pid>.json (default ~/.local/share/engines/sessions), written by the engine layer's lane.py
// `_save_registry`, checked against its commit 683a7c9 (2026-10-16). The shape is the engine layer's own, so the contract
// tests use a synthetic file of it (test/fixtures/engine-lane/session-file.json). Unlike Claude Code's file it names no tmux
// pane, so a lane is found by its process being inside a pane's: the pane process is the lane or an ancestor of it.
// - `sessionId` in the file is the lane's own id until the engine names a session, then the engine's, and the lane's again
//   after /clear. The fleet binds a delivery to the session it was queued for and gives it up when another takes the lane's
//   name, so a lane that renamed its session would lose every delivery waiting while a turn ran. The id reported here is the
//   lane's process (pid and start): the same for the life of the `engine-lane`, another for a lane started in its place.
// - `pidStartTicks` and `bootId` tell the process the file is about from one that took its pid later (a file left by a
//   killed lane); a file without them is taken on the process being alive.
// - `status` is busy or idle; `transcript` is the lane's own transcript, one JSON line per record.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SESSION_STATUSES, type SessionStatus } from "@morndo/protocol";
import { parentPid, processAlive, processIdentity, type ProcessIdentity } from "./pid.ts";
import type { SessionInfo } from "./sessions.ts";

const MAX_DEPTH = 32;                                                  // process ancestors looked at, from the lane up
const STATUSES = new Set<string>(SESSION_STATUSES);
const text = (v: unknown, otherwise = "") => (typeof v === "string" ? v : otherwise);

export type EngineSessionIo = {
  parentOf?: (pid: number) => number | null;
  alive?: (pid: number) => boolean;
  identity?: (pid: number) => ProcessIdentity | null;
};

// Pane ID ("%3") → the pid of the process the pane runs.
export type PanePids = ReadonlyMap<string, number>;

type Lane = { info: Omit<SessionInfo, "pane">; transcript: string; updatedAt: number };

export function engineSessionRegistry(dir: string, io: EngineSessionIo = {}) {
  const parentOf = io.parentOf ?? ((pid: number) => parentPid(pid));
  const alive = io.alive ?? processAlive;
  const identity = io.identity ?? ((pid: number) => processIdentity(pid));
  const transcripts = new Map<string, string>();

  function lanes(): Lane[] {
    if (!existsSync(dir)) return [];
    let files: string[];
    try { files = readdirSync(dir); } catch { return []; }
    const out: Lane[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      let d: Record<string, unknown>;
      try { d = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
      if (d === null || typeof d !== "object") continue;
      const pid = Number(d.pid);
      if (!alive(pid)) continue;
      const ticks = typeof d.pidStartTicks === "number" ? d.pidStartTicks : null;
      const boot = typeof d.bootId === "string" ? d.bootId : null;
      const now = ticks !== null && boot !== null ? identity(pid) : null;
      if (now !== null && (now.ticks !== ticks || now.bootId !== boot)) continue;      // another process holds the pid now
      const start = ticks ?? (typeof d.pidStartedAt === "number" ? d.pidStartedAt : typeof d.startedAt === "number" ? d.startedAt : 0);
      const sessionId = `engine-${pid}-${start}`;
      const transcript = text(d.transcript);
      if (transcript) transcripts.set(sessionId, transcript);
      out.push({
        updatedAt: Number(d.updatedAt ?? 0),
        transcript,
        info: {
          sessionId, name: typeof d.name === "string" ? d.name : null, cwd: text(d.cwd), version: null, pid,
          status: typeof d.status === "string" && STATUSES.has(d.status) ? d.status as SessionStatus : null,
          ...(typeof d.engine === "string" && d.engine ? { engine: d.engine } : {}),
        },
      });
    }
    return out;
  }

  return {
    // pane ID → the live lane in it; the lane written last wins a pane two lanes share
    byPane(panes: PanePids): Map<string, SessionInfo> {
      const paneOf = new Map<number, string>();
      for (const [pane, pid] of panes) paneOf.set(pid, pane);
      const out = new Map<string, SessionInfo>();
      const at = new Map<string, number>();
      for (const lane of lanes()) {
        let pid: number | null = lane.info.pid;
        let pane: string | undefined;
        for (let i = 0; i < MAX_DEPTH && pid !== null && pid > 1 && pane === undefined; i++) {
          pane = paneOf.get(pid);
          pid = pane === undefined ? parentOf(pid) : pid;
        }
        if (pane === undefined || lane.updatedAt < (at.get(pane) ?? Number.NEGATIVE_INFINITY)) continue;
        at.set(pane, lane.updatedAt);
        out.set(pane, { ...lane.info, pane });
      }
      return out;
    },
    transcriptPath(sessionId: string): string | null {
      if (!sessionId.startsWith("engine-")) return null;
      if (!transcripts.has(sessionId)) lanes();
      return transcripts.get(sessionId) ?? null;
    },
  };
}

// What the node reads sessions through: Claude Code's registry, and the engine layer's for the panes Claude Code holds none of.
// `panes` is the node's panes' process ids as the inventory last read them.
export type SessionSource = {
  byPane(panes?: PanePids): Map<string, SessionInfo>;
  transcriptPath(sessionId: string): string | null;
};

export function combineSessions(
  claude: { byPane(): Map<string, SessionInfo>; transcriptPath(sessionId: string): string | null },
  engines: { byPane(panes: PanePids): Map<string, SessionInfo>; transcriptPath(sessionId: string): string | null },
  panePids: () => PanePids,
): SessionSource {
  return {
    byPane(panes) {
      const out = claude.byPane();
      for (const [pane, info] of engines.byPane(panes ?? panePids())) if (!out.has(pane)) out.set(pane, info);
      return out;
    },
    transcriptPath: sessionId => claude.transcriptPath(sessionId) ?? engines.transcriptPath(sessionId),
  };
}
