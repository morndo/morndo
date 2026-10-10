// The instance check's last round (B6 V42): a newcomer whose check finds the live connection silent is admitted in that
// same round, whichever round it is. Before, the silent connection was terminated and the loop went on to the next
// round; after the last one it refused the newcomer 4409, so the node was left with no connection, no "offline" event,
// and a refused agent that asks again only every 5 minutes. Here instance A's connections never answer pings (a hung
// agent), and A replaces its own connection twice while instance B waits, so B's check reaches its third round.
import { describe, expect, it } from "vitest";
import type { FakeAgent } from "./helpers/fake-agent.ts";
import { startTestFleet } from "./helpers/fleet.ts";

describe("the instance check", () => {
  it("admits the newcomer when the live connection misses its pong in the last round", async () => {
    const fleet = await startTestFleet({ instancePongMs: 600 });
    const a1 = await fleet.joined("pc");
    expect((await a1.connect({ autoPong: false })).ok).toBe(true);
    const same = (): FakeAgent => fleet.agent({ node: "pc", key: a1.key, instanceId: a1.instanceId, streamId: a1.streamId });
    const b = fleet.agent({ node: "pc", key: a1.key });                  // another instance, the same key
    const firstPing = new Promise<void>(r => a1.ws?.once("ping", () => r()));
    const bResult = b.connect();
    await firstPing;                                                     // B's round 1 pings A1
    expect((await same().connect({ autoPong: false })).ok).toBe(true);   // A2 replaces A1: B's round 2 pings A2
    await new Promise(r => setTimeout(r, 100));
    const a3 = same();
    expect((await a3.connect({ autoPong: false })).ok).toBe(true);       // A3 replaces A2: B's round 3 pings A3
    const r = await bResult;                                             // A3 never answers
    expect(r.ok).toBe(true);
    expect(fleet.connections.liveInstance("pc")?.instanceId).toBe(b.instanceId);
    expect(fleet.connections.status("pc")).toBe("online");
    expect((await a3.closed).code).toBe(1006);                           // terminated
  }, 20_000);
});
