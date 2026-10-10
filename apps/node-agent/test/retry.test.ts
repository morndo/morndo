// Backoff for dialing the fleet (spec §5.2): 1 s to 60 s, full jitter, on the monotonic clock. Plan Review Focus 4: a
// wall-clock jump during backoff changes nothing; checked with fake timers (setTimeout, performance) and a mocked Date
// moved by an hour in each direction.
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetConnection } from "../src/conn/connection.ts";
import { RetrySchedule } from "../src/conn/retry.ts";
import type { ConnStatus } from "../src/conn/status-file.ts";
import { createNodeKey, fleetPublicKey } from "../src/identity.ts";
import { captureLog } from "./helpers.ts";

afterEach(() => { vi.useRealTimers(); });

describe("full-jitter backoff", () => {
  it("bounds grow 1 s, 2 s, 4 s … up to 60 s; the jitter is a fraction of the bound", () => {
    const top = new RetrySchedule({ random: () => 1 });
    expect(Array.from({ length: 9 }, () => top.nextDelay())).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    const half = new RetrySchedule({ random: () => 0.5 });
    expect([half.nextDelay(), half.nextDelay(), half.nextDelay()]).toEqual([500, 1000, 2000]);
    expect(new RetrySchedule({ random: () => 0 }).nextDelay()).toBe(0);
  });
  it("starts from the base again after reset (a welcome)", () => {
    const r = new RetrySchedule({ random: () => 1 });
    r.nextDelay(); r.nextDelay(); r.nextDelay();
    r.reset();
    expect(r.nextDelay()).toBe(1000);
  });
  it("afterAbout jitters a fixed wait by ± a fraction (a refused second instance's 5 minutes ± 20 %)", () => {
    const at = (random: number) => { const r = new RetrySchedule({ random: () => random }); const d = r.afterAbout(300_000, 0.2, () => {}); r.cancel(); return d; };
    expect([at(0), at(0.5), at(1)]).toEqual([240_000, 300_000, 360_000]);
  });
});

describe("a wall-clock jump during backoff (Review Focus 4)", () => {
  it("neither fires the retry early nor holds it back, and the reported wait follows the monotonic clock", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const r = new RetrySchedule({ random: () => 1 });
    let fired = 0;
    r.backoff(() => { fired++; });                                     // 1000 ms
    vi.setSystemTime(Date.now() + 3_600_000);                          // the clock jumps an hour ahead
    expect(r.retryInMs()).toBe(1000);
    vi.advanceTimersByTime(999);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1);
    r.backoff(() => { fired++; });                                     // 2000 ms
    vi.setSystemTime(Date.now() - 7_200_000);                          // and two hours back
    expect(r.retryInMs()).toBe(2000);
    vi.advanceTimersByTime(1999);
    expect(fired).toBe(1);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(2);
    expect(r.retryInMs()).toBeNull();
  });

  it("the connection's redials to an unreachable fleet keep their monotonic schedule across jumps", async () => {
    const port = await new Promise<number>(resolve => {
      const srv = createServer().listen(0, "127.0.0.1", () => {
        const a = srv.address();
        srv.close(() => resolve(typeof a === "object" && a ? a.port : 0));
      });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const statuses: ConnStatus[] = [];
    const conn = new FleetConnection({
      url: `ws://127.0.0.1:${port}/agent`, node: "pc", instanceId: "i-1", streamId: "s-1",
      fleetKey: fleetPublicKey(createNodeKey().publicKey) ?? (() => { throw new Error("no key"); })(),
      nodeKey: createNodeKey(), caps: [], claudeVersion: () => null, log: captureLog().log,
      onWelcome: () => {}, onRequest: () => {}, onBadRequest: () => {}, onAck: () => {}, onDown: () => {},
      onStatus: s => { statuses.push(s); }, retry: { random: () => 1 },
    });
    const dials = () => statuses.filter(s => s.state === "connecting").length;
    // Real I/O (the refused TCP connect) still happens under fake timers; this waits for it without moving fake time.
    const settle = async (f: () => boolean) => { for (let i = 0; i < 20_000 && !f(); i++) await new Promise(r => setImmediate(r)); return f(); };
    conn.start();
    expect(await settle(() => dials() === 1 && conn.status().state === "backoff")).toBe(true);
    vi.setSystemTime(Date.now() + 3_600_000);
    expect(conn.status().retryInMs).toBe(1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(dials()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settle(() => dials() === 2 && conn.status().state === "backoff")).toBe(true);
    vi.setSystemTime(Date.now() - 7_200_000);
    expect(conn.status().retryInMs).toBe(2000);
    await vi.advanceTimersByTimeAsync(1999);
    expect(dials()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settle(() => dials() === 3)).toBe(true);
    await conn.stop();
  });
});
