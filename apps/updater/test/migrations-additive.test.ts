// Every update.db migration is declared additive, so the linter (§11.2) must find nothing: an older updater
// can always open what a newer one wrote, which is what makes the rollback's recovery possible at all. A
// breaking migration would have to say so and raise the floor.
import { describe, expect, it } from "vitest";
import { lintMigrations } from "@morndo/service-kit";
import { MIGRATIONS } from "../src/adapters/store-sqlite.ts";

describe("the updater's migrations", () => {
  it("hold to the additive list: an older updater can read what each one leaves", () => {
    expect(MIGRATIONS.every(m => m.compat === "additive")).toBe(true);
    expect(lintMigrations(MIGRATIONS)).toEqual([]);
  });
});
