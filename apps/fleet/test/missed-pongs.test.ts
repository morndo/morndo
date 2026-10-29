// T-532: the fleet ends a node's connection only after three missed pongs in a row (LIMITS.missedPongsMax), not one.
// A node whose agent stalled on a saturated disk for 10 to 15 s missed one pong and dropped offline although it was up.
// Pings run every LIMITS.pingMs on fake timers (setInterval only); the sockets run for real.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@morndo/protocol";
import type { FleetEvent } from "../src/application/events.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { until } from "./helpers/until.ts";

afterEach(() => { vi.useRealTimers(); });
const settle = () => new Promise(r => setTimeout(r, 5));       // real time for the sockets between fake ticks
const statuses = (events: FleetEvent[], node: string) => events.filter(e => e.t === "status" && e.node === node).map(e => (e.body as { status: string }).status);

describe("missed pongs (T-532)", () => {
  it("three in a row end the connection; one ping every 15 s", () => {
    expect(LIMITS.pingMs).toBe(15_000);
    expect(LIMITS.missedPongsMax).toBe(3);
  });

  it("a node that misses 2 pongs stays connected and online; the 3rd ends it: online, stale, offline", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fleet = await startTestFleet();
    const seen: FleetEvent[] = [];
    fleet.events.subscribe(e => seen.push(e));
    const a = await fleet.joined("pc");
    expect((await a.connect({ autoPong: false })).ok).toBe(true);   // a stalled process: the socket stays, pongs stop
    vi.advanceTimersByTime(LIMITS.pingMs);                          // ping 1
    await settle();
    vi.advanceTimersByTime(LIMITS.pingMs);                          // ping 1 missed (1), ping 2
    await settle();
    vi.advanceTimersByTime(LIMITS.pingMs);                          // ping 2 missed (2), ping 3
    await settle();
    expect(a.open).toBe(true);
    expect(fleet.connections.status("pc")).toBe("online");
    expect(statuses(seen, "pc")).toEqual(["online"]);
    vi.advanceTimersByTime(LIMITS.pingMs);                          // ping 3 missed (3): stale, terminated
    expect((await a.closed).code).toBe(1006);
    await until(() => statuses(seen, "pc").length === 3);
    expect(statuses(seen, "pc")).toEqual(["online", "stale", "offline"]);
  }, 60_000);

  it("a pong after two misses starts the count again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fleet = await startTestFleet();
    const pongs = vi.spyOn(fleet.connections, "pong");
    const a = await fleet.joined("pc");
    expect((await a.connect({ autoPong: false })).ok).toBe(true);
    vi.advanceTimersByTime(LIMITS.pingMs);                          // ping 1
    await settle();
    vi.advanceTimersByTime(LIMITS.pingMs);                          // missed (1), ping 2
    await settle();
    vi.advanceTimersByTime(LIMITS.pingMs);                          // missed (2), ping 3
    await settle();
    a.ws?.pong();                                                   // the stall ends: a late pong
    await until(() => pongs.mock.calls.length === 1);
    for (let i = 0; i < 3; i++) {                                   // two more misses after it, and the next ping
      vi.advanceTimersByTime(LIMITS.pingMs);
      await settle();
    }
    expect(a.open).toBe(true);
    expect(fleet.connections.status("pc")).toBe("online");
    vi.advanceTimersByTime(LIMITS.pingMs);                          // the third miss since the pong
    expect((await a.closed).code).toBe(1006);
  }, 60_000);
});
