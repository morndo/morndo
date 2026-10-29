// Lane stalls, fresh review (2026-10-29): a wake-up's hold must survive a fleet restart. At start the watch rebuilds its
// turns before any node has sent its health, so the node's UTC offset is not known yet; the hold is taken once it is,
// or every release brings back the "own wake-up still armed" stale events the change removed.
import { describe, expect, it } from "vitest";
import type { LaneEvent } from "@morndo/protocol";
import type { LaneEventDraft } from "../src/adapters/lane-events-store.ts";
import type { DeliveryRequest } from "../src/application/deliveries.ts";
import { LaneWatch } from "../src/application/lane-watch.ts";
import { quiet } from "./helpers/fleet.ts";

const MIN = 60_000;
const T0 = 1_700_000_000_000;                                                          // 23:13:20 on a node at UTC+1
const FIRE = Date.parse("2023-11-15T01:13:00.000Z");                                   // its 02:13 wake-up

describe("lane stalls: a fleet restart", () => {
  it("keeps a wake-up's hold when the node's offset arrives after the rebuild", () => {
    let now = T0 + 20 * MIN;                                                           // the fleet restarts 20 min after the turn
    let tz: number | null = null;                                                      // no health from the node yet
    const raised: LaneEventDraft[] = [];
    const nudged: DeliveryRequest[] = [];
    const watch = new LaneWatch({
      config: { waitingMin: 30, noStatusMin: 15, nudge: true }, log: quiet, now: () => now, alive: () => true,
      nudgeTarget: () => "pc.3fa2c1d0.1", tzOffsetOf: () => tz,
      raise: d => { raised.push(d); return { ...d, seq: raised.length } as LaneEvent; },
      nudge: async r => { nudged.push(r); return { ok: true }; },
    });
    const turn: LaneEvent = {
      v: 1, t: "lane", seq: 1, event: "finished", node: "pc", window: "api", lane: "api", at: T0, status: "waiting",
      firstLine: "STATUS: WAITING T-516 on the 05:00Z release", waitingOn: "the 05:00Z release", until: T0 + 30 * MIN,
      bg: 0, crons: 1, wakes: [{ schedule: "13 2 * * *", recurring: false }],
    };
    watch.rebuild([turn]);
    tz = 60;                                                                           // the node's health arrives
    now = T0 + 51 * MIN;                                                               // the restart's own lease has passed
    watch.sweep();
    now = FIRE + 4 * MIN;
    watch.sweep();
    expect([nudged, raised]).toEqual([[], []]);
    now = FIRE + 6 * MIN;
    watch.sweep();
    expect(nudged).toHaveLength(1);
    expect(raised).toEqual([]);
  });
});
