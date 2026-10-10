// The feed's connection lifecycle (ADR-0008, phase B). Design reference, not code: Signal-Desktop
// ts/textsecure/WebsocketResources.preload.ts (keepalive, the 5-minute stale check), SocketManager.preload.ts (wake,
// online, offline) and ts/util/BackOff.std.ts. No Svelte and no globals: the socket, the clock and the timers come in,
// so a test can drive a half-open socket, a device that slept and a network that went away.

export const BACKOFF_MS = [500, 1000, 2000, 3000, 5000, 8000, 13_000, 21_000, 34_000] as const;
export const JITTER_MS = 1000;
export const PING_EVERY_MS = 25_000;      // an app-level ping, re-armed after each pong (one in flight at a time)
export const PONG_TIMEOUT_MS = 10_000;    // no pong by then: the socket is dead even if the browser hasn't noticed
export const STALE_MS = 5 * 60_000;       // on waking, silence this long means the device slept: reconnect at once
export const PROBE_AFTER_MS = 30_000;     // on waking, silence this long gets a quick ping first
export const PROBE_TIMEOUT_MS = 5000;
export const CONNECT_TIMEOUT_MS = 10_000; // a handshake that hasn't finished by then is given up and tried again
export const OFFLINE_CHECK_MS = 30_000;   // while Offline, how often to look whether the browser says online again

// The wait before reconnect attempt `attempt` (0-based): the sequence, capped at its last step, plus up to a second of
// jitter so many devices don't come back at the same instant.
export const backoff = (attempt: number, random: () => number = Math.random) =>
  (BACKOFF_MS[Math.min(Math.max(0, attempt), BACKOFF_MS.length - 1)] ?? 34_000) + Math.floor(random() * JITTER_MS);

export type Transport = "connecting" | "open" | "reconnecting" | "offline" | "ended";

export type SocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
};

export type Timers = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

const CONNECTING = 0;
const OPEN = 1;
type TimerName = "retry" | "ping" | "pong" | "connect" | "offline";

export class FeedConnection {
  #open: () => SocketLike;
  #timers: Timers;
  #random: () => number;
  #online: () => boolean;
  #checkSession: () => Promise<"ok" | "ended">;
  #onOpen: () => void;
  #onFrame: (data: unknown) => void;
  #onTransport: (t: Transport) => void;
  #ws: SocketLike | null = null;
  #attempt = 0;
  #pending = new Map<TimerName, unknown>();
  #awaiting: number | null = null;         // the n of the ping in flight
  #n = 0;
  #lastAliveAt = 0;
  #stopped = true;
  #offline = false;
  #ended = false;

  constructor(d: {
    open: () => SocketLike; timers: Timers; online: () => boolean; random?: () => number;
    // After a handshake that failed: is the session still good? A browser shows a refused upgrade (401) as close code
    // 1006, the same as a network failure, so a signed-out device would otherwise retry forever (review M4).
    checkSession?: () => Promise<"ok" | "ended">;
    onOpen: () => void; onFrame: (data: unknown) => void; onTransport: (t: Transport) => void;
  }) {
    this.#open = d.open;
    this.#timers = d.timers;
    this.#random = d.random ?? Math.random;
    this.#online = d.online;
    this.#checkSession = d.checkSession ?? (async () => "ok");
    this.#onOpen = d.onOpen;
    this.#onFrame = d.onFrame;
    this.#onTransport = d.onTransport;
  }

  get lastAliveAt() { return this.#lastAliveAt; }
  get isOpen() { return this.#ws?.readyState === OPEN; }

  start() {
    this.#stopped = false;
    if (!this.#online()) return this.offline();
    this.#connect("connecting");
  }

  stop() {
    this.#stopped = true;
    this.#clearTimers();
    const ws = this.#ws;
    this.#ws = null;
    if (ws) { this.#detach(ws); ws.close(1000); }
  }

  send(m: unknown): boolean {
    if (this.#ws?.readyState !== OPEN) return false;
    this.#ws.send(JSON.stringify(m));
    return true;
  }

  // The hub answered ping n (the app decoded a pong).
  pong(n: number) {
    if (n !== this.#awaiting) return;
    this.#awaiting = null;
    this.#cancel("pong");
    this.#schedulePing(PING_EVERY_MS);
  }

  // The app came back to the front, was restored, got focus, or the network came back up.
  wake() {
    if (this.#stopped || this.#ended) return;
    if (this.#offline) { if (this.#online()) this.online(); return; }   // Offline is never sticky (review M3)
    if (!this.#online()) return this.offline();
    if (!this.#ws) return this.#connect("connecting");
    if (this.#ws.readyState === CONNECTING) return;                     // a handshake under way: let it finish (M1)
    const silent = this.#timers.now() - this.#lastAliveAt;
    if (silent > STALE_MS) return this.#reconnectNow();
    if (silent > PROBE_AFTER_MS && this.#awaiting === null && this.isOpen) this.#sendPing(PROBE_TIMEOUT_MS);
  }

  // The browser says the network is gone: stop retrying until it says it's back (an 'online' event, a wake, or a look
  // every 30 s, since an event can be missed while the page is frozen).
  offline() {
    if (this.#stopped || this.#ended) return;
    this.#offline = true;
    this.#clearTimers();
    const ws = this.#ws;
    this.#ws = null;
    if (ws) { this.#detach(ws); ws.close(1000, "offline"); }
    this.#onTransport("offline");
    this.#lookForNetwork();
  }

  online() {
    if (this.#stopped || this.#ended) return;
    this.#offline = false;
    this.#cancel("offline");
    this.#attempt = 0;
    if (!this.#ws) this.#connect("connecting");
    else this.wake();
  }

  #lookForNetwork() {
    this.#set("offline", OFFLINE_CHECK_MS, () => { if (this.#online()) this.online(); else this.#lookForNetwork(); });
  }

  #connect(state: "connecting" | "reconnecting") {
    this.#cancel("retry");
    if (this.#stopped || this.#ended || this.#offline) return;
    this.#onTransport(state);
    const ws = this.#open();
    this.#ws = ws;
    let opened = false;
    let heard = false;
    // A handshake that hangs (common right after a phone wakes) is given up and retried (review M2).
    this.#set("connect", CONNECT_TIMEOUT_MS, () => {
      if (this.#ws !== ws || opened) return;
      this.#ws = null;
      this.#detach(ws);
      ws.close(4000, "handshake timed out");
      this.#scheduleReconnect();
    });
    ws.onopen = () => {
      if (this.#ws !== ws) return;
      opened = true;
      this.#cancel("connect");
      this.#alive();
      this.#onTransport("open");
      this.#onOpen();
      this.#schedulePing(PING_EVERY_MS);
    };
    ws.onmessage = e => {
      if (this.#ws !== ws) return;
      // The backoff resets only once the hub has said something: a socket it opens and closes at once keeps backing
      // off (review L6).
      if (!heard) { heard = true; this.#attempt = 0; }
      this.#alive();
      this.#onFrame(e.data);
    };
    ws.onclose = e => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#clearTimers();
      if (e.code === 4401) return this.#end();
      if (!this.#online()) return this.offline();
      if (!opened) {
        this.#onTransport("reconnecting");
        void this.#checkSession().then(s => {
          if (this.#stopped || this.#ended || this.#offline || this.#ws) return;
          if (s === "ended") this.#end();
          else this.#scheduleReconnect();
        }, () => { if (!this.#stopped && !this.#ended && !this.#offline && !this.#ws) this.#scheduleReconnect(); });
        return;
      }
      this.#scheduleReconnect();
    };
  }

  #end() {
    this.#ended = true;
    this.#clearTimers();
    this.#onTransport("ended");
  }

  #scheduleReconnect() {
    if (this.#stopped || this.#ended || this.#offline) return;
    this.#onTransport("reconnecting");
    this.#set("retry", backoff(this.#attempt++, this.#random), () => this.#connect("reconnecting"));
  }

  // A socket that may be half-open: don't wait for its close (a dead TCP connection can take minutes to report one).
  #reconnectNow() {
    const ws = this.#ws;
    this.#ws = null;
    this.#clearTimers();
    if (ws) { this.#detach(ws); ws.close(4000, "no answer"); }
    this.#connect("reconnecting");
  }

  #alive() { this.#lastAliveAt = this.#timers.now(); }

  #schedulePing(ms: number) {
    this.#set("ping", ms, () => this.#sendPing(PONG_TIMEOUT_MS));
  }

  #sendPing(timeout: number) {
    this.#cancel("ping");
    const n = ++this.#n;
    if (!this.send({ t: "ping", n })) return;
    this.#awaiting = n;
    this.#set("pong", timeout, () => { this.#awaiting = null; this.#reconnectNow(); });
  }

  #set(name: TimerName, ms: number, fn: () => void) {
    this.#cancel(name);
    this.#pending.set(name, this.#timers.setTimeout(() => { this.#pending.delete(name); fn(); }, ms));
  }

  #cancel(name: TimerName) {
    const id = this.#pending.get(name);
    if (id !== undefined) { this.#timers.clearTimeout(id); this.#pending.delete(name); }
  }

  #clearTimers() {
    for (const name of [...this.#pending.keys()]) this.#cancel(name);
    this.#awaiting = null;
  }

  #detach(ws: SocketLike) { ws.onopen = null; ws.onmessage = null; ws.onclose = null; }
}
