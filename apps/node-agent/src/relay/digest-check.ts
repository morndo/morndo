// The relay's other one question per turn (T-308): the reply style of the exempt lanes' digest and cards, the part the
// principal reads on his phone. The status ask (status-ask.ts) never asks the lanes in statusContract.exempt, the
// orchestrator; this ask asks only them, its counterpart. Same hook contract as the status ask
// (https://code.claude.com/docs/en/hooks, Stop decision control, read 2026-10-20): a {"decision":"block","reason"}
// answer keeps the turn going with the reason to act on, and stop_hook_active (true when the Stop was itself caused by
// a Stop hook) keeps it to once per turn, far below the cap of eight continuations in a row (same page). Unlike the
// status ask, background tasks and wake-ups do not stop it: a digest posted while something runs is still posted.
// What is checked is the visible part — the message with every closed <details>…</details> block removed (an unclosed
// one removes nothing) — of a digest (the lines after a "### Digest" heading, up to the next heading) or a card (an
// answer whose last non-blank line is a "[buttons …]" line); anything else is not asked. The not-live rule reads the
// hub's board, and a board that can't be read (null) skips only that rule, never blocks on it.
import { jargonIn } from "@morndo/domain";
import { firstLineOf, statusLineOf } from "@morndo/protocol";
import type { StatusContract } from "../config.ts";

export const DIGEST_MAX_LINES = 8;
export const DIGEST_MAX_WORDS = 120;

// The board's tasks whose morndo/morndo merge is recorded and not live (board-view.ts reads them): the task key and
// the shas of those merges.
export type NotLiveTask = { key: string; shas: string[] };
// null: the board could not be read (the not-live rule is skipped, never a block).
export type NotLiveOf = () => Promise<NotLiveTask[] | null>;

// The visible part: every closed <details> block, case-insensitive, however many lines it spans, removed; a block
// nested in one is removed with it, and an unclosed <details> removes nothing.
const DETAILS = /<details>[\s\S]*?<\/details>/gi;
const visible = (message: string): string => {
  let out = message;
  for (;;) {
    const next = out.replace(DETAILS, "");
    if (next === out) return out;
    out = next;
  }
};

const DIGEST_HEADING = /^#{3}\s+Digest\b/i;
const ANY_HEADING = /^#{1,3} /;
const BUTTONS_LINE = /^\[buttons\s+\S+\]/;
// A line that says work is finished, and does not already say it is not live (that line is honest): a candidate for
// the not-live rule.
const DONE_IN_LINE = /\b(done|merged|shipped|landed)\b/i;
const SAYS_NOT_LIVE = /\bnot\s+(yet\s+)?live\b/i;
// How a candidate names its task: a key, case-sensitive as a task key is written, or a commit token.
const TASK_KEY = /\bT-\d+\b/g;
const COMMIT = /\b[0-9a-f]{7,40}\b/gi;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

// The digest or the card to check, or null when the answer is neither: a digest is its heading's lines up to the next
// heading; a card is all its lines, a buttons line last.
const digestOrCard = (lines: string[]): { kind: "digest" | "card"; lines: string[] } | null => {
  const heading = lines.findIndex(l => DIGEST_HEADING.test(l));
  if (heading !== -1) {
    const end = lines.findIndex((l, i) => i > heading && ANY_HEADING.test(l));
    return { kind: "digest", lines: lines.slice(heading + 1, end === -1 ? undefined : end) };
  }
  let last: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.trim() !== "") { last = lines[i]!; break; }
  return last !== null && BUTTONS_LINE.test(last) ? { kind: "card", lines } : null;
};

// The reason to send back, so tests compare it whole. One paragraph, whatever it names.
export function replyStyleReason(kind: "digest" | "card", problems: string[]): string {
  return `Your ${kind} is too long or too hard to read on a phone: ${problems.join("; ")}. Rewrite the visible part short `
    + "and plain (at most 8 lines and 120 words, no ticket numbers or hashes, nothing listed as done that is not live), keep "
    + "detail inside <details>...</details>, then send it again.";
}

// The not-live rule: a done line that names a task, by key or by commit, against the board's tasks whose merges are
// not live yet. The board is read at most once per Stop, and only when some done line names something; a board that
// can't be read (null) is no problem, and the task's key, not the token, is named.
async function notLiveProblem(lines: string[], notLiveOf: NotLiveOf | undefined): Promise<string | null> {
  if (notLiveOf === undefined) return null;
  const keys = new Set<string>();
  const tokens: string[] = [];
  for (const l of lines.filter(l => DONE_IN_LINE.test(l) && !SAYS_NOT_LIVE.test(l))) {
    for (const k of l.match(TASK_KEY) ?? []) keys.add(k);
    for (const t of l.match(COMMIT) ?? []) tokens.push(t.toLowerCase());
  }
  if (keys.size === 0 && tokens.length === 0) return null;
  const board = await notLiveOf();
  if (board === null) return null;
  const hit = new Set<string>();
  for (const task of board) {
    if (keys.has(task.key) || task.shas.some(sha => tokens.some(t => sha.toLowerCase().startsWith(t)))) hit.add(task.key);
  }
  return hit.size === 0 ? null : `${[...hit].map(k => `"${k}"`).join(", ")} listed as done, but the board has the merge not live yet`;
}

// The reason to send back with {"decision":"block"}, or null when this Stop is not asked. The lines that count are the
// digest's or the card's own: blank lines, a buttons line, a lone [quiet] and the message's status line are not lines.
export async function replyStyleAsk(body: unknown, window: string | null, contract: StatusContract, notLiveOf?: NotLiveOf): Promise<string | null> {
  if (contract.mode !== "ask" || window === null || !contract.exempt.includes(window)) return null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.hook_event_name !== "Stop" || b.stop_hook_active === true) return null;
  if (typeof b.last_assistant_message !== "string") return null;
  const message = b.last_assistant_message;
  const what = digestOrCard(visible(message).split("\n"));
  if (what === null) return null;
  const statusFirst = statusLineOf(firstLineOf(message)) !== null ? firstLineOf(message) : null;
  const kept = what.lines.filter(l => l.trim() !== "" && !l.startsWith("[buttons ") && l !== "[quiet]" && (statusFirst === null || l.trim() !== statusFirst));
  const words = kept.reduce((n, l) => n + l.split(/\s+/).filter(t => LETTER_OR_DIGIT.test(t)).length, 0);
  const problems: string[] = [];
  if (kept.length > DIGEST_MAX_LINES) problems.push(`${kept.length} lines (the limit is ${DIGEST_MAX_LINES})`);
  if (words > DIGEST_MAX_WORDS) problems.push(`${words} words (the limit is ${DIGEST_MAX_WORDS})`);
  const jargon = [...new Set(jargonIn(kept.join("\n")))];
  if (jargon.length > 0) problems.push(`the jargon ${jargon.map(t => `"${t}"`).join(", ")} (say what it is in words)`);
  const notLive = await notLiveProblem(kept, notLiveOf);
  if (notLive !== null) problems.push(notLive);
  return problems.length === 0 ? null : replyStyleReason(what.kind, problems);
}
