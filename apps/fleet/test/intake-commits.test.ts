// The intake window inside the real fleet (spec §6): two nodes' hooks sent within the window are acknowledged after one
// synced commit; a connection the fleet closes (a revoked node) loses what it sent in the window, never stored; one the
// node closes has it stored, unacknowledged, and its next welcome says so (ackSeq).
import { describe, expect, it } from "vitest";
import { startTestFleet } from "./helpers/fleet.ts";
import { FULL_THEN_NORMAL, watchSyncs } from "./helpers/syncs.ts";
import { until } from "./helpers/until.ts";

// What fleet.db holds of each stream: its mark (the test fleet has no subscribers, so events are counted, not kept).
const marks = (db: { prepare(sql: string): { all(): unknown[] } }) => (db.prepare("SELECT node, seq FROM stream_hwm ORDER BY node").all() as { node: string; seq: number }[]).map(r => `${r.node}:${r.seq}`);

describe("hook events through the intake window", () => {
  it("two nodes' hooks in one window: one synced commit, then each node's ack", async () => {
    const fleet = await startTestFleet({ intakeWindowMs: 100 });
    const pc = await fleet.online("pc");
    const mac = await fleet.online("mac");
    const syncs = watchSyncs(fleet.db);                                               // after the admissions (their epochs are synced)
    pc.hook(1);
    mac.hook(1);
    pc.hook(2);
    expect(await pc.acked(2)).toBe(2);
    expect(await mac.acked(1)).toBe(1);
    expect(syncs).toEqual(FULL_THEN_NORMAL);
    expect(marks(fleet.db)).toEqual(["mac:1", "pc:2"]);
  });

  it("a revoked node's hooks still in the window are never stored; a node that hangs up has its hooks stored, unacknowledged", async () => {
    const fleet = await startTestFleet({ intakeWindowMs: 200 });
    const pc = await fleet.online("pc");
    pc.hook(1);
    await until(() => pc.inbox.length > 0 && pc.inbox.some(m => m.t === "ack"));      // 1 is stored and acknowledged
    pc.hook(2);
    await new Promise(r => setTimeout(r, 50));                                        // 2 has reached the window (200 ms)
    fleet.nodes.revoke("pc");
    fleet.connections.revoke("pc");                                                   // inside 2's window
    await new Promise(r => setTimeout(r, 300));
    expect(marks(fleet.db)).toEqual(["pc:1"]);                                        // negative control: without cancel(), pc:2

    const mac = await fleet.online("mac");
    mac.hook(1);
    mac.terminate();                                                                   // the node hangs up inside the window
    await until(() => marks(fleet.db).includes("mac:1"));
    const again = fleet.agent({ node: "mac", key: mac.key, instanceId: mac.instanceId, streamId: mac.streamId });
    expect(await again.connect()).toMatchObject({ ok: true, welcome: { ackSeq: 1, streamKnown: true } });
  });
});
