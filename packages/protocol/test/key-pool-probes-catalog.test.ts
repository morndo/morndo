// The probe model of a key pool is data (ADR-0037, slice 3): its own catalog file beside vendors.json and key-pools.json, so a build from before
// slice 3, whose strict schemas refuse a field they do not know, never reads it and keeps its pools (ADR-0037 decision 10b).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KeyPoolCatalog, KeyPoolProbeCatalog, VendorCatalog } from "../src/index.ts";

const dir = join(import.meta.dirname, "../catalog");
const read = (file: string): unknown => JSON.parse(readFileSync(join(dir, file), "utf8"));

describe("the key pool probe catalog", () => {
  it("the shipped file parses, and the first-party entry names the Haiku-class model", () => {
    const rows = KeyPoolProbeCatalog.parse(read("key-pool-probes.json"));
    expect(rows.find(row => row.vendor === "anthropic")).toEqual({ vendor: "anthropic", model: "claude-haiku-5-5" });
  });
  it("is strict: an unknown field, an empty model, a duplicate vendor, or a model with a space is refused", () => {
    const row = { vendor: "anthropic", model: "claude-haiku-5-5" };
    expect(KeyPoolProbeCatalog.safeParse([{ ...row, extra: 1 }]).success).toBe(false);
    expect(KeyPoolProbeCatalog.safeParse([{ ...row, model: "" }]).success).toBe(false);
    expect(KeyPoolProbeCatalog.safeParse([{ ...row, model: "a b" }]).success).toBe(false);
    expect(KeyPoolProbeCatalog.safeParse([row, row]).success).toBe(false);
    expect(KeyPoolProbeCatalog.safeParse([row]).success).toBe(true);
  });
  it("the two older files keep exactly the fields an older build's strict schema knows", () => {
    for (const row of read("key-pools.json") as Record<string, unknown>[]) {
      expect(Object.keys(row).sort()).toEqual(["errorDialect", "termsLine", "termsRevision", "vendor"]);
    }
    expect(KeyPoolCatalog.safeParse(read("key-pools.json")).success).toBe(true);
    expect(VendorCatalog.safeParse(read("vendors.json")).success).toBe(true);
  });
});
