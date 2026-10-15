// The guide's posting recipe (review of the Codex runtime, points 5 and 6): it must post often enough that a session counts as
// reporting (U3), and it must never send an empty body when a read fails. Read from the guide as written.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SESSION_FRESH_MS } from "@morndo/domain";

const guide = readFileSync(join(import.meta.dirname, "../../../docs/agents/codex.md"), "utf8");

describe("the Codex guide's posting recipe", () => {
  it("names an interval shorter than the time a session counts as reporting", () => {
    const minutes = Number(/every (\d+) minutes/.exec(guide)?.[1]);
    expect(Number.isFinite(minutes)).toBe(true);
    expect(minutes * 60_000).toBeLessThan(SESSION_FRESH_MS);
  });

  it("posts only what a successful read printed, never a bare pipe into the post", () => {
    expect(guide).not.toMatch(/morndo-keys usage[^\n]*\|\s*curl/);
    const recipe = /```sh\n([^`]*morndo-keys usage[^`]*)```/.exec(guide)?.[1] ?? "";
    expect(recipe).toMatch(/report=\$\(morndo-keys usage[^\n]*\) \|\| exit/);
    expect(recipe).toMatch(/curl -f/);
  });
});
