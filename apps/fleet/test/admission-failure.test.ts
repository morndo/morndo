// An admission whose fleet.db writes fail (busy past the timeout, or full) changes nothing: the newcomer is closed 1011
// and the live connection stays live, routed and announced (B6 V41). Before, #admitNow took the live connection out and
// closed it before the writes, so a failed write left the node with no connection while /v1/events subscribers never
// heard "offline" and a read on the old connection waited for its deadline. The failure is a real SQLITE_BUSY: another
// connection holds fleet.db's write lock (the service's connection waits 50 ms for it here instead of 5 s).
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { FleetEvent } from "../src/application/events.ts";
import { startTestFleet } from "./helpers/fleet.ts";

const statuses = (events: FleetEvent[]) => events.filter(e => e.t === "status" && e.node === "pc").map(e => (e.body as { status: string }).status);

describe("an admission fleet.db can't record", () => {
  it("closes the newcomer 1011 and leaves the live connection live, routed and announced", async () => {
    const fleet = await startTestFleet();
    const events: FleetEvent[] = [];
    fleet.events.subscribe(e => events.push(e));
    const first = await fleet.online("pc");
    fleet.db.pragma("busy_timeout = 50");
    const locker = new Database(fleet.config.dbPath);
    try {
      locker.exec("BEGIN IMMEDIATE");
      const again = fleet.agent({ node: "pc", key: first.key, instanceId: first.instanceId, streamId: first.streamId });
      expect(await again.connect()).toMatchObject({ ok: false, closed: { code: 1011 } });
    } finally {
      if (locker.inTransaction) locker.exec("ROLLBACK");
      locker.close();
    }
    expect(first.open).toBe(true);
    expect(fleet.connections.liveInstance("pc")?.instanceId).toBe(first.instanceId);
    expect(fleet.connections.status("pc")).toBe("online");
    expect(await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 2000 })).toMatchObject({ ok: true });
    expect(statuses(events)).toEqual(["online"]);
  });
});
