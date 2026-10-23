// The pool's usage file as the hub reads it (ADR-0034): each line one account, only the label fields read, a bad line
// or a badly named one skipped, and the file re-read only when it changed. Synthetic accounts only.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePoolAccounts, poolProfiles } from "../src/adapters/pool-accounts.ts";

let dir = "";
const file = () => join(dir, "usage.jsonl");
const write = (lines: unknown[]) => writeFileSync(file(), `${lines.map(l => JSON.stringify(l)).join("\n")}\n`);
const team5 = { email: "ada@example.test", org: "claude_team", tier: "default_claude_max_5x", plan: "seats", orgId: "org-0001", loggedIn: true, retired: false };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-pool-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("the pool's lines", () => {
  it("maps the org and tier words: Team, personal, Max 5x, Max 20x, or the plan as written", () => {
    const m = parsePoolAccounts([
      { name: "a1", ...team5 },
      { name: "a2", email: "lin@example.test", org: "self", tier: "default_claude_max_20x" },
      { name: "a3", email: "sam@example.test", org: "self", tier: "team_trial", plan: "pro" },
      { name: "a4", org: "claude_team", tier: "default_claude_max_5x" },
    ].map(l => JSON.stringify(l)).join("\n"));
    expect(m.get("a1")).toEqual({ email: "ada@example.test", org: "team", plan: "Max 5x" });
    expect(m.get("a2")).toEqual({ email: "lin@example.test", org: "personal", plan: "Max 20x" });
    expect(m.get("a3")).toEqual({ email: "sam@example.test", org: "personal", plan: "pro" });
    expect(m.get("a4")).toEqual({ email: null, org: "team", plan: "Max 5x" });   // no email: the rest still shown
    expect(JSON.stringify(m)).not.toContain("org-0001");                        // never read, never forwarded
  });

  it("skips a line with nothing to show, a bad line, a bad or missing name; a later line for a name wins", () => {
    const m = parsePoolAccounts([
      { name: "a5", email: "", org: "", tier: "", plan: " " },
      "{not json",
      { name: "bad name", email: "x@example.test" },
      { email: "noname@example.test" },
      { name: "a6", email: "old@example.test", org: "claude_team", tier: "default_claude_max_5x" },
      { name: "a6", email: "new@example.test", org: "claude_team", tier: "default_claude_max_5x" },
    ].map(l => JSON.stringify(l)).join("\n"));
    expect(m.has("a5")).toBe(false);
    expect(m.size).toBe(1);
    expect(m.get("a6")?.email).toBe("new@example.test");
  });
});

describe("the getter", () => {
  it("no path, and a file that isn't there, are an empty map", () => {
    expect(poolProfiles(null)().size).toBe(0);
    expect(poolProfiles(join(dir, "nope.jsonl"))().size).toBe(0);
  });

  it("a changed file is re-read; an unchanged one is served from the cache", () => {
    write([{ name: "a1", ...team5 }]);
    const profiles = poolProfiles(file());
    expect(profiles().get("a1")?.plan).toBe("Max 5x");
    const cached = profiles();
    expect(profiles()).toBe(cached);              // unchanged: the same map, not a re-read
    write([{ name: "a1", ...team5, tier: "default_claude_max_20x", note: "long enough to change the file's size" }]);
    expect(profiles().get("a1")?.plan).toBe("Max 20x");
  });
});
