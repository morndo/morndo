// The inventory and health loops (spec §5.4; events.ts). Review (fleet-clients branch) #11: the inventory goes to the
// fleet as soon as it is read; what the agent does with it on its own side (the deliverer's kick, lane state events,
// which may wait for a menu to draw and capture a screen) never holds it back. Fakes only: no tmux, no fleet.
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@morndo/protocol";
import { EventLoops } from "../src/events.ts";
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
