// A lane's status line (reliable lanes design §3.1): the first non-blank line of an answer says where the lane stands,
// `STATUS: DONE`, `STATUS: BLOCKED`, `STATUS: NEEDS DECISION`, or `STATUS: WAITING <on what> [for <N> min|h]`. The node's
// relay reads it to decide whether to ask for one, and the fleet reads it into lane events, so both read it here.
// Decoration around the word is allowed, as lane events always allowed it (`**STATUS: DONE**`, `- Status — blocked`).

export type TurnStatus = "done" | "blocked" | "needs_decision" | "waiting";
export type StatusLine = { status: TurnStatus; waitingOn?: string; forMs?: number };

// A wait is a lease of at most a day; a longer one is cut to a day.
export const WAIT_MAX_MS = 86_400_000;
const WAITING_ON_MAX = 120;

const STATUS_LINE = /^[\W_]*STATUS[\W_]*:?[\W_]*(DONE|BLOCKED|NEEDS DECISION|WAITING)\b(.*)$/i;
const FOR = /\bfor\s+(\d{1,5})\s*(minutes|minute|mins|min|m|hours|hour|hrs|hr|h)\b/i;

// The first non-blank line of a text, trimmed, at most 200 characters (the rule lane events have always used).
export const firstLineOf = (text: string): string => (text.split("\n").find(l => l.trim()) ?? "").trim().slice(0, 200);

// The status a line states, or null when it states none.
export function statusLineOf(line: string): StatusLine | null {
  const m = STATUS_LINE.exec(line);
  if (!m) return null;
  const word = (m[1] ?? "").toUpperCase();
  if (word === "DONE") return { status: "done" };
  if (word === "BLOCKED") return { status: "blocked" };
  if (word !== "WAITING") return { status: "needs_decision" };
  const rest = (m[2] ?? "").replace(/^[\s*_`~:—–-]+/u, "");
  const f = FOR.exec(rest);
  let forMs: number | undefined;
  if (f) {
    const n = Number(f[1]);
    const unit = (f[2] ?? "").toLowerCase();
    forMs = Math.min(WAIT_MAX_MS, n * (unit.startsWith("h") ? 3_600_000 : 60_000));
  }
  const on = (f ? rest.slice(0, f.index) + rest.slice(f.index + f[0].length) : rest)
    .trim().replace(/^on\s+/i, "").replace(/[\s*_`~,;.:—–-]+$/u, "").trim().slice(0, WAITING_ON_MAX);
  return { status: "waiting", ...(on ? { waitingOn: on } : {}), ...(forMs ? { forMs } : {}) };
}
