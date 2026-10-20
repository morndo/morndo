// Role saves go through RoutingService. A stand-in that throws from setChain is never handed to applyRole.
import { describe, expect, it } from "vitest";
import { ok } from "@morndo/domain";
import type { VendorPreset } from "@morndo/protocol";
import type { Actor } from "@morndo/domain";
import { ConnectionsService, RoutingService, applyRole, bindCommands, memory } from "../src/application/index.ts";

const who: Actor = { kind: "principal", command: "c1" };

function preset(): VendorPreset {
  return {
    id: "vendor-a", label: "Vendor A", custody: "morndo", kinds: ["api-key", "subscription"],
    runtimes: [{ runtime: "runtime-a", dialect: "dialect-a", baseUrl: null }],
    models: { source: "static", ids: ["m"] }, family: "family-a", keyShapes: [], spend: ["manual"], prices: [],
    balance: null, defaultPicks: { "*": "m@high" }, isolation: "rules",
    terms: { revision: "r1", summary: "Read before use.", sources: ["https://example.com/terms"] },
  };
}

describe("page commands", () => {
  it("saves a role through RoutingService, which is what writes the chain", async () => {
    const mem = memory();
    mem.catalog.rows = [preset()];
    mem.vault.put("ref-a", "0123456789ab");
    const connections = new ConnectionsService(mem.deps);
    expect(connections.addSubscription({ name: "sub-a", vendor: "vendor-a", runtime: "runtime-a", configDir: "/cfg" }, who).ok).toBe(true);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    const bound = bindCommands(mem.deps);
    const version = mem.store.version;
    const saved = bound.role({ version, role: "implement", override: "follow", order: ["sub-a", "key-a"], picks: ["sub-a:m@high"], action: "save" }, "hub");
    expect(saved.ok).toBe(true);
    expect(mem.engines.writes.map(write => write.entries.join(","))).toEqual(["sub-a:m@high"]);
    expect(bound.page().roles[0]?.chain).toEqual(["sub-a:m@high"]);
    expect(JSON.stringify(bound.page())).not.toContain("ref-a");
  });

  it("calls the routing service and has no engine client of its own", () => {
    const calls: string[] = [];
    const routing = {
      commitPriority: () => ok(undefined),
      commitRole: () => { calls.push("commit"); return ok(undefined); },
      reapply: () => { calls.push("reapply"); return ok(undefined); },
    };
    expect(applyRole(routing, { role: "implement", override: "own", order: ["key-a"], picks: ["key-a:m"], action: "save" }, "hub").ok).toBe(true);
    expect(calls).toEqual(["commit"]);
    expect(applyRole(routing, { role: "implement", override: "follow", order: [], picks: [], action: "reapply" }, "hub").ok).toBe(true);
    expect(calls).toEqual(["commit", "reapply"]);
  });

  it("keeps a role's risk picks when the page save does not send them", async () => {
    const mem = memory();
    mem.catalog.rows = [preset()];
    mem.vault.put("ref-a", "0123456789ab");
    const connections = new ConnectionsService(mem.deps);
    const routing = new RoutingService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(routing.setOverride("implement", "follow", null, "c1").ok).toBe(true);
    expect(routing.setPriority("keys-only", ["key-a"], "c1").ok).toBe(true);
    expect(routing.setPicks("implement", ["key-a:m@high"], ["key-a:m@high"], "c1").ok).toBe(true);
    expect(routing.save().ok).toBe(true);
    const saved = bindCommands(mem.deps).role({
      version: mem.store.version, role: "implement", override: "follow", order: ["key-a"], picks: ["key-a:m@high"], action: "save",
    }, "hub");
    expect(saved.ok).toBe(true);
    expect(mem.engines.chains().find(chain => chain.role === "implement")?.risk).toEqual(["key-a:m@high"]);
  });

  it("leaves the stored policy unchanged when a page command fails", async () => {
    const mem = memory();
    mem.catalog.rows = [preset()];
    mem.vault.put("ref-a", "0123456789ab");
    const connections = new ConnectionsService(mem.deps);
    const routing = new RoutingService(mem.deps);
    expect(connections.addSubscription({ name: "sub-a", vendor: "vendor-a", runtime: "runtime-a", configDir: "/cfg" }, who).ok).toBe(true);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(routing.setOverride("implement", "follow", null, "c1").ok).toBe(true);
    expect(routing.setPriority("keys-only", ["sub-a", "key-a"], "c1").ok).toBe(true);
    expect(routing.setPicks("implement", ["sub-a:m@high", "key-a:m@high"], null, "c1").ok).toBe(true);
    expect(routing.save().ok).toBe(true);
    mem.engines.failOn = mem.engines.writes.length + 1;
    const bound = bindCommands(mem.deps);
    const changed = bound.priority({ version: mem.store.version, mode: "subscriptions-only", order: ["sub-a", "key-a"] }, "hub");
    expect(changed.ok).toBe(false);
    expect(mem.store.policy.priority.mode).toBe("keys-only");
    const unfit = bound.role({
      version: mem.store.version, role: "implement", override: "own", order: ["key-a"], picks: ["nope"], action: "save",
    }, "hub");
    expect(unfit.ok).toBe(false);
    expect(mem.store.policy.roles.find(item => item.role === "implement")?.override).toBe("follow");
  });

  it("turns global auto on through the priority command and records the switch", async () => {
    const mem = memory();
    mem.catalog.rows = [preset()];
    mem.vault.put("ref-a", "0123456789ab");
    const connections = new ConnectionsService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    const bound = bindCommands(mem.deps);
    const switched = bound.priority({ version: mem.store.version, mode: "keys-only", order: ["key-a"], auto: true }, "hub");
    expect(switched.ok).toBe(true);
    expect(mem.store.policy.priority.auto).toBe(true);
    expect(mem.store.policy.events.some(event => event.type === "AutoSwitched" && event.on)).toBe(true);
  });

  it("switching auto through the priority command writes nothing: no event, no pending chain (R16)", async () => {
    const mem = memory();
    mem.catalog.rows = [preset()];
    mem.vault.put("ref-a", "0123456789ab");
    const connections = new ConnectionsService(mem.deps);
    const routing = new RoutingService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(routing.setOverride("implement", "follow", null, "c1").ok).toBe(true);
    expect(routing.setPriority("keys-only", ["key-a"], "c1").ok).toBe(true);
    expect(routing.setPicks("implement", ["key-a:m@high"], null, "c1").ok).toBe(true);
    const before = mem.store.policy;
    expect(before.roles.find(item => item.role === "implement")?.written).toBeNull();
    const writes = mem.engines.writes.length;
    const bound = bindCommands(mem.deps);
    const switched = bound.priority({ version: mem.store.version, mode: "keys-only", order: ["key-a"], auto: true }, "hub");
    expect(switched.ok).toBe(true);
    const after = mem.store.policy;
    expect(after.priority.auto).toBe(true);
    expect(mem.engines.writes.length).toBe(writes);
    expect(after.roles).toEqual(before.roles);
    expect(after.events.slice(before.events.length).map(event => event.type)).toEqual(["AutoSwitched"]);
    const off = bound.priority({ version: mem.store.version, mode: "keys-only", order: ["key-a"], auto: false }, "hub");
    expect(off.ok).toBe(true);
    expect(mem.engines.writes.length).toBe(writes);
    expect(mem.store.policy.roles).toEqual(before.roles);
  });

  it("checks the saved order and picks together, and names risk picks that no longer fit", async () => {
    const mem = memory();
    mem.catalog.rows = [preset()];
    mem.vault.put("ref-a", "0123456789ab");
    const connections = new ConnectionsService(mem.deps);
    const routing = new RoutingService(mem.deps);
    expect(connections.addSubscription({ name: "sub-a", vendor: "vendor-a", runtime: "runtime-a", configDir: "/cfg" }, who).ok).toBe(true);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(routing.setOverride("implement", "follow", null, "c1").ok).toBe(true);
    expect(routing.setPriority("custom", ["sub-a", "key-a"], "c1").ok).toBe(true);
    expect(routing.setPicks("implement", ["sub-a:m@high"], ["sub-a:m@high"], "c1").ok).toBe(true);
    expect(routing.save().ok).toBe(true);
    let loads = 0;
    const inner = mem.store;
    const store = {
      load: () => { loads += 1; return inner.load(); },
      save: (directory: typeof inner.directory, policy: typeof inner.policy, version: number) => inner.save(directory, policy, version),
    };
    const saved = bindCommands({ ...mem.deps, store }).role({
      version: inner.version, role: "implement", override: "own", order: ["key-a"], picks: ["key-a:m@high"], action: "save",
    }, "hub");
    expect(loads).toBe(2);
    expect(saved.ok).toBe(false);
    expect(saved.ok ? "" : saved.problem).toContain("sub-a:m@high");
    expect(inner.policy.roles.find(item => item.role === "implement")?.override).toBe("follow");
    expect(routing.setPicks("implement", ["sub-a:m@high"], null, "c1").ok).toBe(true);
    expect(routing.save().ok).toBe(true);
    const moved = bindCommands(mem.deps).role({
      version: mem.store.version, role: "implement", override: "own", order: ["key-a"], picks: ["key-a:m@high"], action: "save",
    }, "hub");
    expect(moved.ok).toBe(true);
    expect(mem.engines.chains().find(chain => chain.role === "implement")?.chain).toEqual(["key-a:m@high"]);
  });
});
