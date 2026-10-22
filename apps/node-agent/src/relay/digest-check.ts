// The relay's other one question per turn (T-308): the reply style of the exempt lanes' digest and cards, the part the
// principal reads on his phone. The status ask (status-ask.ts) never asks the lanes in statusContract.exempt, the
// orchestrator; this ask asks only them, its counterpart. Same hook contract as the status ask
// (https://code.claude.com/docs/en/hooks, Stop decision control, read 2026-10-20): a {"decision":"block","reason"}
// answer keeps the turn going with the reason to act on, and stop_hook_active (true when the Stop was itself caused by
// a Stop hook) keeps it to once per turn, far below the cap of eight continuations in a row (same page). Unlike the
// status ask, background tasks and wake-ups do not stop it: a digest posted while something runs is still posted.
// What is checked is the visible part — the message with every closed <details>…</details> block removed (an unclosed
// one removes nothing) — of a digest (the lines after a "## Digest" or "### Digest" heading, up to the next heading of
// its level or above; a heading in a code fence is none) or a card (an answer whose last non-blank line is a
// "[buttons …]" line, read as kira reads it: manager-ui.ts parseAnswer); anything else is not asked. The not-live rule reads the
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

// A heading is ATX: up to three spaces, then hashes (CommonMark), and a fence is three or more backticks or tildes; a heading
// inside one is example text.
const DIGEST_HEADING = /^ {0,3}(#{2,3})\s+Digest\b/i;
const HEADING = /^ {0,3}(#{1,6})\s/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// kira's reading of the first and last things of an answer (manager-ui.ts parseAnswer): "[quiet]" first, any case, and a
// buttons line as the last non-empty line, trimmed, any case, with an id of its grammar. Not wider: what kira would not
// take as buttons is no card here.
const QUIET = /^\s*\[quiet\]\s*/i;
const BUTTONS = /^\[buttons\s+[A-Za-z0-9_-]{1,32}\]/i;
// A line that says work is finished, and, said of the task it names, whether it is already not live (that is honest): a
// candidate for the not-live rule.
const DONE_IN_LINE = /\b(done|merged|shipped|landed)\b/i;
const SAYS_NOT_LIVE = /\bnot\s+(yet\s+)?live\b/i;
// How a candidate names its task: a key, in any case, or a commit token.
const NAMES = /\bT-\d+\b|\b[0-9a-f]{7,40}\b/gi;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

// Which lines are in a fenced code block, the fences themselves included. A fence closes on the same character, at least as
// long, with nothing after it; one never closed runs to the end.
const fencedLines = (lines: string[]): boolean[] => {
  let open: { char: string; len: number } | null = null;
  return lines.map(line => {
    const m = FENCE.exec(line);
    if (open === null) {
      if (m === null || (m[1]![0] === "`" && m[2]!.includes("`"))) return false;
      open = { char: m[1]![0]!, len: m[1]!.length };
      return true;
    }
    if (m !== null && m[1]![0] === open.char && m[1]!.length >= open.len && m[2]!.trim() === "") open = null;
    return true;
  });
};

const lastNonBlank = (lines: string[]): number => {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.trim() !== "") return i;
  return -1;
};

// The digest or the card to check, or null when the answer is neither: a digest is its heading's lines up to the next
// heading of its level or above; a card is all its lines, a buttons line last. A buttons line, the last one, is no line.
const digestOrCard = (lines: string[]): { kind: "digest" | "card"; lines: string[] } | null => {
  const fenced = fencedLines(lines);
  const heading = lines.findIndex((l, i) => !fenced[i] && DIGEST_HEADING.test(l));
  let kind: "digest" | "card";
  let own: string[];
  if (heading !== -1) {
    const level = DIGEST_HEADING.exec(lines[heading]!)![1]!.length;
    const end = lines.findIndex((l, i) => i > heading && !fenced[i] && (HEADING.exec(l)?.[1]!.length ?? 7) <= level);
    kind = "digest";
    own = lines.slice(heading + 1, end === -1 ? undefined : end);
  } else {
    const last = lastNonBlank(lines);
    if (last === -1 || !BUTTONS.test(lines[last]!.trim())) return null;
    kind = "card";
    own = lines;
  }
  const last = lastNonBlank(own);
  return { kind, lines: last !== -1 && BUTTONS.test(own[last]!.trim()) ? own.filter((_, i) => i !== last) : own };
};

// The reason to send back, so tests compare it whole. One paragraph, whatever it names.
export function replyStyleReason(kind: "digest" | "card", problems: string[]): string {
  return `Your ${kind} is too long or too hard to read on a phone: ${problems.join("; ")}. Rewrite the visible part short `
    + "and plain (at most 8 lines and 120 words, no ticket numbers or hashes, nothing listed as done that is not live), keep "
    + "detail inside <details>...</details>, then send it again.";
}

// The not-live rule: a done line that names a task, by key or by commit, against the board's tasks whose merges are
// not live yet. A name is excused when the words "not live" follow it before the next name on the line (said of it, not of
// another task on the line). The board is read at most once per Stop, and only when some done line names something that is
// not excused; a board that can't be read (null) is no problem, and the task's key, not the token, is named.
async function notLiveProblem(lines: string[], notLiveOf: NotLiveOf | undefined): Promise<string | null> {
  if (notLiveOf === undefined) return null;
  const keys = new Set<string>();
  const commits: string[] = [];
  for (const line of lines.filter(l => DONE_IN_LINE.test(l))) {
    const names = [...line.matchAll(NAMES)];
    names.forEach((m, i) => {
      const said = line.slice(m.index + m[0].length, names[i + 1]?.index ?? line.length);
      if (SAYS_NOT_LIVE.test(said)) return;
      if (/^t-/i.test(m[0])) keys.add(m[0].toUpperCase());
      else commits.push(m[0].toLowerCase());
    });
  }
  if (keys.size === 0 && commits.length === 0) return null;
  const board = await notLiveOf();
  if (board === null) return null;
  const hit = new Set<string>();
  for (const task of board) {
    if (keys.has(task.key.toUpperCase()) || task.shas.some(sha => commits.some(c => sha.toLowerCase().startsWith(c)))) hit.add(task.key);
  }
  return hit.size === 0 ? null : `${[...hit].map(k => `"${k}"`).join(", ")} listed as done, but the board has the merge not live yet`;
}

// The reason to send back with {"decision":"block"}, or null when this Stop is not asked. The lines that count are the
// digest's or the card's own: blank lines, the buttons line, a leading [quiet] and the message's status line are not lines.
export async function replyStyleAsk(body: unknown, window: string | null, contract: StatusContract, notLiveOf?: NotLiveOf): Promise<string | null> {
  if (contract.mode !== "ask" || window === null || !contract.exempt.includes(window)) return null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.hook_event_name !== "Stop" || b.stop_hook_active === true) return null;
  if (typeof b.last_assistant_message !== "string") return null;
  const message = b.last_assistant_message.replace(QUIET, "");
  const what = digestOrCard(visible(message).split("\n"));
  if (what === null) return null;
  const statusFirst = statusLineOf(firstLineOf(message)) !== null ? firstLineOf(message).trim() : null;
  const kept = what.lines.filter(l => l.trim() !== "" && (statusFirst === null || l.trim() !== statusFirst));
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
