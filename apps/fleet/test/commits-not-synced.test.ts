// The "not synced" side of the fleet core's §16.4 rule in fleet.db (fleet clients spec §6; reconciliation ruling 59): once
// a hook's intake commit is on the disk, what follows it is bookkeeping and commits under NORMAL: the subscriber's
// delivered mark, the lane event's batch to the manager (its mirror row, its audit, its sent mark), and the mirror's next
// state. A lost one means one more delivery, which the receiver skips by its key or id. Only the intake is synced.
import { describe, expect, it, vi } from "vitest";
import type { Pane } from "@morndo/protocol";
import { startTestFleet } from "./helpers/fleet.ts";
import { deliveryOf, nodeQueue } from "./helpers/node-queue.ts";
import { startSubscriber } from "./helpers/subscriber.ts";
import { FULL_THEN_NORMAL, watchSyncs } from "./helpers/syncs.ts";

const HEADER = "[lane-event] Lane events (handle them as your instructions say):";
const pane = (n: number, window: string): Pane => ({ workerId: `pc.3fa2c1d0.${n}`, window, cwd: "/w", status: "idle", pid: n });

describe("fleet.db's bookkeeping is not synced", () => {
  it("a hook delivered to a subscriber and its lane event delivered to the manager: one synced commit, the intake's", async () => {
    const kira = await startSubscriber();
    const fleet = await startTestFleet({
      config: { subscribers: [{ name: "kira", url: kira.url, paths: ["/hook/stop"] }], laneEvents: { deliverTo: "manager", header: HEADER, ignore: [], batchMs: 100 } },
      delivery: { tickMs: 20 },
    });
    const pc = await fleet.online("pc");
    nodeQueue(pc);
    pc.inventory([pane(0, "manager"), pane(1, "api")]);
    await vi.waitFor(() => expect(fleet.lanes.get("manager")).not.toBeNull());
    const syncs = watchSyncs(fleet.db);                                               // after the admission (its epoch is synced)
    pc.hook(1, "/hook/stop", { text: "STATUS: DONE" }, { window: "api" });
    expect(await pc.acked(1)).toBe(1);
    await vi.waitFor(() => expect(fleet.outbox.states("kira")).toEqual({ delivered: 1 }));          // the subscriber's mark
    const id = `fleet:lane-events:pc:${1_700_000_000_001}`;
    await vi.waitFor(() => expect(fleet.db.prepare("SELECT to_manager, delivery_id FROM lane_events").get()).toEqual({ to_manager: 1, delivery_id: id }));
    expect(fleet.deliveries.get(id)?.delivery.state).toBe("queued");                // the batch, mirrored and audited
    pc.delivery(deliveryOf("pc", id, { target: { lane: "manager" }, state: "delivered", deliveredAt: 1 }));   // the node's next state
    await vi.waitFor(() => expect(fleet.deliveries.get(id)?.delivery.state).toBe("delivered"));
    expect(syncs).toEqual(FULL_THEN_NORMAL);                                          // negative control: a synced mark adds a pair
  });
});
