// Application service for the fleet's alerts in the app (the owner, 2026-10-12: kira posts them for one owner; the
// open-source app shows them itself). The fleet keeps every alert 90 days (GET /v1/alerts) and sends each new one as an
// `alert` event (fleet-api §14). This keeps the latest ALERTS_KEPT, newest first, one per id, for the feed's `alerts`
// frame, and tells the notifications of each new one as it comes, never of what a reconnect reads again. What he has
// seen is the read mark of the conversation SEEN_MARK, synced across his devices as every read mark is.
import { urgentAlert, type AlertWire } from "@morndo/protocol";

export const ALERTS_KEPT = 100;
export const SEEN_MARK = "@alerts";

// The ones worth a push: the protocol's one rule (urgentAlert), which the app marks by too.
export const urgent = (a: Pick<AlertWire, "kind" | "detail">): boolean => urgentAlert(a);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// An alert as the fleet sends it, or null: a body that isn't one is dropped (the fleet's own shape is checked there).
function alertOf(v: unknown): AlertWire | null {
  if (!isRecord(v) || !Number.isInteger(v.id) || (v.id as number) < 0 || typeof v.at !== "number" || v.at < 0 || typeof v.kind !== "string") return null;
  if (v.node !== null && typeof v.node !== "string") return null;
  return { id: v.id as number, at: v.at, node: v.node, kind: v.kind, detail: isRecord(v.detail) ? v.detail : {} };
}

// The hub's own alerts (a revocation journal line it could not read) take ids from here up: the fleet's are its audit
// row numbers, which never come near 2^52, so the two never meet in one list.
export const HUB_ALERT_IDS = 2 ** 52;

export class AlertsService {
  #items: AlertWire[] = [];
  #own = 0;
  #listeners = new Set<(items: AlertWire[]) => void>();
  #onNew: (a: AlertWire, isUrgent: boolean) => void;

  // `onNew`: each alert that came as it happened (an event), with whether it is urgent.
  constructor(d: { onNew?: (a: AlertWire, isUrgent: boolean) => void } = {}) {
    this.#onNew = d.onNew ?? (() => {});
  }

  // The fleet's list, read at each connect: kept as is, told as a change, never as new (a reconnect is not news).
  load(list: readonly unknown[]) {
    const read = list.map(alertOf).filter((a): a is AlertWire => a !== null);
    if (this.#merge(read)) this.#tell();
  }

  // One `alert` event: new unless its id is held already.
  add(raw: unknown) {
    const a = alertOf(raw);
    if (!a || !this.#merge([a])) return;
    this.#tell();
    this.#onNew(a, urgent(a));
  }

  // One the hub raises itself, of a kind the fleet raises too: shown and pushed exactly as the fleet's are.
  raise(kind: string, detail: Record<string, unknown>, at: number): AlertWire {
    const a: AlertWire = { id: HUB_ALERT_IDS + this.#own++, at, node: null, kind, detail };
    this.#merge([a]);
    this.#tell();
    this.#onNew(a, urgent(a));
    return a;
  }

  view(): { items: AlertWire[] } { return { items: this.#items }; }

  // Urgent ones newer than `seenAt` (his read mark of SEEN_MARK): what a push counts.
  urgentSince(seenAt: number): number { return this.#items.filter(a => a.at > seenAt && urgent(a)).length; }

  subscribe(f: (items: AlertWire[]) => void): () => void {
    this.#listeners.add(f);
    return () => { this.#listeners.delete(f); };
  }

  #merge(list: readonly AlertWire[]): boolean {
    const held = new Set(this.#items.map(a => a.id));
    const fresh = list.filter(a => !held.has(a.id));
    if (!fresh.length) return false;
    this.#items = [...fresh, ...this.#items].sort((x, y) => y.at - x.at || y.id - x.id).slice(0, ALERTS_KEPT);
    return true;
  }

  #tell() { for (const f of this.#listeners) f(this.#items); }
}
