// The feed's connection lifecycle (ADR-0008, phase B): app-level ping and pong, reconnect at once after the device
// slept, a probe on waking, backoff with jitter, and no retries while offline. Fake sockets and fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKOFF_MS, CONNECT_TIMEOUT_MS, FeedConnection, OFFLINE_CHECK_MS, PING_EVERY_MS, PONG_TIMEOUT_MS, PROBE_TIMEOUT_MS, backoff, type SocketLike, type Transport } from "../src/lib/connection.ts";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  closed: number | null = null;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code = 1000) { this.closed = code; this.readyState = 2; }        // a half-open socket never reports its close
  open() { this.readyState = 1; this.onopen?.({}); }
  frame(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  pings() { return this.sent.filter(m => (m as { t: string }).t === "ping") as { t: "ping"; n: number }[]; }
}

let sockets: FakeSocket[];
let transports: Transport[];
let opened: number;
let online: boolean;
let session: "ok" | "ended";
let sessionChecks: number;
let conn: FeedConnection;
const last = () => sockets.at(-1) as FakeSocket;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 2, 12, 0, 0));
  sockets = []; transports = []; opened = 0; online = true; session = "ok"; sessionChecks = 0;
  conn = new FeedConnection({
    open: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) },
    online: () => online,
    random: () => 0.5,
    onOpen: () => { opened++; },
    onFrame: () => {},
    onTransport: t => transports.push(t),
    checkSession: async () => { sessionChecks++; return session; },
  });
});
afterEach(() => { conn.stop(); vi.useRealTimers(); });

const start = () => { conn.start(); last().open(); };

describe("ping and pong", () => {
  it("pings every 25 s while the hub answers", () => {
    start();
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(last().pings()).toEqual([{ t: "ping", n: 1 }]);
    conn.pong(1);
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(last().pings().map(p => p.n)).toEqual([1, 2]);
    expect(sockets).toHaveLength(1);
  });
  it("a half-open socket (no pong within 10 s) is dropped and replaced at once, without waiting for its close", () => {
    start();
    vi.advanceTimersByTime(PING_EVERY_MS + PONG_TIMEOUT_MS - 1);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets[0]?.closed).toBe(4000);
    expect(sockets).toHaveLength(2);
    last().open();
    expect(opened).toBe(2);
  });
  it("a pong for another ping, or a frame that isn't the pong, doesn't stand in for it", () => {
    start();
    vi.advanceTimersByTime(PING_EVERY_MS);
    conn.pong(99);
    last().frame({ t: "events", events: [] });
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);
    expect(sockets).toHaveLength(2);
  });
});

describe("waking up", () => {
  it("after 6 minutes asleep (no timers ran), reconnects at once", () => {
    start();
    vi.setSystemTime(Date.now() + 6 * 60_000);                          // the clock moved; the device's timers didn't
    conn.wake();
    expect(sockets[0]?.closed).toBe(4000);
    expect(sockets).toHaveLength(2);
  });
  it("after a minute of silence, probes with a 5 s ping: answered, it stays; unanswered, it reconnects", () => {
    start();
    vi.setSystemTime(Date.now() + 60_000);
    conn.wake();
    expect(last().pings()).toHaveLength(1);
    conn.pong(last().pings()[0]?.n ?? -1);
    vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    expect(sockets).toHaveLength(1);
    vi.setSystemTime(Date.now() + 60_000);
    conn.wake();
    vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    expect(sockets).toHaveLength(2);
  });
  it("within 30 s of the last frame, does nothing", () => {
    start();
    vi.setSystemTime(Date.now() + 20_000);
    conn.wake();
    expect(last().pings()).toHaveLength(0);
    expect(sockets).toHaveLength(1);
  });
  it("with no socket (waiting to retry), connects now instead of waiting out the backoff", () => {
    start();
    last().drop();
    expect(sockets).toHaveLength(1);
    conn.wake();
    expect(sockets).toHaveLength(2);
  });
});

describe("backoff", () => {
  it("follows 0.5, 1, 2, 3, 5, 8, 13, 21, 34 s, then stays at 34 s, plus up to a second of jitter", () => {
    expect(BACKOFF_MS).toEqual([500, 1000, 2000, 3000, 5000, 8000, 13_000, 21_000, 34_000]);
    expect(backoff(0, () => 0)).toBe(500);
    expect(backoff(0, () => 0.999)).toBe(1499);
    expect(backoff(8, () => 0)).toBe(34_000);
    expect(backoff(50, () => 0)).toBe(34_000);
  });
  it("waits the backoff between failed attempts and resets after a success", async () => {
    start();
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      last().drop();
      const before = sockets.length;
      let waited = 0;
      while (sockets.length === before && waited < 120_000) { await vi.advanceTimersByTimeAsync(100); waited += 100; }
      waits.push(waited);
    }
    expect(waits).toEqual([1000, 1500, 2500, 3500]);                     // 500/1000/2000/3000 + 500 of jitter (random 0.5)
    last().open();
    last().frame({ t: "snapshot" });                                    // the hub said something: the backoff resets
    last().drop();
    let waited = 0;
    const before = sockets.length;
    while (sockets.length === before && waited < 120_000) { await vi.advanceTimersByTimeAsync(100); waited += 100; }
    expect(waited).toBe(1000);                                          // back to the first step
  });
});

describe("offline", () => {
  it("stops retrying while offline and shows it; online reconnects at once", () => {
    start();
    online = false;
    conn.offline();
    expect(transports.at(-1)).toBe("offline");
    expect(sockets[0]?.closed).toBe(1000);
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets).toHaveLength(1);                                    // no retries
    online = true;
    conn.online();
    expect(sockets).toHaveLength(2);
    expect(transports.at(-1)).toBe("connecting");
  });
  it("a close while the browser says it is offline doesn't retry either", () => {
    start();
    online = false;
    last().drop();
    expect(transports.at(-1)).toBe("offline");
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
  it("starting offline opens nothing until online", () => {
    online = false;
    conn.start();
    expect(sockets).toHaveLength(0);
    expect(transports).toEqual(["offline"]);
    online = true;
    conn.online();
    expect(sockets).toHaveLength(1);
  });
});

describe("ended", () => {
  it("a 4401 close (signed out) ends the connection: no retries", () => {
    start();
    last().drop(4401);
    expect(transports.at(-1)).toBe("ended");
    vi.advanceTimersByTime(10 * 60_000);
    conn.wake();
    expect(sockets).toHaveLength(1);
  });
});

describe("phase B review fixes", () => {
  it("a wake while the socket is still connecting changes nothing (M1)", () => {
    conn.start();
    conn.wake(); conn.wake();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.closed).toBeNull();
  });
  it("three wake events after a long sleep open one replacement, not three (M1)", () => {
    start();
    vi.setSystemTime(Date.now() + 6 * 60_000);
    conn.wake(); conn.wake(); conn.wake();                               // visibilitychange, focus, pageshow
    expect(sockets).toHaveLength(2);
  });
  it("a handshake that never completes is given up after its deadline and tried again (M2)", async () => {
    conn.start();
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS - 1);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets[0]?.closed).toBe(4000);
    await vi.advanceTimersByTimeAsync(backoff(0, () => 0.5));
    expect(sockets).toHaveLength(2);
  });
  it("Offline isn't sticky: a wake when the browser says online again reconnects, and so does the periodic check (M3)", () => {
    online = false;
    conn.start();
    online = true;
    conn.wake();
    expect(sockets).toHaveLength(1);
    online = false;
    conn.offline();
    online = true;
    vi.advanceTimersByTime(OFFLINE_CHECK_MS);                           // the 'online' event never came
    expect(sockets).toHaveLength(2);
  });
  it("a handshake refused because the session ended is told apart from a network failure: ended (M4)", async () => {
    conn.start();
    session = "ended";
    last().drop(1006);                                                  // a 401 on the upgrade looks like this to a browser
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionChecks).toBe(1);
    expect(transports.at(-1)).toBe("ended");
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
  it("a handshake that fails with the session still valid is retried as usual (M4)", async () => {
    conn.start();
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(transports.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(BACKOFF_MS[0] + 1000);
    expect(sockets).toHaveLength(2);
  });
  it("the backoff resets on the first frame, not on open: a socket the hub closes at once keeps backing off (L6)", async () => {
    const waits: number[] = [];
    conn.start();
    for (let i = 0; i < 3; i++) {
      last().open();
      last().drop(1011);
      const before = sockets.length;
      let waited = 0;
      while (sockets.length === before && waited < 120_000) { await vi.advanceTimersByTimeAsync(100); waited += 100; }
      waits.push(waited);
    }
    expect(waits).toEqual([1000, 1500, 2500]);
    last().open();
    last().frame({ t: "snapshot" });
    last().drop(1006);
    let waited = 0;
    const before = sockets.length;
    while (sockets.length === before && waited < 120_000) { await vi.advanceTimersByTimeAsync(100); waited += 100; }
    expect(waited).toBe(1000);
  });
});
