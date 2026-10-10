// Application service for reading (Observation, ADR-0008 phase D): the principal's read mark per Conversation and his
// mute, kept on the hub so they follow him across his Endpoints. Marks only move forward (O7, the domain's rule) and
// grant and start nothing (O8): this service touches no Escalation, Decision or timer. Conversations are keyed by the
// worker's name, which outlives a pane's id.
// Since ADR-0009 it also keeps "last caught up", the end of his last catch-up run (C7): one time, forward only, nothing
// decided from it.
import { advanceCaughtUp, advanceReadMark } from "@morndo/domain";

export type ReadingStore = {
  readMarks(): Record<string, number>;
  saveReadMark(conversation: string, at: number): void;
  mutedConversations(): string[];
  setMuted(conversation: string, muted: boolean): void;
  caughtUpAt(): number | null;
  saveCaughtUp(at: number): void;
};

export type ReadingEvent =
  | { t: "read"; conversation: string; at: number }
  | { t: "mute"; conversation: string; muted: boolean }
  | { t: "caught_up"; at: number };
export type ReadingState = { t: "reading"; reads: Record<string, number>; muted: string[] };

export class ReadingService {
  #store: ReadingStore;
  #now: () => number;
  #newestAt: (conversation: string) => number | null;
  #listeners = new Set<(e: ReadingEvent) => void>();

  // `newestAt`: the time of a Conversation's newest message as the hub holds it, null when it holds none.
  constructor(store: ReadingStore, now: () => number = Date.now, newestAt: (conversation: string) => number | null = () => null) {
    this.#store = store;
    this.#now = now;
    this.#newestAt = newestAt;
  }

  subscribe(l: (e: ReadingEvent) => void) { this.#listeners.add(l); return () => this.#listeners.delete(l); }
  #tell(e: ReadingEvent) { for (const l of this.#listeners) l(e); }

  state(): ReadingState { return { t: "reading", reads: this.#store.readMarks(), muted: this.#store.mutedConversations() }; }

  read(conversation: string, at: number) {
    if (!conversation) return;
    const next = advanceReadMark(this.#store.readMarks()[conversation] ?? null, at, this.#now(), this.#newestAt(conversation));
    if (next === null) return;
    this.#store.saveReadMark(conversation, next);
    this.#tell({ t: "read", conversation, at: next });
  }

  caughtUpAt(): number | null { return this.#store.caughtUpAt(); }

  // The principal finished a catch-up run at `at` (C7): kept if later, clamped to this clock, told to every device.
  caughtUp(at: number) {
    const next = advanceCaughtUp(this.#store.caughtUpAt(), at, this.#now());
    if (next === null) return;
    this.#store.saveCaughtUp(next);
    this.#tell({ t: "caught_up", at: next });
  }

  mute(conversation: string, muted: boolean) {
    if (!conversation || this.#store.mutedConversations().includes(conversation) === muted) return;
    this.#store.setMuted(conversation, muted);
    this.#tell({ t: "mute", conversation, muted });
  }
}
