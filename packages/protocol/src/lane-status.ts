// A lane's status line (reliable lanes design §3.1): the first non-blank line of an answer says where the lane stands,
// `STATUS: DONE`, `STATUS: BLOCKED`, `STATUS: NEEDS DECISION`, or `STATUS: WAITING <on what> [for <N> min|h]`. The node's
// relay reads it to decide whether to ask for one, and the fleet reads it into lane events, so both read it here.
// Decoration around the word is allowed, as lane events always allowed it (`**STATUS: DONE**`, `- Status — blocked`).
// A line may also name its task key right after the word (`STATUS: DONE T-285`), which the board reads (B12).

export type TurnStatus = "done" | "blocked" | "needs_decision" | "waiting";
export type StatusLine = { status: TurnStatus; taskKey?: string; waitingOn?: string; forMs?: number };

// A wait is a lease of at most a day; a longer one is cut to a day.
export const WAIT_MAX_MS = 86_400_000;
const WAITING_ON_MAX = 120;

const STATUS_LINE = /^[\W_]*STATUS[\W_]*:?[\W_]*(DONE|BLOCKED|NEEDS DECISION|WAITING)\b(.*)$/i;
// B12: the task key, when the line names one right after the word: decoration, then T-<n>, then not a word character or
// hyphen. `T-285x`, `T-0` and `T-1234567890` name none, and a key anywhere else ("all of T-285") is not a name.
const KEY_AFTER_WORD = /^[\s*_`~:—–([-]*(T-[1-9]\d{0,8})(?![\w-])/i;
const FOR = /\bfor\s+(\d{1,5})\s*(minutes|minute|mins|min|m|hours|hour|hrs|hr|h)\b/i;

// The first non-blank line of a text, trimmed, at most 200 characters (the rule lane events have always used).
export const firstLineOf = (text: string): string => (text.split("\n").find(l => l.trim()) ?? "").trim().slice(0, 200);

// The status a line states, or null when it states none.
export function statusLineOf(line: string): StatusLine | null {
  const m = STATUS_LINE.exec(line);
  if (!m) return null;
  const word = (m[1] ?? "").toUpperCase();
  const k = KEY_AFTER_WORD.exec(m[2] ?? "");
  const taskKey = k ? (k[1] ?? "").toUpperCase() : undefined;
  if (word === "DONE") return { status: "done", ...(taskKey ? { taskKey } : {}) };
  if (word === "BLOCKED") return { status: "blocked", ...(taskKey ? { taskKey } : {}) };
  if (word !== "WAITING") return { status: "needs_decision", ...(taskKey ? { taskKey } : {}) };
  // The key is not part of what the wait is on.
  const rest = (k ? (m[2] ?? "").slice(k[0].length) : (m[2] ?? "")).replace(/^[\s*_`~:—–-]+/u, "");
  const f = FOR.exec(rest);
  let forMs: number | undefined;
  if (f) {
    const n = Number(f[1]);
    const unit = (f[2] ?? "").toLowerCase();
    forMs = Math.min(WAIT_MAX_MS, n * (unit.startsWith("h") ? 3_600_000 : 60_000));
  }
  const on = (f ? rest.slice(0, f.index) + rest.slice(f.index + f[0].length) : rest)
    .trim().replace(/^on\s+/i, "").replace(/[\s*_`~,;.:—–-]+$/u, "").trim().slice(0, WAITING_ON_MAX);
  return { status: "waiting", ...(taskKey ? { taskKey } : {}), ...(on ? { waitingOn: on } : {}), ...(forMs ? { forMs } : {}) };
}
