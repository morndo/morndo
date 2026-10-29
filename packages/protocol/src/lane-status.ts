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
// B12: the task key, when the line names one right after the word: decoration, brackets or quotes, then T-<n>, then not a word character or
// hyphen. `T-285x`, `T-0` and `T-1234567890` name none, and a key anywhere else ("all of T-285") is not a name.
const KEY_AFTER_WORD = /^[\s*_`~:—–(["'“”‘’-]*(T-[1-9]\d{0,8})(?![\w-])[\])"'`”’]?/i;
// How a WAITING line says how long it waits (lane stalls, 2026-10-28): the phrase starts at `for`, a comma or an open
// parenthesis, may carry a qualifier, and needs a unit right after its number, so a number that is not a duration
// ("main CI for 2331eef", "PR 1121 CI, run 39841853073") reads none. Of 723 WAITING lines in nine days, 198 named one
// the `for <N> min` rule did not read: "for about 25 min", "for ~20 min", ", about 265 min", "(about 7 min)",
// "for up to 60 min", "for 20+ min". A range's upper end counts, and so does a trailing `+`.
// The line's own `for` duration wins (the contract's own form, "STATUS: WAITING <on what> for <N> min"): a number with
// a unit earlier in the line describes the work ("12 shards (5 min each) for 1 h"), so a comma or parenthesis one is
// read only when the line has no `for` one.
const QUALIFIER = String.raw`(?:approximately|approx\.|roughly|around|another|about|up\s+to|at\s+most|~|≈|max\b)?`;
const NUMBER = String.raw`(\d{1,6}(?:\.\d+)?)`;
const AMOUNT = String.raw`${NUMBER}\s*(?:[–-]\s*${NUMBER})?\s*\+?\s*(minutes|minute|mins|min|m|hours|hour|hrs|hr|h)\b\)?`;
const DURATION_FOR = new RegExp(String.raw`\bfor\b\s*${QUALIFIER}\s*${AMOUNT}`, "i");
const DURATION_ELSEWHERE = new RegExp(String.raw`[,(]\s*${QUALIFIER}\s*${AMOUNT}`, "i");

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
  const d = DURATION_FOR.exec(rest) ?? DURATION_ELSEWHERE.exec(rest);
  let forMs: number | undefined;
  if (d) {
    const n = Number(d[2] ?? d[1] ?? 0);                // a range ("5–10 min") waits its upper end
    const unit = (d[3] ?? "").toLowerCase();
    forMs = Math.min(WAIT_MAX_MS, n * (unit.startsWith("h") ? 3_600_000 : 60_000));
  }
  const on = (d ? rest.slice(0, d.index) + rest.slice(d.index + d[0].length) : rest)
    // The trailing decoration a bold or italic line leaves goes; a backtick stays, since it closes a code span.
    .trim().replace(/^on\s+/i, "").replace(/[\s*_~,;.:—–-]+$/u, "").trim().slice(0, WAITING_ON_MAX);
  return { status: "waiting", ...(taskKey ? { taskKey } : {}), ...(on ? { waitingOn: on } : {}), ...(forMs ? { forMs } : {}) };
}

// A wait's lease (lane stalls, 2026-10-28): the lane's own estimate times 1.5 plus 10 minutes, at most a day. Lanes
// under-declare — of 575 waits, actual/declared was p50 0.4, p90 1.05, p95 1.31 — so the declared time alone expired
// before the lane's own next turn in 96 of them and x1.5 plus 10 minutes in 8.
export function waitLeaseMs(forMs: number): number {
  return Math.min(WAIT_MAX_MS, Math.round(forMs * 1.5) + 10 * 60_000);
}
