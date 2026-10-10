// Chats (ADR-0011; H1–H6 in docs/domain.md): the phone as a chat app. Which messages count as unread, the chat list's
// order, a lane's status in one line, when he was away long enough for a digest, and how the digest sorts its lines.
// A read side over Observation, Reading and Escalation: nothing here moves a mark, answers an Ask or starts a timer.
// Words are the app's: this module classifies and orders, and hands over the message a line is made from.
import { statusOf } from "./catchup.ts";
import type { Message } from "./conversation.ts";
import type { WorkerState } from "./observation.ts";

// The plumbing a conversation never shows: tool calls and the system's own events (compaction, lane events).
const plumbing = (m: Message) => m.kind === "activity" || (m.kind === "event" && m.author.kind === "system");
const agentWords = (m: Message) => m.author.kind === "agent" && m.kind === "text" && m.text.trim().length > 0;

// H1: what counts as unread after `mark`: an answer that ends a turn (the agent's last words before the next prompt, his
// or a peer's, and its latest words so far), a question, a file sent to him. Narration in the middle of a turn, tool
// calls, prompts and plumbing never count, so a lane that works for an hour is one unread, not forty.
export function mattering(messages: readonly Message[], mark: number | null): number {
  let n = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Message;
    if (m.at <= (mark ?? 0) || m.author.kind !== "agent") continue;
    if (m.kind === "question" || m.kind === "file") { n++; continue; }
    if (!agentWords(m)) continue;
    // The turn's last words: no later words of the agent before the next prompt (or the end).
    let last = true;
    for (let j = i + 1; j < messages.length; j++) {
      const x = messages[j] as Message;
      if (x.author.kind === "principal" || x.author.kind === "peer") break;
      if (agentWords(x)) { last = false; break; }
    }
    if (last) n++;
  }
  return n;
}

// The newest message a chat row previews (words, a question, a file, an event of his), and the agent's latest words.
export const lastShown = (messages: readonly Message[]): Message | null => messages.findLast(m => !plumbing(m)) ?? null;
export const latestAnswer = (messages: readonly Message[]): Message | null => messages.findLast(agentWords) ?? null;

// H2: the manager pinned first; then the newest activity on top; a lane that never spoke last; ties by name.
export function chatOrder<T extends { name: string; lastAt: number | null }>(rows: readonly T[], manager: string): T[] {
  return [...rows].sort((a, b) => Number(b.name === manager) - Number(a.name === manager)
    || (b.lastAt ?? -1) - (a.lastAt ?? -1) || a.name.localeCompare(b.name));
}

// H3 and H5's one rule for a report: it waits for him while it says STATUS: NEEDS DECISION and he hasn't written to the
// lane since (validated review finding #4: the digest had its own copy of the rule, without the second half).
export const reportWaits = (answer: Message, repliedAt: number | null) => statusOf(answer.text).status === "decision" && !((repliedAt ?? -1) > answer.at);

// H3: a lane in one line: whether it waits for him (an open Ask of its own, its last report saying NEEDS DECISION and
// not answered by him since, or a
// prompt on its screen), else what it is
// doing (its screen moves), else how its last answer ended by its own word ("STATUS: DONE" is a claim, never a check:
// V1). `since`: the oldest open Ask, else when its state last changed.
export type LaneStatusKind = "waits" | "working" | "finished" | "blocked" | "idle";
export type LaneStatus = { kind: LaneStatusKind; since: number; ask: string | null; answer: Message | null };
export function laneStatus(l: {
  state: WorkerState; changedAt: number; needsYou: boolean; asks: readonly { title: string; askedAt: number }[]; answer: Message | null;
  repliedAt?: number | null;                             // his latest message to it, if any
}): LaneStatus {
  const oldest = [...l.asks].sort((a, b) => a.askedAt - b.askedAt)[0];
  if (oldest) return { kind: "waits", since: oldest.askedAt, ask: oldest.title, answer: l.answer };
  const said = l.answer ? statusOf(l.answer.text).status : null;
  // Its own last report asks for his call (STATUS: NEEDS DECISION): waiting since that report, as the digest counts it.
  // Answered by him since (review, 2026-10-05): no longer waiting, without waiting for its next report.
  if (l.answer && reportWaits(l.answer, l.repliedAt ?? null)) return { kind: "waits", since: l.answer.at, ask: null, answer: l.answer };
  if (l.needsYou) return { kind: "waits", since: l.changedAt, ask: null, answer: l.answer };
  if (l.state === "active") return { kind: "working", since: l.changedAt, ask: null, answer: l.answer };
  const kind: LaneStatusKind = said === "done" ? "finished" : said === "blocked" || said === "failed" ? "blocked" : "idle";
  return { kind, since: l.changedAt, ask: null, answer: l.answer };
}

// H4: when he comes back, a digest of what happened shows only if he was away from every device long enough. `here`:
// his last activity on this device; `elsewhere`: on any other, as the hub last said. Nothing known: no digest. The
// setting is his, per device; "overnight" needs a night in between (`night`, from the device's own calendar) and at
// least 3 hours.
export const AWAY_CHOICES = { "2h": 2 * 3_600_000, "4h": 4 * 3_600_000, "8h": 8 * 3_600_000, overnight: 3 * 3_600_000, never: Infinity } as const;
export type AwaySetting = keyof typeof AWAY_CHOICES;
export const DEFAULT_AWAY: AwaySetting = "4h";
export const parseAway = (v: unknown): AwaySetting => (typeof v === "string" && Object.hasOwn(AWAY_CHOICES, v) ? v as AwaySetting : DEFAULT_AWAY);
export function isAway(a: {
  here: number | null; elsewhere: number | null; now: number; setting: AwaySetting; night: (from: number, to: number) => boolean;
}): { away: true; since: number } | { away: false } {
  const last = Math.max(a.here ?? -1, a.elsewhere ?? -1);
  if (last < 0 || a.setting === "never") return { away: false };
  if (a.now - last < AWAY_CHOICES[a.setting]) return { away: false };
  if (a.setting === "overnight" && !a.night(last, a.now)) return { away: false };
  return { away: true, since: last };
}

// H5: the digest, one line per lane that spoke since he left or needs him now: needs you (an open Ask, or a prompt on
// its screen), blocked (its last answer said BLOCKED or FAILED), finished (said DONE), then working (it said something
// else), most recent first within each; the manager's line first whatever it says. Muted lanes are left out by the
// caller (C4), as catch-up does.
export type DigestKind = "needs_you" | "blocked" | "finished" | "working";
export type DigestLine = {
  worker: string; name: string; kind: DigestKind; ask: string | null; answer: Message | null;
  count: number; tools: number; files: number; lastAt: number | null;
};
const RANK: Record<DigestKind, number> = { needs_you: 0, blocked: 1, finished: 2, working: 3 };
// `tools` and `files`: the counts when the messages given leave tool calls out (the hub's catch-up lists words only).
export function digestLines(conversations: readonly {
  worker: string; name: string; messages: readonly Message[]; needsYou: boolean; asks: readonly string[]; tools?: number; files?: number; lastAt?: number | null;
}[], manager: string): DigestLine[] {
  const out: DigestLine[] = [];
  for (const c of conversations) {
    const answer = latestAnswer(c.messages);
    const ask = c.asks[0] ?? null;
    if (!c.messages.length && !ask && !c.needsYou) continue;
    const said = answer ? statusOf(answer.text).status : null;
    const replied = c.messages.findLast(m => m.author.kind === "principal")?.at ?? null;
    const waits = !!answer && reportWaits(answer, replied);
    const kind: DigestKind = ask || c.needsYou || waits ? "needs_you" : said === "blocked" || said === "failed" ? "blocked" : said === "done" ? "finished" : "working";
    let tools = 0, files = 0;
    for (const m of c.messages) { tools += m.tools?.length ?? 0; if (m.author.kind !== "principal") files += m.attachments?.length ?? 0; }
    out.push({
      worker: c.worker, name: c.name, kind, ask, answer, count: mattering(c.messages, null),
      tools: c.tools ?? tools, files: c.files ?? files, lastAt: c.lastAt !== undefined ? c.lastAt : c.messages.at(-1)?.at ?? null,
    });
  }
  return out.sort((a, b) => Number(b.name === manager) - Number(a.name === manager) || RANK[a.kind] - RANK[b.kind]
    || (b.lastAt ?? -1) - (a.lastAt ?? -1) || a.name.localeCompare(b.name));
}
