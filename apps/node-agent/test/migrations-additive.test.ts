// Every agent migration is declared additive, so the linter (§11.2) must find nothing: an older agent can read what
// each one leaves. A breaking migration would have to say so and raise the floor.
import { describe, expect, it } from "vitest";
import { lintMigrations } from "@morndo/service-kit";
import { MIGRATIONS } from "../src/db/migrations.ts";

describe("the agent's migrations", () => {
  it("hold to the additive list: an older agent can read what each one leaves", () => {
    expect(MIGRATIONS.every(m => m.compat === "additive")).toBe(true);
    expect(lintMigrations(MIGRATIONS)).toEqual([]);
  });
});
