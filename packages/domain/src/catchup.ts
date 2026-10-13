// Catch-up (ADR-0009; C1–C7 in docs/domain.md): the principal works through what waits for his call and what happened
// since he last looked, one card at a time. A read side over Escalation (open Decisions) and Observation (Conversations
// past their Read mark). Nothing here answers, settles or delays an Ask, and nothing starts a timer (C6, as O8 and N5).
import type { Escalation } from "./escalation.ts";
import type { Message } from "./conversation.ts";
import type { WorkerId } from "./shared.ts";

// A worker's own word on its work: its last answer led with "STATUS: DONE". A check by someone else would be a Verdict
// (V1, V4), which the hub doesn't read; until it does, there is no "checked" state anywhere (product lane, 2026-10-04).
export type SaysDone = "says_done" | null;

// What a card needs to know of one Conversation: the worker's name keys its Read mark and mute (O7).
export type ConversationLook = { worker: string; name: string; lastMessageAt: number | null; needsYou: boolean };

export type DecisionCard = { kind: "decision"; key: string; id: string; blocking: boolean; due: number | null; askedAt: number };
export type UpdateCard = { kind: "update"; key: string; worker: string; conversation: string; needsYou: boolean; claim: SaysDone; lastAt: number };
export type Card = DecisionCard | UpdateCard;

export const decisionKey = (id: string) => `d:${id}`;
export const updateKey = (conversation: string) => `u:${conversation}`;

// C1: every open Ask that waits for his call has a card, whatever he read or muted. It leaves only by being answered,
// settled or expired. Asks for his time (need "time") are no card: they are the dashboard's (Horizon) to place.
export const waitsForCall = (e: Pick<Escalation, "status" | "need">) => e.status === "open" && e.need === "decision";

// C2: a Conversation has an update when it isn't muted and has a message after its Read mark.
export const hasUpdate = (c: Pick<ConversationLook, "lastMessageAt">, mark: number | null, muted: boolean) =>
  !muted && c.lastMessageAt !== null && c.lastMessageAt > (mark ?? 0);

// C3, the order: decisions first (blocking, then the earliest due or default time, then the oldest), then updates
// (needs you, then "says done", then the most recent).
export function compareDecisionCards(a: DecisionCard, b: DecisionCard): number {
  return Number(b.blocking) - Number(a.blocking) || (a.due ?? Infinity) - (b.due ?? Infinity) || a.askedAt - b.askedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
const claimRank = (c: SaysDone) => (c === "says_done" ? 0 : 1);
export function compareUpdateCards(a: UpdateCard, b: UpdateCard): number {
  return Number(b.needsYou) - Number(a.needsYou) || claimRank(a.claim) - claimRank(b.claim) || b.lastAt - a.lastAt
    || (a.conversation < b.conversation ? -1 : a.conversation > b.conversation ? 1 : 0);
}
export function compareCards(a: Card, b: Card): number {
  if (a.kind !== b.kind) return a.kind === "decision" ? -1 : 1;
  return a.kind === "decision" ? compareDecisionCards(a, b as DecisionCard) : compareUpdateCards(a, b as UpdateCard);
}

export type CatchUpInput = {
  decisions: readonly Pick<Escalation, "id" | "status" | "need" | "blocking" | "deadline" | "askedAt">[];
  conversations: readonly ConversationLook[];
  reads: Readonly<Record<string, number>>;
  muted: readonly string[];
  claims?: Readonly<Record<string, SaysDone>>;          // by conversation, where the catch-up read model said
  // false: decision cards only. The phone's catch-up since ADR-0011: updates wait in each lane's chat and in the digest
  // after he was away (H5), never as a stream of cards.
  updates?: boolean;
};

// Every card that waits now, in the order he works through them (C1–C3).
export function catchUpCards(i: CatchUpInput): Card[] {
  const decisions: DecisionCard[] = i.decisions.filter(waitsForCall)
    .map(d => ({ kind: "decision", key: decisionKey(d.id), id: d.id, blocking: d.blocking, due: d.deadline, askedAt: d.askedAt }));
  const muted = new Set(i.muted);
  // Two panes can share a name and so share one Read mark (O7's known limit): one card for the name, the pane that
  // spoke last, as the hub's catch-up describes it, so a reply goes where the messages came from (review of PR #7, 4).
  const byName = new Map<string, ConversationLook>();
  for (const c of i.conversations) {
    const had = byName.get(c.name);
    if (!had || (c.lastMessageAt ?? 0) > (had.lastMessageAt ?? 0)) byName.set(c.name, c);
  }
  const updates: UpdateCard[] = [];
  for (const c of i.updates === false ? [] : byName.values()) {
    if (!hasUpdate(c, i.reads[c.name] ?? null, muted.has(c.name))) continue;
    updates.push({ kind: "update", key: updateKey(c.name), worker: c.worker, conversation: c.name, needsYou: c.needsYou, claim: i.claims?.[c.name] ?? null, lastAt: c.lastMessageAt ?? 0 });
  }
  return [...decisions.sort(compareDecisionCards), ...updates.sort(compareUpdateCards)];
}

// The number on "Catch up · N": the open decisions plus the unmuted conversations with unread messages (C1, C2).
export const catchUpCount = (i: CatchUpInput) => catchUpCards(i).length;

// C4: a muted Conversation gets no card; its unread messages are only counted, so the end can say how many it skipped.
// Amended by ADR-0011 (review #10, the team's call): on a decisions-only run no lane's updates are shown, so none is
// "skipped" for being muted, and the count is empty.
export function mutedWithUpdates(i: Pick<CatchUpInput, "conversations" | "reads" | "muted" | "updates">): string[] {
  if (i.updates === false) return [];
  const muted = new Set(i.muted);
  return [...new Set(i.conversations.filter(c => muted.has(c.name) && hasUpdate(c, i.reads[c.name] ?? null, false)).map(c => c.name))];
}

// An agent's answer that leads with "STATUS: <word>" (the protocol agents in this system follow); null for any other.
export function statusOf(text: string): { status: "done" | "blocked" | "decision" | "failed" | null; rest: string } {
  const m = /^\s*\**STATUS\**\s*:?\s*\**\s*(DONE|BLOCKED|NEEDS DECISION|FAILED)\b[.:]?\s*/i.exec(text);
  if (!m) return { status: null, rest: text };
  const word = (m[1] ?? "").toUpperCase();
  const status = word === "DONE" ? "done" : word === "BLOCKED" ? "blocked" : word === "FAILED" ? "failed" : "decision";
  return { status, rest: text.slice(m[0].length) };
}

// What one Conversation brings since its Read mark (C5): the newest `keep` messages to show (words and files; tool
// calls are counted, not listed, so they never push an answer off the card: review of PR #7, finding 11), and the whole
// of it in counts: how many messages (words and files: not tool activity, not the system's plumbing), from when to
// when (the last of anything, tool calls too: what "Mark as read" covers), tool uses (and the most used tools), files
// sent to him. The claim is the worker's latest answer's: "says done" when it led
// with STATUS: DONE.
export type NewSince = {
  messages: Message[]; count: number; firstAt: number | null; lastAt: number | null;
  tools: number; toolNames: string[]; files: number; claim: SaysDone;
};
export function newSince(messages: readonly Message[], mark: number | null, keep = 30): NewSince {
  const fresh = messages.filter(m => m.at > (mark ?? 0));
  const byTool = new Map<string, number>();
  let tools = 0, files = 0, count = 0;
  const shown: Message[] = [];
  for (const m of fresh) {
    if (m.kind !== "activity" && !(m.kind === "event" && m.author.kind === "system")) { count++; shown.push(m); }
    for (const t of m.tools ?? []) { tools++; byTool.set(t, (byTool.get(t) ?? 0) + 1); }
    if (m.author.kind !== "principal") files += m.attachments?.length ?? 0;
  }
  const answer = fresh.findLast(m => m.author.kind === "agent" && m.kind === "text");
  return {
    messages: keep > 0 ? shown.slice(-keep) : [],
    count,
    firstAt: fresh[0]?.at ?? null,
    lastAt: fresh.at(-1)?.at ?? null,
    tools,
    toolNames: [...byTool.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([t]) => t),
    files,
    claim: answer && statusOf(answer.text).status === "done" ? "says_done" : null,
  };
}

// One Conversation's catch-up as the hub sends it: whose, its Read mark, and what came since.
export type CatchUpConversation = NewSince & { worker: WorkerId; name: string; mark: number | null };

// C7: "last caught up" (the end of his last run) only moves forward, is clamped to the hub's clock as a Read mark is
// (O7), and grants and starts nothing: nothing is decided from it.
export function advanceCaughtUp(stored: number | null, proposed: number, now: number): number | null {
  if (!Number.isFinite(proposed) || proposed < 0) return null;
  const at = Math.min(proposed, now);
  return stored !== null && at <= stored ? null : at;
}
