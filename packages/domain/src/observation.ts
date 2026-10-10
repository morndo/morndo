// Observation context: what the workers are doing (docs/domain.md, "Observation"). A read model; it grants nothing (O4).

import type { WorkerId } from "./shared.ts";

// node: the machine it runs on, a fleet node's name or the legacy hub's own label (ADR-0012).
export type Worker = { id: WorkerId; name: string; location: string; node: string };
// A worker as a listing reports it. offline: its machine doesn't answer now; it stays listed, never gone (fleet core §7).
export type ListedWorker = Worker & { offline: boolean };
// waitingOn: what it waits for, as an identity (S6): "q:<question ids>", "menu:<the menu's digest>", or null.
export type WorkerDetails = { title: string | null; lastMessageAt: number | null; needsYou: boolean; waitingOn: string | null };
export type WorkerState = "active" | "quiet";

export type FeedBody =
  | { type: "WorkerAppeared"; worker: Worker; state: WorkerState; changedAt: number; offline: boolean }
  | { type: "WorkerRenamed"; workerId: WorkerId; name: string }
  | { type: "WorkerMoved"; workerId: WorkerId; location: string }
  | { type: "WorkerBecameActive"; workerId: WorkerId; changedAt: number }
  | { type: "WorkerBecameQuiet"; workerId: WorkerId; changedAt: number }
  | { type: "WorkerGone"; workerId: WorkerId }
  | { type: "WorkerTitled"; workerId: WorkerId; title: string | null }
  | { type: "WorkerSpoke"; workerId: WorkerId; at: number }
  | { type: "WorkerNeedsYouChanged"; workerId: WorkerId; needsYou: boolean; waitingOn: string | null }
  | { type: "WorkerOfflineChanged"; workerId: WorkerId; offline: boolean };

export type FeedEvent = { epoch: string; seq: number; at: number; body: FeedBody };

export type SinceResult = { kind: "events"; events: FeedEvent[] } | { kind: "resync" };

// O1, O2: sequence numbers rise by exactly one per event within an epoch. A cursor inside the retained window gets
// exactly the events after it; anything else gets "resync", never a partial list.
export class Feed {
  readonly epoch: string;
  #capacity: number;
  #events: FeedEvent[] = [];
  #head = 0;                                             // seq of the newest event; 0 before the first

  constructor(epoch: string, capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be a positive integer");
    this.epoch = epoch;
    this.#capacity = capacity;
  }

  get head() { return this.#head; }

  append(body: FeedBody, at: number): FeedEvent {
    const event: FeedEvent = { epoch: this.epoch, seq: ++this.#head, at, body };
    this.#events.push(event);
    if (this.#events.length > this.#capacity) this.#events.shift();
    return event;
  }

  since(epoch: string, cursor: number): SinceResult {
    if (epoch !== this.epoch || !Number.isInteger(cursor) || cursor < 0 || cursor > this.#head) return { kind: "resync" };
    if (cursor === this.#head) return { kind: "events", events: [] };
    const oldest = this.#events[0]?.seq ?? this.#head + 1;
    if (cursor < oldest - 1) return { kind: "resync" };  // the gap was dropped from the window
    return { kind: "events", events: this.#events.filter(e => e.seq > cursor) };
  }
}

export type RosterEntry = Worker & WorkerDetails & { state: WorkerState; changedAt: number; offline: boolean };

// O3: only the latest screen per worker is kept, and a change is reported only when the text differs.
// A worker is "active" while its screen changed within `quietAfterMs`; state flips are what go into the feed,
// so a busy worker doesn't flood it.
export class Roster {
  #quietAfterMs: number;
  #workers = new Map<WorkerId, RosterEntry>();
  #screens = new Map<WorkerId, string>();

  constructor(quietAfterMs: number) {
    this.#quietAfterMs = quietAfterMs;
  }

  entries(): RosterEntry[] { return [...this.#workers.values()]; }
  screen(id: WorkerId): string | undefined { return this.#screens.get(id); }

  // A fresh listing of the workers that exist now.
  observeListing(listing: ListedWorker[], now: number): FeedBody[] {
    const out: FeedBody[] = [];
    const seen = new Set<WorkerId>();
    for (const { offline, ...w } of listing) {
      seen.add(w.id);
      const known = this.#workers.get(w.id);
      if (!known) {
        const entry: RosterEntry = { ...w, offline, state: "quiet", changedAt: now, title: null, lastMessageAt: null, needsYou: false, waitingOn: null };
        this.#workers.set(w.id, entry);
        out.push({ type: "WorkerAppeared", worker: { ...w }, state: entry.state, changedAt: now, offline });
      } else if (known.name !== w.name) {
        known.name = w.name;
        out.push({ type: "WorkerRenamed", workerId: w.id, name: w.name });
      }
      if (known && known.location !== w.location) {
        known.location = w.location;
        out.push({ type: "WorkerMoved", workerId: w.id, location: w.location });
      }
      if (known && known.offline !== offline) {
        known.offline = offline;
        out.push({ type: "WorkerOfflineChanged", workerId: w.id, offline });
      }
    }
    for (const id of [...this.#workers.keys()]) {
      if (seen.has(id)) continue;
      this.#workers.delete(id);
      this.#screens.delete(id);
      out.push({ type: "WorkerGone", workerId: id });
    }
    return out;
  }

  // The latest screen text, kept for whoever is watching, without a change counting as the worker becoming active.
  // For a worker whose working and idle come from a report rather than the pane redrawing.
  recordScreen(id: WorkerId, text: string): boolean {
    const entry = this.#workers.get(id);
    if (!entry) return false;
    if (this.#screens.get(id) === text) return false;
    this.#screens.set(id, text);
    return true;
  }

  // A fresh screen text. Returns whether the screen changed, and the feed events that follow from it.
  observeScreen(id: WorkerId, text: string, now: number): { changed: boolean; events: FeedBody[] } {
    const entry = this.#workers.get(id);
    if (!entry) return { changed: false, events: [] };
    const previous = this.#screens.get(id);
    if (previous === text) return { changed: false, events: [] };
    this.#screens.set(id, text);
    if (previous === undefined) return { changed: true, events: [] };   // first sight is not activity
    entry.changedAt = now;
    if (entry.state === "active") return { changed: true, events: [] };
    entry.state = "active";
    return { changed: true, events: [{ type: "WorkerBecameActive", workerId: id, changedAt: now }] };
  }

  // What the conversation adapter learned: the session's title, its newest message, and whether it waits for you (O6).
  observeDetails(id: WorkerId, d: Partial<WorkerDetails>): FeedBody[] {
    const entry = this.#workers.get(id);
    if (!entry) return [];
    const out: FeedBody[] = [];
    if (d.title !== undefined && d.title !== entry.title) {
      entry.title = d.title;
      out.push({ type: "WorkerTitled", workerId: id, title: d.title });
    }
    if (d.lastMessageAt != null && (entry.lastMessageAt === null || d.lastMessageAt > entry.lastMessageAt)) {
      entry.lastMessageAt = d.lastMessageAt;
      out.push({ type: "WorkerSpoke", workerId: id, at: d.lastMessageAt });
    }
    // Told when it starts or stops needing you, and when what it waits for changes while it does (S6).
    const needs = d.needsYou ?? entry.needsYou;
    const on = d.waitingOn !== undefined ? d.waitingOn : entry.waitingOn;
    if (needs !== entry.needsYou || on !== entry.waitingOn) {
      entry.needsYou = needs;
      entry.waitingOn = on;
      out.push({ type: "WorkerNeedsYouChanged", workerId: id, needsYou: needs, waitingOn: on });
    }
    return out;
  }

  // Working reported apart from the screen: the terminal stood still, but the worker is working. Restarts the quiet
  // timer so a still screen does not turn it quiet. Already working: no feed event.
  holdWorking(id: WorkerId, now: number): FeedBody[] {
    const entry = this.#workers.get(id);
    if (!entry) return [];
    entry.changedAt = now;
    if (entry.state === "active") return [];
    entry.state = "active";
    return [{ type: "WorkerBecameActive", workerId: id, changedAt: now }];
  }

  // That report stopped (idle, or waiting). Quiet now, even if the pane just redrew.
  releaseWorking(id: WorkerId, now: number): FeedBody[] {
    const entry = this.#workers.get(id);
    if (!entry || entry.state !== "active") return [];
    entry.state = "quiet";
    entry.changedAt = now;
    return [{ type: "WorkerBecameQuiet", workerId: id, changedAt: now }];
  }

  // Time passing: workers whose screen stood still long enough become quiet.
  tick(now: number): FeedBody[] {
    const out: FeedBody[] = [];
    for (const entry of this.#workers.values()) {
      if (entry.state === "active" && now - entry.changedAt >= this.#quietAfterMs) {
        entry.state = "quiet";
        out.push({ type: "WorkerBecameQuiet", workerId: entry.id, changedAt: entry.changedAt });
      }
    }
    return out;
  }
}
