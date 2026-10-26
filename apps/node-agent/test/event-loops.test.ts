// The inventory and health loops (spec §5.4; events.ts). Review (fleet-clients branch) #11: the inventory goes to the
// fleet as soon as it is read; what the agent does with it on its own side (the deliverer's kick, lane state events,
// which may wait for a menu to draw and capture a screen) never holds it back. Fakes only: no tmux, no fleet.
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@morndo/protocol";
import { EventLoops, utcOffsetMin } from "../src/events.ts";
import type { Inventory, Snapshot } from "../src/ops/inventory.ts";
import { createLogger } from "../src/log.ts";

const snapshot: Snapshot = { invVersion: 7, stamp: null, panes: [{ workerId: "pc.aaaaaaaa.0", window: "api", cwd: "/w", status: "waiting", pid: 1 }], lanes: [], rows: [] };

describe("the inventory loop", () => {
  it("sends the inventory at once, while acting on it (a lane that just turned waiting) still runs", async () => {
    const sent: { m: AgentMessage; at: number }[] = [];
    let acted = 0;
    const loops = new EventLoops({
      inventory: { refresh: async () => snapshot } as unknown as Inventory,
      send: m => { sent.push({ m, at: Date.now() }); return true; },
      health: async () => { throw new Error("not in this test"); },
      log: createLogger({ level: "error", sink: () => {} }),
      pollMs: 60_000, healthMs: 60_000,
      onInventory: async () => { await new Promise(r => setTimeout(r, 600)); acted = Date.now(); },
    });
    const t0 = Date.now();
    loops.online();
    await new Promise(r => setTimeout(r, 900));
    loops.stop();
    const inventory = sent.find(s => s.m.t === "ev.inventory");
    expect(inventory?.m).toMatchObject({ t: "ev.inventory", invVersion: 7 });
    expect(acted).toBeGreaterThan(0);                                         // it was acted on all the same
    expect((inventory?.at ?? Infinity) - t0).toBeLessThan(300);               // held back by the 600 ms it acted for
  });
});

describe("the node's UTC offset (Health.tzOffsetMin, ADR-0032)", () => {
  const tz = process.env.TZ;
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });
  const at = (zone: string, iso: string) => { process.env.TZ = zone; return utcOffsetMin(new Date(iso)); };

  it("is east positive, in minutes, and follows daylight saving", () => {
    expect(at("Asia/Kolkata", "2026-10-20T12:00:00Z")).toBe(330);            // negative control: without the minus, -330
    expect(at("America/New_York", "2026-01-15T12:00:00Z")).toBe(-300);
    expect(at("America/New_York", "2026-07-15T12:00:00Z")).toBe(-240);
    expect(at("Europe/Berlin", "2026-10-20T12:00:00Z")).toBe(120);
    expect(at("Europe/Berlin", "2026-10-26T12:00:00Z")).toBe(60);
    expect(Object.is(at("UTC", "2026-10-20T12:00:00Z"), 0)).toBe(true);     // a plain 0, never -0
    process.env.TZ = "Asia/Kolkata";
    expect(utcOffsetMin()).toBe(330);                                          // now, by default
  });
});
