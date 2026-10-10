// The catch-up read model on the hub (ADR-0009, C5): for each Conversation, what is new since its Read mark, from the
// messages Observation already follows (O5's 300). A muted Conversation is left out (C4) unless it is asked for by name.
// Read only: it moves no mark and touches no Escalation (C6).
import { newSince, type CatchUpConversation, type Message, type WorkerId } from "@morndo/domain";

export type CatchUpSources = {
  workers(): { id: string; name: string }[];
  history(id: string): Message[];
  reads(): Record<string, number>;
  muted(): string[];
};

// The newest messages one card shows; the counts cover all that is new.
export const CARD_MESSAGES = 30;

// `only`: one worker's (a card about to show), even if nothing is new or it is muted; otherwise every unmuted
// Conversation with something new. Two panes with one name share a mark: the one that spoke last is taken, as the
// card does (domain catchUpCards; review of PR #7, finding 4).
export function catchUp(s: CatchUpSources, only?: string, keep = CARD_MESSAGES): CatchUpConversation[] {
  const reads = s.reads();
  const muted = new Set(s.muted());
  const byName = new Map<string, CatchUpConversation>();
  for (const w of s.workers()) {
    if (only !== undefined ? w.id !== only : muted.has(w.name)) continue;
    const mark = reads[w.name] ?? null;
    const n = newSince(s.history(w.id), mark, keep);
    if (only === undefined && n.lastAt === null) continue;
    const had = byName.get(w.name);
    if (!had || (n.lastAt ?? 0) > (had.lastAt ?? 0)) byName.set(w.name, { ...n, worker: w.id as WorkerId, name: w.name, mark });
  }
  return [...byName.values()];
}
