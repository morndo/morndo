// An op routed to a node whose socket is already closing (the close frame sent or received, its 'close' event not yet
// in) is refused node_offline, executed: no, at once (B6 V40). Before, Connections still held the connection, the
// session dropped the frame unsent (it sends only while OPEN), and a side-effecting op answered uncertain (executed:
// maybe) at its deadline: a send in doubt that was never sent. The close here is the fleet's own (an agent over its
// message rate is closed 1008); the op is routed right after it, while ws reports readyState CLOSING.
import { describe, expect, it } from "vitest";
import type { Outcome } from "../src/application/requests.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { until } from "./helpers/until.ts";

const args = { workerId: "pc.3fa2c1d0.1", text: "hello", expect: { server: "3fa2c1d0", window: "api" } };

describe("a connection that is closing", () => {
  it("refuses a side-effecting op node_offline (executed: no) at once and sends nothing", async () => {
    const fleet = await startTestFleet({ resultSlackMs: 50, agentLimits: { capacity: 1, refillPerSecond: 0.0001 } });
    const a = await fleet.online("pc");
    let routed: { status: string; at: number; out: Promise<Outcome> } | null = null;
    fleet.events.subscribe(e => {
      if (e.t !== "alert" || (e.body as { kind: string }).kind !== "rate_limited") return;
      setImmediate(() => {                                              // after the session's close(1008): CLOSING
        routed = { status: fleet.connections.status("pc"), at: performance.now(), out: fleet.connections.request("pc", "pane.send", args, { key: "hub:closing", timeoutMs: 400 }) };
      });
    });
    a.health(); a.health();                                              // the second is over the bucket
    expect((await a.closed).code).toBe(1008);
    await until(() => routed !== null);
    const r = routed as unknown as { status: string; at: number; out: Promise<Outcome> };
    const out = await r.out;
    expect(r.status).toBe("online");                                    // routed before the 'close' event came
    expect(out).toMatchObject({ ok: false, error: { code: "node_offline", executed: "no" } });
    expect(performance.now() - r.at).toBeLessThan(300);                  // not at the 400 ms deadline
    expect(a.reqs).toEqual([]);
  });
});
