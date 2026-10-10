// Routing save, derive and drift against a fake EngineSettings (ADR-0018 §13 row 2).
import { describe, expect, it } from "vitest";
import type { VendorPreset } from "@morndo/protocol";
import type { Actor } from "@morndo/domain";
import { ConnectionsService, RoutingService, memory } from "../src/application/index.ts";

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

describe("routing save, derive and drift", () => {
  it("writes the derived chain and does not overwrite a chain changed outside", async () => {
    const mem = memory();
    mem.catalog.rows = [preset()];
    mem.vault.put("ref-a", "0123456789ab");
    const connections = new ConnectionsService(mem.deps);
    const routing = new RoutingService(mem.deps);
    expect(connections.addSubscription({ name: "sub-a", vendor: "vendor-a", runtime: "runtime-a", configDir: "/cfg" }, who).ok).toBe(true);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(routing.setOverride("implement", "follow", null, "c1").ok).toBe(true);
    expect(routing.setPriority("subscriptions-first", ["sub-a", "key-a"], "c1").ok).toBe(true);
    expect(routing.setPicks("implement", ["key-a:m@high", "sub-a:m@high"], null, "c1").ok).toBe(true);
    expect(routing.save().ok).toBe(true);
    expect(mem.engines.writes.map(write => write.entries.join(","))).toEqual(["sub-a:m@high,key-a:m@high"]);
    mem.engines.tamper("implement", ["sub-a:m@high"]);
    expect(routing.save().ok).toBe(true);
    expect(mem.engines.writes).toHaveLength(1);
    expect(routing.drift()).toEqual(["implement"]);
    expect(mem.alerts.raised.some(alert => alert.kind === "drift" && alert.name === "implement")).toBe(true);
    expect(mem.store.policy.events.some(event => event.type === "ChainDrifted")).toBe(true);
    expect(routing.reapply("implement").ok).toBe(true);
    expect(mem.engines.writes).toHaveLength(2);
  });

  it("follow saves an override when the chain already matches", async () => {
    const mem = memory();
    mem.catalog.rows = [preset()];
    mem.vault.put("ref-a", "0123456789ab");
    const connections = new ConnectionsService(mem.deps);
    const routing = new RoutingService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(routing.setOverride("implement", "follow", null, "c1").ok).toBe(true);
    expect(routing.setPriority("custom", ["key-a"], "c1").ok).toBe(true);
    expect(routing.setPicks("implement", ["key-a:m@high"], null, "c1").ok).toBe(true);
    expect(routing.save().ok).toBe(true);
    expect(routing.setOverride("implement", "hand", null, "c2").ok).toBe(true);
    const followed = routing.followAll(["implement"], mem.engines.chains());
    expect(followed.ok ? "ok" : followed.error.problem).toBe("ok");
    expect(mem.store.policy.roles.find(row => row.role === "implement")?.override).toBe("follow");
  });

  it("a hand role edited outside is not drift, and an emptied chain refuses the save", async () => {
    const mem = memory();
    mem.catalog.rows = [preset()];
    mem.vault.put("ref-a", "0123456789ab");
    const connections = new ConnectionsService(mem.deps);
    const routing = new RoutingService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(routing.setOverride("implement", "follow", null, "c1").ok).toBe(true);
    expect(routing.setPriority("custom", ["key-a"], "c1").ok).toBe(true);
    expect(routing.setPicks("implement", ["key-a:m@high"], null, "c1").ok).toBe(true);
    expect(routing.save().ok).toBe(true);
    expect(routing.setOverride("implement", "hand", null, "c2").ok).toBe(true);
    mem.engines.tamper("implement", ["key-a:other"]);
    expect(routing.drift()).toEqual([]);
    expect(routing.setOverride("review", "follow", null, "c3").ok).toBe(true);
    expect(routing.setPicks("review", ["key-a:m@high"], null, "c3").ok).toBe(true);
    const saved = routing.setPriority("subscriptions-only", ["key-a"], "c3");
    expect(saved.ok ? "" : saved.error).toMatchObject({ problem: "empty", role: "review" });
  });

  it("disables a revoked engine-layer provider at once and removes it once no chain names it", () => {
    const mem = memory();
    mem.catalog.rows = [{ ...preset(), id: "layer-a", custody: "engine-layer", kinds: ["api-key"] }];
    const connections = new ConnectionsService(mem.deps);
    const routing = new RoutingService(mem.deps);
    const layer = { vendor: "layer-a", runtime: "runtime-a", kind: "api-key" as const };
    expect(connections.addLayer({ name: "key-a", ...layer }, who).ok).toBe(true);
    expect(connections.addLayer({ name: "key-b", ...layer }, who).ok).toBe(true);
    expect(connections.acknowledge("key-a", "ada", who).ok).toBe(true);
    expect(connections.acknowledge("key-b", "ada", who).ok).toBe(true);
    expect(routing.setOverride("implement", "follow", null, "c1").ok).toBe(true);
    expect(routing.setPriority("custom", ["key-a", "key-b"], "c1").ok).toBe(true);
    expect(routing.setPicks("implement", ["key-a:m@high", "key-b:m@high"], null, "c1").ok).toBe(true);
    expect(routing.save().ok).toBe(true);
    expect(connections.revoke("key-a", who).ok).toBe(true);
    expect(mem.engines.providers.find(row => row.name === "key-a")).toEqual({ name: "key-a", enabled: false });
    const dropped = routing.save();
    expect(dropped.ok ? "ok" : dropped.error.problem).toBe("ok");
    expect(mem.engines.chains().find(chain => chain.role === "implement")?.chain).toEqual(["key-b:m@high"]);
    expect(mem.engines.providers.some(row => row.name === "key-a")).toBe(false);
    expect(routing.reapply("implement").ok).toBe(true);
    expect(mem.engines.providers.some(row => row.name === "key-a")).toBe(false);
    expect(mem.engines.chains().find(chain => chain.role === "implement")?.chain).toEqual(["key-b:m@high"]);
  });

  it("keeps the last chain of a role that derives empty and writes only the role that changed", async () => {
    const mem = memory();
    mem.catalog.rows = [preset()];
    mem.vault.put("ref-a", "0123456789ab");
    mem.vault.put("ref-b", "0123456789ac");
    const connections = new ConnectionsService(mem.deps);
    const routing = new RoutingService(mem.deps);
    const key = { vendor: "vendor-a", runtime: "runtime-a", billing: "metered" as const, budget: { kind: "capped" as const, amount: 10 }, expiry: null };
    expect((await connections.addKey({ name: "key-a", ref: "ref-a", ...key }, who)).ok).toBe(true);
    expect((await connections.addKey({ name: "key-b", ref: "ref-b", ...key }, who)).ok).toBe(true);
    expect(routing.setOverride("implement", "follow", null, "c1").ok).toBe(true);
    expect(routing.setOverride("review", "follow", null, "c1").ok).toBe(true);
    expect(routing.setOverride("plan", "follow", null, "c1").ok).toBe(true);
    expect(routing.setPriority("custom", ["key-a", "key-b"], "c1").ok).toBe(true);
    expect(routing.setPicks("implement", ["key-a:m@high", "key-b:m@high"], null, "c1").ok).toBe(true);
    expect(routing.setPicks("review", ["key-a:m@high"], null, "c1").ok).toBe(true);
    expect(routing.setPicks("plan", ["key-b:m@high"], null, "c1").ok).toBe(true);
    expect(routing.save().ok).toBe(true);
    const before = mem.engines.writes.length;
    expect(connections.revoke("key-a", who).ok).toBe(true);
    expect(routing.save().ok).toBe(true);
    expect(mem.engines.writes.slice(before).map(write => `${write.role}:${write.entries.join(",")}`)).toEqual(["implement:key-b:m@high"]);
    expect(mem.engines.chains().find(chain => chain.role === "review")?.chain).toEqual(["key-a:m@high"]);
    expect(mem.alerts.raised.some(alert => alert.kind === "kept" && alert.name === "review")).toBe(true);
    expect(mem.store.policy.events.some(event => event.type === "ChainKept" && event.role === "review")).toBe(true);
    const writes = mem.engines.writes.length;
    expect(routing.reapply("review").ok).toBe(true);
    expect(mem.engines.writes).toHaveLength(writes);
    expect(mem.engines.chains().find(chain => chain.role === "review")?.chain).toEqual(["key-a:m@high"]);
    const kept = () => mem.store.policy.events.filter(event => event.type === "ChainKept" && event.role === "review").length;
    const alerts = () => mem.alerts.raised.filter(alert => alert.kind === "kept" && alert.name === "review").length;
    const events = kept();
    const raised = alerts();
    expect(routing.save().ok).toBe(true);
    expect(routing.reapply("review").ok).toBe(true);
    expect(kept()).toBe(events);
    expect(alerts()).toBe(raised);
  });

  it("does not offer a revoked connection as a name, a kind or a listed model", async () => {
    const mem = memory();
    mem.catalog.rows = [preset()];
    mem.vault.put("ref-a", "0123456789ab");
    mem.vault.put("ref-b", "0123456789ac");
    const connections = new ConnectionsService(mem.deps);
    const routing = new RoutingService(mem.deps);
    const key = { vendor: "vendor-a", runtime: "runtime-a", billing: "metered" as const, budget: { kind: "capped" as const, amount: 10 }, expiry: null };
    expect((await connections.addKey({ name: "key-a", ref: "ref-a", ...key }, who)).ok).toBe(true);
    expect((await connections.addKey({ name: "key-b", ref: "ref-b", ...key }, who)).ok).toBe(true);
    expect(routing.setOverride("implement", "follow", null, "c1").ok).toBe(true);
    expect(routing.setPriority("custom", ["key-b"], "c1").ok).toBe(true);
    expect(routing.setPicks("implement", ["key-b:m@high"], null, "c1").ok).toBe(true);
    expect(connections.revoke("key-a", who).ok).toBe(true);
    mem.models.asked.length = 0;
    const priority = routing.setPriority("custom", ["key-a"], "c2");
    const picks = routing.setPicks("implement", ["key-a:m@high"], null, "c2");
    const saved = routing.save();
    expect(priority.ok ? "" : priority.error.problem).toBe("unknown");
    expect(picks.ok ? "" : picks.error.problem).toBe("empty");
    expect(saved.ok).toBe(true);
    expect(mem.models.asked).not.toContain("key-a");
    expect(mem.engines.writes.some(write => write.entries.some(entry => entry.startsWith("key-a:")))).toBe(false);
  });

  it("records a risk chain, and alerts once when that chain drifts", async () => {
    const mem = memory();
    mem.catalog.rows = [preset()];
    mem.vault.put("ref-a", "0123456789ab");
    const connections = new ConnectionsService(mem.deps);
    const routing = new RoutingService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(routing.setOverride("implement", "follow", null, "c1").ok).toBe(true);
    expect(routing.setPriority("custom", ["key-a"], "c1").ok).toBe(true);
    expect(routing.setPicks("implement", ["key-a:m@high"], ["key-a:m@high"], "c1").ok).toBe(true);
    expect(routing.save().ok).toBe(true);
    const row = mem.store.policy.roles.find(item => item.role === "implement");
    expect(row?.writtenRisk).toEqual(["key-a:m@high"]);
    mem.engines.tamperRisk("implement", ["key-a:m@low"]);
    expect(routing.drift()).toEqual(["implement"]);
    expect(routing.drift()).toEqual([]);
    expect(routing.drift()).toEqual([]);
    expect(mem.alerts.raised.filter(alert => alert.kind === "drift")).toHaveLength(1);
    expect(mem.store.policy.events.filter(event => event.type === "ChainDrifted")).toHaveLength(1);
    mem.engines.tamperRisk("implement", ["key-a:m@high"]);
    expect(routing.drift()).toEqual([]);
    mem.engines.tamperRisk("implement", ["key-a:m@low"]);
    expect(routing.drift()).toEqual(["implement"]);
    expect(mem.alerts.raised.filter(alert => alert.kind === "drift")).toHaveLength(2);
  });

  it("rolls the whole save back when an outside write fails", async () => {
    const mem = memory();
    mem.catalog.rows = [preset()];
    mem.vault.put("ref-a", "0123456789ab");
    const connections = new ConnectionsService(mem.deps);
    const routing = new RoutingService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(routing.setOverride("implement", "follow", null, "c1").ok).toBe(true);
    expect(routing.setOverride("review", "follow", null, "c1").ok).toBe(true);
    expect(routing.setPriority("custom", ["key-a"], "c1").ok).toBe(true);
    expect(routing.setPicks("implement", ["key-a:m@high"], null, "c1").ok).toBe(true);
    expect(routing.setPicks("review", ["key-a:m@high"], null, "c1").ok).toBe(true);
    mem.engines.failOn = 2;
    const saved = routing.save();
    expect(saved.ok ? "" : saved.error.problem).toBe("conflict");
    expect(mem.store.policy.roles.find(item => item.role === "implement")?.written).toBeNull();
    expect(mem.store.policy.roles.find(item => item.role === "review")?.written).toBeNull();
    expect(routing.drift()).toEqual([]);
  });

  it("reports a rollback that lost the compare-and-set", async () => {
    const mem = memory();
    mem.catalog.rows = [preset()];
    mem.vault.put("ref-a", "0123456789ab");
    const connections = new ConnectionsService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    const setup = new RoutingService(mem.deps);
    expect(setup.setOverride("implement", "follow", null, "c1").ok).toBe(true);
    expect(setup.setOverride("review", "follow", null, "c1").ok).toBe(true);
    expect(setup.setPriority("custom", ["key-a"], "c1").ok).toBe(true);
    expect(setup.setPicks("implement", ["key-a:m@high"], null, "c1").ok).toBe(true);
    expect(setup.setPicks("review", ["key-a:m@high"], null, "c1").ok).toBe(true);
    let left = 1;
    const inner = mem.store;
    const store = {
      load: () => inner.load(),
      save: (directory: typeof inner.directory, policy: typeof inner.policy, version: number) => {
        if (left === 0) return false;
        left -= 1;
        return inner.save(directory, policy, version);
      },
    };
    mem.engines.failOn = 2;
    const saved = new RoutingService({ ...mem.deps, store }).save();
    expect(saved.ok ? "" : saved.error.problem).toBe("rollback");
  });

  it("persists nothing when a command is refused", async () => {
    const mem = memory();
    mem.catalog.rows = [preset()];
    mem.vault.put("ref-a", "0123456789ab");
    const connections = new ConnectionsService(mem.deps);
    const routing = new RoutingService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    const saves = mem.store.saves;
    const refused = routing.setOverride("ghost", "follow", null, "");
    expect(refused.ok ? "" : refused.error.problem).toBe("principal");
    expect(mem.store.saves).toBe(saves);
    expect(mem.store.policy.roles.some(item => item.role === "ghost")).toBe(false);
    expect(routing.setPicks("implement", ["key-a:m@high"], null, "c1").ok).toBe(true);
    expect(mem.store.saves).toBe(saves + 1);
    expect(mem.store.policy.roles.find(item => item.role === "implement")?.picks).toHaveLength(1);
  });

  it("writes a cleared risk chain", async () => {
    const mem = memory();
    mem.catalog.rows = [preset()];
    mem.vault.put("ref-a", "0123456789ab");
    const connections = new ConnectionsService(mem.deps);
    const routing = new RoutingService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(routing.setOverride("implement", "follow", null, "c1").ok).toBe(true);
    expect(routing.setPriority("custom", ["key-a"], "c1").ok).toBe(true);
    expect(routing.setPicks("implement", ["key-a:m@high"], ["key-a:m@high"], "c1").ok).toBe(true);
    expect(routing.save().ok).toBe(true);
    expect(routing.setPicks("implement", ["key-a:m@high"], null, "c2").ok).toBe(true);
    expect(routing.save().ok).toBe(true);
    expect(mem.store.policy.roles.find(item => item.role === "implement")?.writtenRisk).toBeNull();
    expect(mem.engines.chains().find(chain => chain.role === "implement")?.risk).toBeNull();
  });

  it("writes a chain back when the outside settings no longer have it", async () => {
    const mem = memory();
    mem.catalog.rows = [preset()];
    mem.vault.put("ref-a", "0123456789ab");
    const connections = new ConnectionsService(mem.deps);
    const routing = new RoutingService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(routing.setOverride("implement", "follow", null, "c1").ok).toBe(true);
    expect(routing.setPriority("custom", ["key-a"], "c1").ok).toBe(true);
    expect(routing.setPicks("implement", ["key-a:m@high"], null, "c1").ok).toBe(true);
    expect(routing.save().ok).toBe(true);
    mem.engines.forget("implement");
    expect(routing.save().ok).toBe(true);
    expect(mem.engines.chains().find(chain => chain.role === "implement")?.chain).toEqual(["key-a:m@high"]);
  });
});
