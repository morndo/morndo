// hold.json: while it names this service, new side-effecting work is refused and what is already running is reported.
// A hold older than 10 minutes is ignored, so a dead updater cannot hold a service forever (design, section 5).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HoldFile, parseBody, type HoldFile as Hold, type ServiceName } from "@morndo/protocol";

export const HOLD_MAX_AGE_MS = 10 * 60 * 1000;
export type { Hold, ServiceName };

export type HoldView =
  | { kind: "absent" }
  | { kind: "held"; hold: Hold }
  | { kind: "ignored"; why: "malformed" | "stale" | "other-service" };

export function holdFile(home: string, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof env.MORNDO_HOLD_FILE === "string" && env.MORNDO_HOLD_FILE.length > 0) return env.MORNDO_HOLD_FILE;
  // A test's HOME is a throwaway directory, and it inherits the account's XDG_STATE_HOME. Use that only when this
  // process is the account's own (not a test), so a suite never reads the account's hold file.
  const xdg = env.XDG_STATE_HOME;
  const own = env.NODE_ENV !== "test" && !env.VITEST && env.HOME === home;
  const base = own && typeof xdg === "string" && xdg.length > 0 ? xdg : join(home, ".local", "state");
  return join(base, "morndo-update", "hold.json");
}

export function readHold(opts: { path: string; service: ServiceName; now: number }): HoldView {
  let text: string;
  try { text = readFileSync(opts.path, "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "ignored", why: "malformed" };
  }
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; }
  catch { return { kind: "ignored", why: "malformed" }; }
  const hold = parseBody(HoldFile, raw);
  if (!hold) return { kind: "ignored", why: "malformed" };
  const since = Date.parse(hold.since);
  if (Number.isNaN(since)) return { kind: "ignored", why: "malformed" };
  if (opts.now - since > HOLD_MAX_AGE_MS) return { kind: "ignored", why: "stale" };
  if (!hold.services.includes(opts.service)) return { kind: "ignored", why: "other-service" };
  return { kind: "held", hold };
}

export type InFlight = { kind: string; id: string };

// Work a restart would interrupt. begin() returns the function that ends that one item.
export class Flight {
  #items = new Map<number, InFlight>();
  #n = 0;
  #waiters: (() => void)[] = [];

  begin(item: InFlight): () => void {
    const token = ++this.#n;
    this.#items.set(token, item);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.#items.delete(token);
      if (this.#items.size === 0) for (const wake of this.#waiters.splice(0)) wake();
    };
  }

  list(): InFlight[] { return [...this.#items.values()]; }

  idle(timeoutMs?: number): Promise<void> {
    if (this.#items.size === 0) return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const at = this.#waiters.indexOf(wake);
        if (at >= 0) this.#waiters.splice(at, 1);
        resolve();
      };
      this.#waiters.push(wake);
      if (timeoutMs !== undefined) {
        timer = setTimeout(wake, timeoutMs);
        timer.unref?.();
      }
    });
  }
}

// Re-reads the file every second. A stale hold is reported once, until a later file is fresh or gone.
export class HoldWatch {
  #path: string;
  #service: ServiceName;
  #now: () => number;
  #onStale: (message: string) => void;
  #held = false;
  #staleNoted = false;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { path: string; service: ServiceName; now?: () => number; onStale?: (message: string) => void }) {
    this.#path = opts.path;
    this.#service = opts.service;
    this.#now = opts.now ?? Date.now;
    this.#onStale = opts.onStale ?? (() => {});
  }

  start(): void {
    this.refresh();
    this.#timer = setInterval(() => this.refresh(), 1000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  refresh(): HoldView {
    const view = readHold({ path: this.#path, service: this.#service, now: this.#now() });
    if (view.kind === "ignored" && view.why === "stale") {
      if (!this.#staleNoted) {
        this.#staleNoted = true;
        this.#onStale(`hold.json at ${this.#path} is older than 10 minutes; ignoring it`);
      }
    } else {
      this.#staleNoted = false;
    }
    this.#held = view.kind === "held";
    return view;
  }

  get held(): boolean { return this.#held; }
}
