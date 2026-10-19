// Anti-corruption adapter over the engine layer's lane registry (ADR-0030), read-only, on this machine. A lane of another
// engine (Codex, Cursor, ...) runs `engine-lane` in its tmux window and records itself in
// $ENGINES_SESSIONS/<pid>.json (default ~/.local/share/engines/sessions), written by the engine layer's lane.py
// `_save_registry`, checked against its commit 683a7c9 (2026-10-16). The shape is the engine layer's own, so the contract
// tests use a synthetic file of it (test/fixtures/engine-lane/session-file.json).
// - Any process of the user can write a file there, so a file counts only for a live engine-lane: its `pidStartTicks` and
//   `bootId` must be there and match the process now (a file without them, or a pid another process took, is no lane).
// - It names no tmux pane, so a lane is found by being the foreground job of a pane's terminal: its process group is the
//   foreground group (tpgid) of the pane's process. A lane stopped with Ctrl-Z, or started with `&`, is not: the pane is the
//   shell's then, and text must never be typed into a shell as if it were the lane. Linux's /proc only; where it has no entry
//   for a process, the process is gone (nothing is spawned to ask again).
// - `sessionId` in the file is the lane's own id until the engine names a session, then the engine's, and the lane's again
//   after /clear. The fleet binds a delivery to the session it was queued for and gives it up when another takes the lane's
//   name, so a lane that renamed its session would lose every delivery waiting while a turn ran. The id reported here is the
//   lane's process (pid and start): the same for the life of the `engine-lane`, another for a lane started in its place. The
//   file's ids are kept as `aliases`, which is what the lane's hooks name (relay/window-of.ts).
// - `transcript` is a path in a file anyone can write. It is served only when its real path (links followed) is a `.jsonl`
//   file inside the engine layer's transcript directory.
// - `status` is busy or idle.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { SESSION_STATUSES, type SessionStatus } from "@morndo/protocol";
import { procGroups, processAlive, processIdentity, type ProcessIdentity } from "./pid.ts";
import type { SessionInfo } from "./sessions.ts";

const STATUSES = new Set<string>(SESSION_STATUSES);
const text = (v: unknown, otherwise = "") => (typeof v === "string" ? v : otherwise);
const RESCAN_MS = 1000;                                                // an unknown lane id is looked for again at most this often, per id
const ROOT_KEEP_MS = 30_000;
const ASKED_MAX = 256;                                                 // ids remembered as asked for; more than this and the list starts over

export type EngineSessionIo = {
  transcripts: string;                                                 // the engine layer's transcript directory
  alive?: (pid: number) => boolean;
  identity?: (pid: number) => ProcessIdentity | null;
  groups?: (pid: number) => { pgrp: number; tpgid: number } | null;
  now?: () => number;
};

// Pane ID ("%3") → the pid of the process the pane runs.
export type PanePids = ReadonlyMap<string, number>;

type Lane = { info: Omit<SessionInfo, "pane">; updatedAt: number };

export function engineSessionRegistry(dir: string, io: EngineSessionIo) {
  const alive = io.alive ?? processAlive;
  const identity = io.identity ?? ((pid: number) => processIdentity(pid));
  const groups = io.groups ?? ((pid: number) => procGroups(pid));
  const now = io.now ?? (() => performance.now());
  let candidates = new Map<string, string>();                          // lane id → the transcript path its file names
  // lane id → every sessionId its file has had, and in how many scans in a row it was not found. It is forgotten when its process is
  // dead, or when two scans in a row miss it: one failed read (a /proc entry that can't be read, say) must not lose its earlier ids.
  const aliases = new Map<string, { pid: number; ids: Set<string>; misses: number }>();
  let root: { real: string; at: number } | null = null;                // the transcript directory's real path, kept for ROOT_KEEP_MS
  const asked = new Map<string, number>();                             // unknown lane id → when the registry was last read for it

  function lanes(): Lane[] {
    const found = new Map<string, string>();
    const out: Lane[] = [];
    let files: string[] = [];
    if (existsSync(dir)) { try { files = readdirSync(dir); } catch { files = []; } }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      let d: Record<string, unknown>;
      try { d = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
      if (d === null || typeof d !== "object") continue;
      const pid = Number(d.pid);
      if (!alive(pid)) continue;
      const ticks = d.pidStartTicks;
      const boot = d.bootId;
      if (typeof ticks !== "number" || typeof boot !== "string") continue;       // not written by a lane: no identity to check
      const live = identity(pid);
      if (live === null || live.ticks !== ticks || live.bootId !== boot) continue;  // unreadable, or another process holds the pid now
      const sessionId = `engine-${pid}-${ticks}`;
      if (typeof d.transcript === "string" && d.transcript) found.set(sessionId, d.transcript);
      const seen = aliases.get(sessionId) ?? { pid, ids: new Set<string>(), misses: 0 };
      if (typeof d.sessionId === "string") seen.ids.add(d.sessionId);
      seen.misses = 0;
      aliases.set(sessionId, seen);
      out.push({
        updatedAt: Number(d.updatedAt ?? 0),
        info: {
          sessionId, name: typeof d.name === "string" ? d.name : null, cwd: text(d.cwd), version: null, pid,
          status: typeof d.status === "string" && STATUSES.has(d.status) ? d.status as SessionStatus : null,
          ...(typeof d.engine === "string" && d.engine ? { engine: d.engine } : {}),
          aliases: [...seen.ids],
        },
      });
    }
    candidates = found;
    const present = new Set(out.map(l => l.info.sessionId));
    for (const [id, a] of aliases) {
      if (present.has(id)) continue;
      if (!alive(a.pid) || ++a.misses >= 2) aliases.delete(id);
    }
    return out;
  }

  return {
    // pane ID → the live lane that is the foreground job of its terminal; the lane written last wins a pane two lanes share
    byPane(panes: PanePids): Map<string, SessionInfo> {
      const foreground = new Map<number, string>();                    // a terminal's foreground group → its pane
      for (const [pane, pid] of panes) {
        const g = groups(pid);
        if (g !== null && g.tpgid > 0) foreground.set(g.tpgid, pane);
      }
      const out = new Map<string, SessionInfo>();
      const at = new Map<string, number>();
      for (const lane of lanes()) {
        const g = groups(lane.info.pid);
        const pane = g === null ? undefined : foreground.get(g.pgrp);
        if (pane === undefined || lane.updatedAt < (at.get(pane) ?? Number.NEGATIVE_INFINITY)) continue;
        at.set(pane, lane.updatedAt);
        out.set(pane, { ...lane.info, pane });
      }
      return out;
    },
    // The lane's transcript, only when it is a transcript of the engine layer (its real path is a .jsonl file inside the
    // transcript directory); looked up again every time, so a link swapped after the lane was read is not followed.
    transcriptPath(sessionId: string): string | null {
      if (!sessionId.startsWith("engine-")) return null;
      if (!candidates.has(sessionId)) {
        const last = asked.get(sessionId);
        if (last === undefined || now() - last >= RESCAN_MS) {
          if (asked.size >= ASKED_MAX) asked.clear();
          asked.set(sessionId, now());
          lanes();
        }
      }
      const path = candidates.get(sessionId);
      if (path === undefined) return null;
      try {
        if (root === null || now() - root.at >= ROOT_KEEP_MS) root = { real: realpathSync(io.transcripts), at: now() };
        const real = realpathSync(path);
        return real.startsWith(root.real + sep) && real.endsWith(".jsonl") && statSync(real).isFile() ? real : null;
      } catch { return null; }
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
