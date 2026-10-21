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

// B6 (board T-306): two live session files can name one pane — a headless `claude -p` run started inside the lane inherits
// its TMUX_PANE and writes its own file — and whichever file readdirSync happens to list last must not decide who owns the
// pane: the lane's own Stop is judged against it (window-of.ts foreignStop), and a headless winner would leave the lane
// never reporting done. Rank before age: an entrypoint that does not start with "sdk" (the lane's own, "cli") beats one
// that does (a headless "sdk-cli", younger than the lane that started it); among equals the earlier startedAt (a missing
// or non-numeric one is later than any number); a final tie the smaller sessionId.
type PaneCandidate = { info: SessionInfo; sdk: boolean; startedAt: number };
const outranks = (a: PaneCandidate, b: PaneCandidate) =>
  a.sdk !== b.sdk ? b.sdk : a.startedAt !== b.startedAt ? a.startedAt < b.startedAt : a.info.sessionId < b.info.sessionId;

export function sessionRegistry(configDir: string) {
  const dir = join(configDir, "sessions");
  const transcripts = new Map<string, string>();
  return {
    // pane ID ("%3") → the live session in it
    byPane(): Map<string, SessionInfo> {
      const out = new Map<string, PaneCandidate>();
      if (!existsSync(dir)) return new Map();
      let files: string[];
      try { files = readdirSync(dir); } catch { return new Map(); }   // not a directory, or not ours to read: no sessions
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
        const cand: PaneCandidate = {
          info, sdk: text(d.entrypoint).startsWith("sdk"),
          startedAt: typeof d.startedAt === "number" && Number.isFinite(d.startedAt) ? d.startedAt : Number.POSITIVE_INFINITY,
        };
        if (!prev || outranks(cand, prev)) out.set(pane, cand);
      }
      return new Map([...out].map(([pane, c]) => [pane, c.info]));
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
