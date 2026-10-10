// Drafts per conversation (ADR-0008 phase D; a decision: text only, per device). Saved to localStorage "morndo.drafts"
// 300 ms after the last keystroke, restored when the conversation opens, cleared on send. Design reference, not code:
// Signal-Desktop ts/state/ducks/composer.preload.ts: a per-composer send counter drops a save that was still pending
// when the message went, so a sent draft never comes back.
// Keyed by the worker's pane and kept with its name: a draft comes back only where both match, never in another
// worker's box (review H2: two panes can share a name). It keeps what the worker waited for when it was started, so a
// restored draft still answers that question and the hub refuses it if the question changed (S6, review H1). Each save
// rewrites only its own entry over what storage holds now, so two tabs keep each other's drafts (review L5).
export const DRAFT_DEBOUNCE_MS = 300;
const KEY = "morndo.drafts";

type Storage = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
type Entry = { name: string; text: string; seen: string | null };
export type Draft = { text: string; seen: string | null };

const isEntry = (v: unknown): v is Entry => {
  const e = v as Partial<Entry> | null;
  return !!e && typeof e === "object" && typeof e.name === "string" && typeof e.text === "string" && (e.seen === null || typeof e.seen === "string");
};

export class Drafts {
  #storage: Storage | null;
  #memory: Record<string, Entry> = {};             // without storage (private mode), or when it can't be read
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #sends = new Map<string, number>();              // per conversation: how many sends; a pending save carries its count

  constructor(storage: Storage | null) { this.#storage = storage; }

  #read(): Record<string, Entry> {
    if (!this.#storage) return this.#memory;
    try {
      const v: unknown = JSON.parse(this.#storage.getItem(KEY) ?? "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, e]) => isEntry(e))) as Record<string, Entry> : {};
    } catch { return {}; }
  }

  #commit(key: string, entry: Entry | null) {
    const all = this.#read();
    if (entry) all[key] = entry;
    else delete all[key];
    this.#memory = all;
    try { this.#storage?.setItem(KEY, JSON.stringify(all)); } catch { /* storage full or blocked: the page keeps it */ }
  }

  get(key: string, name: string): Draft | null {
    const e = this.#read()[key];
    return e && e.name === name ? { text: e.text, seen: e.seen } : null;
  }

  typed(key: string, name: string, text: string, seen: string | null) {
    const prior = this.#timers.get(key);
    if (prior) clearTimeout(prior);
    const count = this.#sends.get(key) ?? 0;
    this.#timers.set(key, setTimeout(() => {
      this.#timers.delete(key);
      if ((this.#sends.get(key) ?? 0) !== count) return;               // sent since: this save is stale
      this.#commit(key, text.trim() ? { name, text, seen } : null);
    }, DRAFT_DEBOUNCE_MS));
  }

  sent(key: string) {
    this.#sends.set(key, (this.#sends.get(key) ?? 0) + 1);
    const prior = this.#timers.get(key);
    if (prior) { clearTimeout(prior); this.#timers.delete(key); }
    this.#commit(key, null);
  }
}

// This device's drafts, shared by every composer of the page.
let shared: Drafts | null = null;
export function deviceDrafts(): Drafts {
  if (!shared) {
    let storage: Storage | null = null;
    try { storage = globalThis.localStorage ?? null; } catch { storage = null; }
    shared = new Drafts(storage);
  }
  return shared;
}
