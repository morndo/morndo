// Presence (ADR-0011, H4): when the principal was last active on each of his devices (Endpoints), from the reports their
// apps already send so that no push goes while he is looking (N3: focus, and his input in the last 2 minutes). A device
// asks when he was last active anywhere else, to tell a real absence from a day spent on another screen. Kept in the
// settings table, so a restart in the night doesn't hide the night. It grants and starts nothing.
import { ATTENDING_INPUT_MS } from "@morndo/domain";
import { log } from "../adapters/log.ts";

export type PresenceStore = { setting<T>(key: string): T | null; saveSetting(key: string, value: unknown): void };

const KEY = "presence";

export class PresenceService {
  #store: PresenceStore;
  #now: () => number;
  #last: Record<string, number>;                                   // endpoint → when he was last active there
  #reports = new Map<string, { endpoint: string; at: number }>();  // connection → its latest "attending" word
  #layout = new Map<string, string>();                             // connection → which layout said hello (phone, desk)

  constructor(store: PresenceStore, now: () => number = Date.now) {
    this.#store = store;
    this.#now = now;
    const saved = store.setting<Record<string, unknown>>(KEY) ?? {};
    this.#last = Object.fromEntries(Object.entries(saved).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1])));
  }

  // A connection's word: attending (renewed every minute while it lasts) or not any more. Either way he was active
  // there until now, if it had said attending before.
  attending(connection: string, endpoint: string, attending: boolean) {
    const was = this.#reports.has(connection);
    if (attending) this.#reports.set(connection, { endpoint, at: this.#now() });
    else this.#reports.delete(connection);
    if (attending || was) this.#mark(endpoint);
  }

  // A new socket of a layout replaces that layout's earlier one. The other layout on this endpoint stays, so a
  // half-open reconnect is not "attending elsewhere" while the wide layout still is.
  hello(connection: string, endpoint: string, layout: string) {
    this.#layout.set(connection, layout);
    for (const [id, r] of this.#reports) {
      if (id !== connection && r.endpoint === endpoint && this.#layout.get(id) === layout) this.#reports.delete(id);
    }
  }

  left(connection: string) {
    this.#layout.delete(connection);
    const r = this.#reports.get(connection);
    if (!r) return;
    this.#reports.delete(connection);
    this.#mark(r.endpoint);
  }

  // His latest activity on any other device, or on another layout of this one (the wide layout and the phone
  // share an endpoint). `asking` is the connection that asked: its own report does not count. Without it, only
  // other endpoints count, as before. The stored time is still per endpoint, so a closed layout is this device's
  // own last-active mark, not "elsewhere".
  elsewhere(endpoint: string, asking?: string): number | null {
    const now = this.#now();
    for (const [id, r] of this.#reports) {
      if (id === asking) continue;
      const otherLayout = asking !== undefined && r.endpoint === endpoint;
      if ((r.endpoint !== endpoint || otherLayout) && now - r.at < ATTENDING_INPUT_MS) return now;
    }
    let best: number | null = null;
    for (const [e, at] of Object.entries(this.#last)) if (e !== endpoint && (best === null || at > best)) best = at;
    return best;
  }

  // Kept in memory at once; the write can fail (the database busy, or closed while the hub stops and its sockets close):
  // logged, never thrown into a socket's close handler, where it would end the hub.
  #mark(endpoint: string) {
    this.#last[endpoint] = this.#now();
    try { this.#store.saveSetting(KEY, this.#last); }
    catch (e) { log.warn(`presence: couldn't keep the last activity (${(e as Error).message})`); }
  }
}
