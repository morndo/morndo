// Wire allowlist and the shipped vendor catalog (ADR-0018 §4). Schemas are strict: an added field fails.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONNECTION_WORDS, ConnectionRow, ConnectionsPage, ConnectionView, LeaseView, NarrowCommand, PolicyView, PriorityCommand,
  RevokeCommand, RoleCommand, VendorCatalog, VendorPreset, commandNeedsStepUp,
} from "../src/index.ts";

const BANNED = /secret|value|plaintext|apiKey|token/i;

function shapeKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape).sort();
}

const CONNECTION_KEYS = [
  "billing", "budget", "configDir", "custody", "expiry", "fingerprint", "isolation", "kind", "name", "ref", "repo", "runtime", "status", "termsRevision", "vendor",
];
const LEASE_KEYS = ["authority", "connection", "entry", "id", "isolation", "probe", "reservation", "role", "runtime", "start", "workspace"];
const POLICY_KEYS = ["mode", "order", "roles"];

describe("connection wire", () => {
  it("schema keys match the allowlist, and a banned name fails even if listed", () => {
    expect(shapeKeys(ConnectionView)).toEqual(CONNECTION_KEYS);
    expect(shapeKeys(LeaseView)).toEqual(LEASE_KEYS);
    expect(shapeKeys(PolicyView)).toEqual(POLICY_KEYS);
    for (const key of [...CONNECTION_KEYS, ...LEASE_KEYS, ...POLICY_KEYS]) expect(key).not.toMatch(BANNED);
    expect("secret").toMatch(BANNED);
  });

  it("an added field is refused", () => {
    const view = {
      name: "key-a", kind: "api-key", custody: "morndo", vendor: "vendor-a", runtime: "runtime-a", status: "on",
      termsRevision: "r1", repo: null, isolation: "rules", configDir: null, ref: "ref-a", fingerprint: "0123456789ab",
      billing: "metered", budget: { kind: "capped", amount: 1 }, expiry: null,
    };
    expect(ConnectionView.safeParse(view).success).toBe(true);
    expect(ConnectionView.safeParse({ ...view, secret: "x" }).success).toBe(false);
    const lease = {
      id: "l1", connection: "key-a", role: "implement", entry: "key-a:m", runtime: "runtime-a",
      workspace: "/work", isolation: "os" as const, start: 1, reservation: 0, probe: true, authority: "ended" as const,
    };
    expect(LeaseView.safeParse(lease).success).toBe(true);
    expect(LeaseView.safeParse({ ...lease, authority: "live" }).success).toBe(true);
    const { authority, ...without } = lease;
    expect(authority).toBe("ended");
    expect(LeaseView.safeParse(without).success).toBe(false);
    expect(LeaseView.safeParse({ ...lease, extra: true }).success).toBe(false);
  });

  it("the words table is the page title and the five modes", () => {
    expect(CONNECTION_WORDS.title).toBe("LLM connections");
    expect(Object.keys(CONNECTION_WORDS.modes)).toEqual(["subscriptions-first", "keys-first", "subscriptions-only", "keys-only", "custom"]);
    expect(Object.keys(CONNECTION_WORDS.sections)).toEqual(["connections", "priority", "roles"]);
    expect(CONNECTION_WORDS.modes["keys-only"]).toBe("API keys only");
  });
});

const PAGE_KEYS = ["alerts", "catalog", "connections", "mode", "order", "roles", "version"];
const ROW_KEYS = ["availability", "budgetLevel", "budgetPercent", "expiry", "kind", "name", "runtime", "spendSource", "usageFiveHour", "usageSevenDay", "vendor"];
const COMMANDS = [PriorityCommand, RoleCommand, RevokeCommand, NarrowCommand, ConnectionsPage, ConnectionRow];

describe("the settings page allowlist", () => {
  const page = {
    version: 1, connections: [], mode: "keys-only" as const, order: [], roles: [], alerts: [], catalog: [],
  };
  const priority = { version: 1, mode: "keys-only" as const, order: ["key-a"] };
  const role = { version: 1, role: "implement", override: "own" as const, order: ["key-a"], picks: ["key-a:m"], action: "save" as const };
  const revoke = { version: 1, name: "key-a" };
  const narrow = { version: 1, name: "key-a", action: "off" as const };

  it("page and command keys are the allowlist, with no secret field", () => {
    expect(shapeKeys(ConnectionsPage)).toEqual(PAGE_KEYS);
    expect(shapeKeys(ConnectionRow)).toEqual(ROW_KEYS);
    for (const key of [...PAGE_KEYS, ...ROW_KEYS, ...shapeKeys(PriorityCommand), ...shapeKeys(RoleCommand), ...shapeKeys(RevokeCommand), ...shapeKeys(NarrowCommand)]) {
      expect(key).not.toMatch(BANNED);
    }
    expect(ROW_KEYS).not.toContain("ref");
    expect(ROW_KEYS).not.toContain("fingerprint");
  });

  it("a planted extra field fails on every page message", () => {
    expect(ConnectionsPage.safeParse(page).success).toBe(true);
    expect(PriorityCommand.safeParse(priority).success).toBe(true);
    expect(RoleCommand.safeParse(role).success).toBe(true);
    expect(RevokeCommand.safeParse(revoke).success).toBe(true);
    expect(NarrowCommand.safeParse(narrow).success).toBe(true);
    for (const [schema, body] of [[ConnectionsPage, page], [PriorityCommand, priority], [RoleCommand, role], [RevokeCommand, revoke], [NarrowCommand, narrow]] as const) {
      expect(schema.safeParse({ ...body, extra: true }).success).toBe(false);
      expect(schema.safeParse({ ...body, secret: "x" }).success).toBe(false);
    }
    expect(COMMANDS).toHaveLength(6);
    expect(commandNeedsStepUp("priority")).toBe(true);
    expect(commandNeedsStepUp("role")).toBe(true);
    expect(commandNeedsStepUp("revoke")).toBe(true);
    expect(commandNeedsStepUp("narrow")).toBe(false);
  });
});

describe("vendor catalog", () => {
  const raw = JSON.parse(readFileSync(join(import.meta.dirname, "../catalog/vendors.json"), "utf8")) as unknown[];

  it("the shipped catalog validates, and an added field fails", () => {
    const parsed = VendorCatalog.safeParse(raw);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error)).toBe(true);
    const first = raw[0];
    if (typeof first !== "object" || first === null) throw new Error("empty catalog");
    expect(VendorPreset.safeParse({ ...first, secret: "x" }).success).toBe(false);
  });

  it("every preset has terms, and engine-layer custody is the only one without an isolation floor", () => {
    const catalog = VendorCatalog.parse(raw);
    expect(catalog.map(p => p.id)).toEqual([
      "anthropic", "openai", "deepseek", "moonshot", "openrouter", "custom-anthropic", "custom-openai",
      "claude", "codex", "cursor", "studio", "cursor-cloud", "agy",
    ]);
    // https://platform.kimi.ai/docs/guide/claude-code-kimi (read 2026-10-10): the messages base URL is
    // https://api.moonshot.ai/anthropic. The balance response field is not on that page, so it is not a spend source.
    const moonshot = catalog.find(p => p.id === "moonshot");
    expect(moonshot?.runtimes[0]?.baseUrl).toBe("https://api.moonshot.ai/anthropic");
    expect(moonshot?.spend).toEqual(["token-price"]);
    expect(moonshot?.balance).toBeNull();
    // https://antigravity.google/terms/ (read 2026-10-10).
    // https://cursor.com/terms-of-service and https://cursor.com/data-use (last updated 2026-09-03, read 2026-10-10).
    const agy = catalog.find(p => p.id === "agy");
    expect(agy?.terms.sources).toEqual(["https://antigravity.google/terms/"]);
    const cursor = catalog.find(p => p.id === "cursor");
    const cloud = catalog.find(p => p.id === "cursor-cloud");
    expect(cursor?.terms.sources).toEqual(["https://cursor.com/terms-of-service", "https://cursor.com/data-use"]);
    expect(cloud?.terms.sources).toEqual(cursor?.terms.sources);
    expect(catalog.find(p => p.id === "studio")?.terms).toMatchObject({ revision: "unknown", sources: [] });
    for (const preset of catalog) {
      expect(preset.terms.revision.length, preset.id).toBeGreaterThan(0);
      expect(preset.terms.summary.length, preset.id).toBeGreaterThan(0);
      if (preset.terms.revision === "unknown") expect(preset.terms.sources, preset.id).toEqual([]);
      else expect(preset.terms.sources[0], preset.id).toMatch(/^https:\/\//);
      expect(preset.isolation === null, preset.id).toBe(preset.custody === "engine-layer");
    }
  });
});
