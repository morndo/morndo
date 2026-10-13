// The connections store is additive forever (§11): it has no service that could be stopped for an update — its helper
// runs whenever an agent CLI needs a key — so no breaking migration may ever appear, and the linter must find nothing.
import { describe, expect, it } from "vitest";
import { lintMigrations } from "@morndo/service-kit";
import { MIGRATIONS } from "../src/adapters/store-migrations.ts";

describe("the connections store's migrations", () => {
  it("are additive, and stay additive: no breaking one may appear", () => {
    expect(MIGRATIONS.every(m => m.compat === "additive")).toBe(true);
    expect(lintMigrations(MIGRATIONS)).toEqual([]);
  });
});
