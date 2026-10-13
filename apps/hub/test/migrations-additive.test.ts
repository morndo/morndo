// Every hub migration is declared additive, so the linter (§11.2) must find nothing: nothing a v16 hub could not read
// hides in the list a v17 hub runs. A breaking migration would have to say so and raise the floor.
import { describe, expect, it } from "vitest";
import { lintMigrations } from "@morndo/service-kit";
import { MIGRATIONS } from "../src/adapters/migrations.ts";

describe("the hub's migrations", () => {
  it("hold to the additive list: an older hub can read what each one leaves", () => {
    expect(MIGRATIONS.every(m => m.compat === "additive")).toBe(true);
    expect(lintMigrations(MIGRATIONS)).toEqual([]);
  });
});
