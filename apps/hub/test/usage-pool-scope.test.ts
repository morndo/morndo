// The usage-pool scope (U15): an agent token's authority beyond its role — a closed list, kept with the token across
// the store, shown by whoami, and the only way through the pool route; a role is not the scope. Real code only: none
// of this waits for round 2's pool seat itself.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

let hub: InProcessHub;
beforeEach(async () => { hub = await startInProcessHub(); });
afterEach(async () => { await hub.close(); });

describe("the usage-pool scope (U15)", () => {
  it("a token's scopes are kept with it, deduplicated, shown by whoami and in the list; none without one", async () => {
    const { token, secret } = hub.agents.issue("pool", "manager", ["usage-pool", "usage-pool"]);
    expect(token.scopes).toEqual(["usage-pool"]);
    expect(hub.store.agentToken(token.id)?.scopes).toEqual(["usage-pool"]);            // the store keeps them
    expect(hub.agents.list().find(t => t.id === token.id)?.scopes).toEqual(["usage-pool"]);
    const r = await fetch(`${hub.base}/api/agent/whoami`, { headers: { authorization: `Bearer ${secret}` } });
    expect(await r.json()).toEqual({
      actor: { kind: "manager", name: "manager", token: token.id },
      token: { id: token.id, name: "pool", role: "manager", scopes: ["usage-pool"] },
    });
    expect(hub.agents.issue("lanes", "worker").token.scopes).toEqual([]);              // a token minted with none
  });

  it("a scope word outside the closed list is a caller's mistake, never stored", () => {
    expect(() => hub.agents.issue("x", "worker", ["usage-pool", "admin"])).toThrow(TypeError);
    expect(hub.agents.list().flatMap(t => [...t.scopes]).every(s => s === "usage-pool")).toBe(true);
  });

  it("the pool route takes only a token with the scope: the manager's own is refused without it", async () => {
    const managerToken = hub.agents.issue("manager", "manager").secret;
    const r = await fetch(`${hub.base}/api/agent/usage/pool`, {
      method: "POST", headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ account: "seat-a", action: "set", state: "out", by: "manager-one" }),
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "scope_required" });
  });
});
