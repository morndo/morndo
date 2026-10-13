// Fleet migrations hold to the additive list (§11.2) except the ones that say they are breaking — migration 7, which
// rebuilt the jobs tables and set the floor. The linter skips those; everything else an older service must still read.
import { describe, expect, it } from "vitest";
import { lintMigrations } from "@morndo/service-kit";
import { MIGRATIONS } from "../src/adapters/migrations.ts";

describe("fleet.db's migrations", () => {
  it("are additive as declared: only migration 7 breaks, and it raised the floor", () => {
    expect(MIGRATIONS.filter(m => m.compat === "breaking").map(m => m.version)).toEqual([7]);
    expect(lintMigrations(MIGRATIONS)).toEqual([]);
  });
});
