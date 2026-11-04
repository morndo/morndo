// A lane's status line (reliable lanes design §3.1): the first non-blank line of an answer says where the lane stands,
// `STATUS: DONE`, `STATUS: BLOCKED`, `STATUS: NEEDS DECISION`, or `STATUS: WAITING <on what> [for <N> min|h]`. The node's
// relay reads it to decide whether to ask for one, and the fleet reads it into lane events, so both read it here.
// Decoration around the word is allowed, as lane events always allowed it (`**STATUS: DONE**`, `- Status — blocked`).
// A line may also name its task key right after the word (`STATUS: DONE T-285`), which the board reads (B12).
// B22: a line may end with `next: <who> by <when>` — who owes the next move on the task (the owner, the manager, a
// lane, a task key) and by when (a date, an instant with its offset, or `in <N> min|h`, resolved against the run the
// line rode in on, not read here). Anything that does not parse leaves `next` absent and the line as it was.

export type TurnStatus = "done" | "blocked" | "needs_decision" | "waiting";
export type StatusLine = { status: TurnStatus; taskKey?: string; waitingOn?: string; forMs?: number; next?: { who: string; by: { at: number } | { inMs: number } } };

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

// B22: the trailing `next: <who> by <when>`. The clause ends the line; `who` is a task key (any case, read upper) or a
// lowercase name — the owner, the manager, a lane; a capital outside a task key is nobody's name, and a space is not
// allowed in one. `when` is a date (that day's end, 23:59 UTC), an instant with Z or an offset (whose day and minute
// must be real: 2026-13-45 is no date), or `in <N> min|h` with N from 1 to 999999.
const NEXT_CLAUSE = /[\s,;]*\bnext\b\s*:\s*([A-Za-z0-9][A-Za-z0-9-]{0,31})\s+by\s+(.+)$/i;
const NEXT_KEY = /^T-[1-9]\d{0,8}$/i;
const NEXT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NEXT_IN = /^in ([1-9]\d{0,5}) (minutes|mins|min|hours|hour|hrs|hr|h)$/i;
const NEXT_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const NEXT_AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
// Date.parse rolls an impossible date over (2027-02-31 is read as 3 March), so the parts are checked themselves, as
// the board's own time wait does (board-waits.ts realDate).
const realDay = (y: number, mo: number, d: number) => mo >= 1 && mo <= 12 && d >= 1 && d === new Date(Date.UTC(y, mo - 1, d)).getUTCDate();

// The `when` of a next clause, or null when it is none of its three forms.
function nextWhen(s: string): { at: number } | { inMs: number } | null {
  const t = s.trim();
  const at = NEXT_AT.exec(t);
  if (at !== null) {
    const [y, mo, d, h, mi, se] = [at[1], at[2], at[3], at[4], at[5], at[6]].map(Number);
    if (!realDay(y, mo, d) || h > 23 || mi > 59 || (se ?? 0) > 59) return null;
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? { at: ms } : null;
  }
  const day = NEXT_DAY.exec(t);
  if (day !== null) {
    const [y, mo, d] = [day[1], day[2], day[3]].map(Number);
    return realDay(y, mo, d) ? { at: Date.parse(`${t}T23:59:00Z`) } : null;
  }
  const fromNow = NEXT_IN.exec(t);
  if (fromNow !== null) {
    const unit = (fromNow[2] ?? "").toLowerCase();
    return { inMs: Number(fromNow[1]) * (unit.startsWith("h") ? 3_600_000 : 60_000) };
  }
  return null;
}

// B22: the clause off a line's tail — the `next` it states and the tail without it — or the tail untouched when any
// part of it does not parse: the words are then prose, and a WAITING line's on-what keeps them.
const nextOf = (tail: string): { text: string; next?: StatusLine["next"] } => {
  const m = NEXT_CLAUSE.exec(tail);
  if (m === null) return { text: tail };
  const raw = m[1] ?? "";
  const who = NEXT_KEY.test(raw) ? raw.toUpperCase() : NEXT_NAME.test(raw) ? raw : null;
  const by = who === null ? null : nextWhen(m[2] ?? "");
  if (who === null || by === null) return { text: tail };
  return { text: tail.slice(0, m.index), next: { who, by } };
};

// The first non-blank line of a text, trimmed, at most 200 characters (the rule lane events have always used).
export const firstLineOf = (text: string): string => (text.split("\n").find(l => l.trim()) ?? "").trim().slice(0, 200);

// The status a line states, or null when it states none.
export function statusLineOf(line: string): StatusLine | null {
  const m = STATUS_LINE.exec(line);
  if (!m) return null;
  const word = (m[1] ?? "").toUpperCase();
  const tail = nextOf(m[2] ?? "");
  const next = tail.next === undefined ? {} : { next: tail.next };
  const k = KEY_AFTER_WORD.exec(tail.text);
  const taskKey = k ? (k[1] ?? "").toUpperCase() : undefined;
  if (word === "DONE") return { status: "done", ...(taskKey ? { taskKey } : {}), ...next };
  if (word === "BLOCKED") return { status: "blocked", ...(taskKey ? { taskKey } : {}), ...next };
  if (word !== "WAITING") return { status: "needs_decision", ...(taskKey ? { taskKey } : {}), ...next };
  // The key is not part of what the wait is on; neither is the next clause, already taken off the tail above.
  const rest = (k ? tail.text.slice(k[0].length) : tail.text).replace(/^[\s*_`~:—–-]+/u, "");
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
  return { status: "waiting", ...(taskKey ? { taskKey } : {}), ...(on ? { waitingOn: on } : {}), ...(forMs ? { forMs } : {}), ...next };
}

// A wait's lease (lane stalls, 2026-10-28): the lane's own estimate times 1.5 plus 10 minutes, at most a day. Lanes
// under-declare — of 575 waits, actual/declared was p50 0.4, p90 1.05, p95 1.31 — so the declared time alone expired
// before the lane's own next turn in 96 of them and x1.5 plus 10 minutes in 8.
export function waitLeaseMs(forMs: number): number {
  return Math.min(WAIT_MAX_MS, Math.round(forMs * 1.5) + 10 * 60_000);
}
