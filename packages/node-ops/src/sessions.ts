// Anti-corruption adapter over Claude Code's session registry (ADR-0006), read-only, on this machine:
// - the registry ~/.claude/sessions/<pid>.json: which session runs in which tmux pane ("tmux": "main:@0.%0");
// - transcripts ~/.claude/projects/<dir>/<sessionId>.jsonl: where each session's transcript is.
// Both are internal ("The entry format is internal to Claude Code and changes between versions",
// https://code.claude.com/docs/en/sessions, 2026-10-01). Checked against Claude Code 2.1.286; the contract tests use
// synthetic fixtures of that shape. Moved from the hub's claude-sessions.ts (fleet core, Task 2); the transcript parser
// stays in the hub.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SESSION_STATUSES, type SessionStatus } from "@morndo/protocol";
import { processAlive } from "./pid.ts";

// A field of a vendor file that should be text: itself, else the default (an object never becomes "[object Object]").
const text = (v: unknown, otherwise = "") => (typeof v === "string" ? v : otherwise);

export const CHECKED_VERSION = "2.1.286";

// Claude Code's version as the fleet's hello and inventory carry it (a label of at most 200 characters, protocol/fleet.ts):
// a short printable token, else unknown. The file is Claude Code's, not ours, and one bad value must not keep a node offline.
const VERSION = /^[\x21-\x7e]{1,64}$/;

// `pid`: the process the file is named for, Claude Code's own. `status`: the session's state as Claude Code writes it
// (fleet clients §5; seen on 2.1.289 to 2.1.294: busy, idle, waiting, shell, the last while Claude Code runs a shell
// command); null for a value the protocol doesn't know. A file whose process is gone is no session at all (byPane).
// `engine`: set only for a lane of the engine layer (engine-sessions.ts), the name of the engine that runs it; `aliases`: the
// other ids the lane's own hooks name it by.
export type SessionInfo = { sessionId: string; name: string | null; pane: string; cwd: string; version: string | null; pid: number; status: SessionStatus | null; engine?: string; aliases?: string[] };
const STATUSES = new Set<string>(SESSION_STATUSES);

export function sessionRegistry(configDir: string) {
  const dir = join(configDir, "sessions");
  const transcripts = new Map<string, string>();
  return {
    // pane ID ("%3") → the live session in it
    byPane(): Map<string, SessionInfo> {
      const out = new Map<string, SessionInfo>();
      if (!existsSync(dir)) return out;
      let files: string[];
      try { files = readdirSync(dir); } catch { return out; }         // not a directory, or not ours to read: no sessions
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        let d: Record<string, unknown>;
        try { d = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
        if (d === null || typeof d !== "object") continue;            // e.g. a file holding `null`
        const pane = /(%\d+)$/.exec(text(d.tmux))?.[1];
        const pid = Number(d.pid);
        if (!pane || typeof d.sessionId !== "string" || !processAlive(pid)) continue;
        const prev = out.get(pane);
        const info: SessionInfo = {
          sessionId: d.sessionId, name: typeof d.name === "string" ? d.name : null, pane, pid,
          cwd: text(d.cwd), version: typeof d.version === "string" && VERSION.test(d.version) ? d.version : null,
          status: typeof d.status === "string" && STATUSES.has(d.status) ? d.status as SessionStatus : null,
        };
        if (!prev || Number(d.updatedAt ?? 0) > 0) out.set(pane, info);
      }
      return out;
    },
    transcriptPath(sessionId: string): string | null {
      const cached = transcripts.get(sessionId);
      if (cached && existsSync(cached)) return cached;
      const projects = join(configDir, "projects");
      if (!existsSync(projects)) return null;
      let dirs: string[];
      try { dirs = readdirSync(projects); } catch { return null; }
      for (const p of dirs) {
        const candidate = join(projects, p, `${sessionId}.jsonl`);
        if (existsSync(candidate)) { transcripts.set(sessionId, candidate); return candidate; }
      }
      return null;
    },
  };
}
