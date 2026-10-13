// The settings page is a view: budget in words and a percentage, keys-only drops subscriptions, and no key material.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acknowledge, addKey, addSubscription, emptyDirectory, emptyPolicy, ensureRole, parseEngine, setOverride, setPicks, setPriority,
  type Actor,
} from "@morndo/domain";
import type { VendorPreset } from "@morndo/protocol";
import { CONNECTION_WORDS } from "@morndo/protocol";
import { buildPage } from "../src/application/page.ts";

const who: Actor = { kind: "principal", command: "c1" };
const SECRET = "sk-test-synthetic-0001";
function must<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error("refused");
  return result.value;
}

function preset(): VendorPreset {
  return {
    id: "vendor-a", label: "Vendor A", custody: "morndo", kinds: ["api-key", "subscription"],
    runtimes: [{ runtime: "runtime-a", dialect: "dialect-a", baseUrl: null }],
    models: { source: "static", ids: ["m"] }, family: "family-a", keyShapes: ["sk-"], spend: ["manual"], prices: [],
    balance: null, defaultPicks: {}, isolation: "rules",
    terms: { revision: "r1", summary: "Read before use.", sources: ["https://example.com/terms"] },
  };
}

describe("the connections page view", () => {
  it("lists Z.ai from the shipped catalog", () => {
    const presets = JSON.parse(readFileSync(join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json"), "utf8")) as VendorPreset[];
    const page = buildPage({
      version: 1, directory: emptyDirectory(), policy: emptyPolicy(), presets, alerts: [], outside: [], usage: {}, now: 1,
    });
    expect(page.catalog.find(item => item.id === "zai")).toEqual({
      id: "zai", label: "Z.ai", kinds: ["api-key"], runtimes: ["claude"],
      termsSummary: "API input is processed in real time and not saved on Z.ai's servers.",
      termsSources: ["https://docs.z.ai/legal-agreement/privacy-policy"],
      isolation: "os",
    });
  });

  it("shows one subscription and one key, a keys-only chain, and an alert, with no secret", () => {
    let directory = must(addSubscription(emptyDirectory(), { name: "sub-a", vendor: "vendor-a", runtime: "runtime-a", isolation: "none", floor: "none", configDir: null }, who, 1));
    directory = must(acknowledge(directory, "sub-a", "r1", "owner", who, 2));
    directory = must(addKey(directory, {
      name: "key-a", vendor: "vendor-a", runtime: "runtime-a", isolation: "rules", floor: "none",
      ref: "ref-key-a", fingerprint: "0123456789ab", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null,
    }, who, 3));
    directory = must(acknowledge(directory, "key-a", "r1", "owner", who, 4));
    const key = directory.connections.find(c => c.name === "key-a");
    if (!key || key.kind !== "api-key" || key.custody !== "morndo") throw new Error("key missing");
    directory = { ...directory, connections: directory.connections.map(c => c.name === "key-a" && c.kind === "api-key" && c.custody === "morndo" ? { ...c, spend: [{ at: 5, amount: 5, source: "manual" as const }] } : c) };
    const listed = [
      { name: "sub-a", kind: "subscription" as const, models: ["m"], efforts: null },
      { name: "key-a", kind: "api-key" as const, models: ["m"], efforts: null },
    ];
    let policy = must(setPriority(emptyPolicy(), { mode: "keys-only", order: ["sub-a", "key-a"] }, listed, "c1", 6));
    policy = must(setOverride(ensureRole(policy, "implement"), "implement", "follow", null, listed, "c1", 7));
    const keyPick = parseEngine("key-a:m");
    const subPick = parseEngine("sub-a:m");
    if (!keyPick || !subPick) throw new Error("pick");
    policy = must(setPicks(policy, "implement", [keyPick, subPick], null, listed, "c1", 8));
    const page = buildPage({
      version: 3, directory, policy, presets: [preset()], outside: [], now: 9,
      usage: { "sub-a": { fiveHour: 12, sevenDay: 40 } },
      alerts: [{ kind: "drift", name: "implement", detail: SECRET }],
    });
    expect(page.mode).toBe("keys-only");
    expect(page.order).toEqual(["sub-a", "key-a"]);
    expect(page.connections.map(c => c.name)).toEqual(["sub-a", "key-a"]);
    const row = page.connections[1];
    expect(row?.budgetPercent).toBe(50);
    expect(row?.budgetLevel).toBe("half");
    expect(page.connections[0]?.usageFiveHour).toBe(12);
    expect(page.connections[1]?.usageFiveHour).toBeNull();
    expect(page.roles[0]?.riskPicks).toEqual([]);
    expect(page.roles[0]?.chain).toEqual(["key-a:m"]);
    expect(page.roles[0]?.first).toBe("key-a:m");
    expect(page.roles[0]?.chain.join(" ")).not.toContain("sub-a");
    expect(page.roles[0]?.first).not.toContain("sub-a");
    expect(page.alerts[0]).toEqual({ kind: "connection", name: "implement", detail: CONNECTION_WORDS.drift });
    const text = JSON.stringify(page);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("ref-key-a");
    expect(text).not.toContain("0123456789ab");
    expect(text).not.toContain("sk-");
  });

  it("subscriptions-only keeps the subscription in the chain and the preview, and drops the key", () => {
    let directory = must(addSubscription(emptyDirectory(), { name: "sub-a", vendor: "vendor-a", runtime: "runtime-a", isolation: "none", floor: "none", configDir: null }, who, 1));
    directory = must(addKey(directory, {
      name: "key-a", vendor: "vendor-a", runtime: "runtime-a", isolation: "rules", floor: "none",
      ref: "ref-key-a", fingerprint: "0123456789ab", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null,
    }, who, 2));
    const listed = [
      { name: "sub-a", kind: "subscription" as const, models: ["m"], efforts: null },
      { name: "key-a", kind: "api-key" as const, models: ["m"], efforts: null },
    ];
    let policy = must(setPriority(emptyPolicy(), { mode: "subscriptions-only", order: ["sub-a", "key-a"] }, listed, "c1", 3));
    policy = must(setOverride(ensureRole(policy, "implement"), "implement", "follow", null, listed, "c1", 4));
    const keyPick = parseEngine("key-a:m");
    const subPick = parseEngine("sub-a:m");
    if (!keyPick || !subPick) throw new Error("pick");
    policy = must(setPicks(policy, "implement", [keyPick, subPick], null, listed, "c1", 5));
    const page = buildPage({ version: 1, directory, policy, presets: [preset()], outside: [], usage: {}, alerts: [], now: 6 });
    expect(page.order).toEqual(["sub-a", "key-a"]);
    expect(page.roles[0]?.chain).toEqual(["sub-a:m"]);
    expect(page.roles[0]?.first).toBe("sub-a:m");
    expect(page.roles[0]?.chain.join(" ")).not.toContain("key-a");
    expect(page.roles[0]?.first).not.toContain("key-a");
  });

  it("an own role carries its own order, and the global list stays complete", () => {
    let directory = must(addSubscription(emptyDirectory(), { name: "sub-a", vendor: "vendor-a", runtime: "runtime-a", isolation: "none", floor: "none", configDir: null }, who, 1));
    directory = must(addKey(directory, {
      name: "key-a", vendor: "vendor-a", runtime: "runtime-a", isolation: "rules", floor: "none",
      ref: "ref-key-a", fingerprint: "0123456789ab", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null,
    }, who, 2));
    const listed = [
      { name: "sub-a", kind: "subscription" as const, models: ["m"], efforts: null },
      { name: "key-a", kind: "api-key" as const, models: ["m"], efforts: null },
    ];
    let policy = must(setPriority(emptyPolicy(), { mode: "custom", order: ["sub-a", "key-a"] }, listed, "c1", 3));
    policy = must(setOverride(ensureRole(policy, "implement"), "implement", "own", { mode: "custom", order: ["key-a"] }, listed, "c1", 4));
    const keyPick = parseEngine("key-a:m");
    if (!keyPick) throw new Error("pick");
    policy = must(setPicks(policy, "implement", [keyPick], [keyPick], listed, "c1", 5));
    const page = buildPage({ version: 1, directory, policy, presets: [preset()], outside: [], usage: {}, alerts: [], now: 6 });
    expect(page.order).toEqual(["sub-a", "key-a"]);
    expect(page.roles[0]?.order).toEqual(["key-a"]);
    expect(page.roles[0]?.riskPicks).toEqual(["key-a:m"]);
  });
});
