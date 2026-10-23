// The pool's usage file as the hub reads it (ADR-0034): each line one account, only the label fields read, a bad line
// or a badly named one skipped, and the file re-read only when it changed. A file that is not a regular one, or is over the cap, is not read. Synthetic accounts only.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POOL_FILE_MAX_BYTES, parsePoolAccounts, poolProfiles } from "../src/adapters/pool-accounts.ts";

let dir = "";
const file = () => join(dir, "usage.jsonl");
const write = (lines: unknown[]) => writeFileSync(file(), `${lines.map(l => JSON.stringify(l)).join("\n")}\n`);
const team5 = { email: "ada@example.test", org: "claude_team", tier: "default_claude_max_5x", plan: "seats", orgId: "org-0001", loggedIn: true, retired: false };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-pool-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("the pool's lines", () => {
  it("maps the org and tier words: Team, personal, Max 5x, Max 20x; any other tier is no paid plan", () => {
    const m = parsePoolAccounts([
      { name: "a1", ...team5 },
      { name: "a2", email: "lin@example.test", org: "self", tier: "default_claude_max_20x" },
      { name: "a3", email: "sam@example.test", org: "self", tier: "team_trial", plan: "pro" },
      { name: "a7", email: "kim@example.test", org: "self", tier: "default_claude_ai", plan: "max" },   // an ended subscription still says "max"
      { name: "a8", email: "eli@example.test", org: "self", tier: "", plan: "max" },
      { name: "a9", email: "joe@example.test", org: "self", tier: "default_claude_max_10x", plan: "max" },   // a Max tier the table doesn't know
      { name: "a4", org: "claude_team", tier: "default_claude_max_5x" },
    ].map(l => JSON.stringify(l)).join("\n"));
    expect(m.get("a1")).toEqual({ email: "ada@example.test", org: "team", plan: "Max 5x" });
    expect(m.get("a2")).toEqual({ email: "lin@example.test", org: "personal", plan: "Max 20x" });
    expect(m.get("a3")).toEqual({ email: "sam@example.test", org: "personal", plan: "no paid plan" });
    expect(m.get("a7")).toEqual({ email: "kim@example.test", org: "personal", plan: "no paid plan" });
    expect(m.get("a8")?.plan).toBe("no paid plan");
    expect(m.get("a9")?.plan).toBe("max");                                      // paid, only unnamed: shown as the file writes it
    expect(m.get("a4")).toEqual({ email: null, org: "team", plan: "Max 5x" });   // no email: the rest still shown
    expect(JSON.stringify(m)).not.toContain("org-0001");                        // never read, never forwarded
  });

  it("skips a line with nothing to show, a bad line, a bad or missing name; a later line for a name wins", () => {
    const m = parsePoolAccounts([
      { name: "a5", email: "", org: "", plan: " " },                     // no tier at all: nothing to say, no label
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

const warned = () => { const lines: string[] = []; return { lines, log: { warn: (m: string) => { lines.push(m); } } }; };

describe("the reader", () => {
  it("no path, and a file that isn't there, are an empty map", async () => {
    const none = poolProfiles(null);
    await none.refresh();
    expect(none.current().size).toBe(0);
    const absent = poolProfiles(join(dir, "nope.jsonl"));
    await absent.refresh();
    expect(absent.current().size).toBe(0);
  });

  it("before the first read there is nothing; a changed file is re-read; an unchanged one is served from the cache", async () => {
    write([{ name: "a1", ...team5 }]);
    const pool = poolProfiles(file());
    expect(pool.current().size).toBe(0);
    expect(await pool.refresh()).toBe(true);
    expect(pool.current().get("a1")?.plan).toBe("Max 5x");
    const cached = pool.current();
    expect(await pool.refresh()).toBe(false);     // unchanged: nothing read, nothing changed
    expect(pool.current()).toBe(cached);
    write([{ name: "a1", ...team5, tier: "default_claude_max_20x", note: "long enough to change the file's size" }]);
    expect(await pool.refresh()).toBe(true);
    expect(pool.current().get("a1")?.plan).toBe("Max 20x");
  });

  it("a symbolic link to a regular file is read; a file that goes away empties the map", async () => {
    write([{ name: "a1", ...team5 }]);
    const link = join(dir, "link.jsonl");
    symlinkSync(file(), link);
    const pool = poolProfiles(link);
    await pool.refresh();
    expect(pool.current().get("a1")?.org).toBe("team");
    rmSync(file());
    await pool.refresh();
    expect(pool.current().size).toBe(0);
  });
});

describe("what is not read (negative controls)", () => {
  it("a named pipe is refused at once, without waiting for a writer, and the last good profiles stay", async () => {
    write([{ name: "a1", ...team5 }]);
    const w = warned();
    const pool = poolProfiles(file(), w.log);
    await pool.refresh();
    rmSync(file());
    execFileSync("mkfifo", [file()]);
    const t0 = Date.now();
    await pool.refresh();                         // a blocking open or read would hang here, the test would time out
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(pool.current().get("a1")?.plan).toBe("Max 5x");
    expect(w.lines).toHaveLength(1);
    expect(w.lines[0]).toContain(file());
    expect(w.lines[0]).toMatch(/not a regular file/);
  });

  it("a directory and a device are refused, said once each time they change nothing", async () => {
    const w = warned();
    mkdirSync(file());
    const pool = poolProfiles(file(), w.log);
    await pool.refresh();
    await pool.refresh();
    expect(pool.current().size).toBe(0);
    expect(w.lines).toHaveLength(1);              // the same failure twice is said once
    const zero = poolProfiles("/dev/zero", w.log);
    await zero.refresh();                         // /dev/zero read whole would never end
    expect(zero.current().size).toBe(0);
  });

  it("a file over the cap is not read: the path and the size are said, the last good profiles stay", async () => {
    write([{ name: "a1", ...team5 }]);
    const w = warned();
    const pool = poolProfiles(file(), w.log);
    await pool.refresh();
    writeFileSync(file(), `${JSON.stringify({ name: "a1", ...team5, pad: "x".repeat(POOL_FILE_MAX_BYTES) })}\n`);
    await pool.refresh();
    expect(pool.current().get("a1")?.plan).toBe("Max 5x");
    expect(w.lines).toHaveLength(1);
    expect(w.lines[0]).toContain(file());
    expect(w.lines[0]).toMatch(/too large \(\d+ bytes\)/);
    expect(w.lines[0]).not.toContain("example.test");   // nothing of the content in the log
  });

  it("a file caught mid-write: a damaged line keeps the account's last good profile; a complete line without data drops it", async () => {
    write([{ name: "a1", ...team5 }, { name: "a2", email: "lin@example.test", org: "self", tier: "default_claude_max_20x" }]);
    const pool = poolProfiles(file());
    await pool.refresh();
    const whole = JSON.stringify({ name: "a2", email: "lin@example.test", org: "self", tier: "default_claude_max_20x" });
    // a1's line is cut in the middle, a2's is whole
    writeFileSync(file(), `{"name":"a1","email":"ada@exam\n${whole}\n`);
    await pool.refresh();
    expect(pool.current().get("a1")).toEqual({ email: "ada@example.test", org: "team", plan: "Max 5x" });
    expect(pool.current().get("a2")?.plan).toBe("Max 20x");
    // the next full write has no data for a1: that is a real change, and the label goes
    write([{ name: "a1", email: "", org: "" }, { name: "a2", email: "lin@example.test", org: "self", tier: "default_claude_max_20x", extra: 1 }]);
    await pool.refresh();
    expect(pool.current().has("a1")).toBe(false);
    // an account that is no longer in the file at all goes too
    write([{ name: "a2", email: "lin@example.test", org: "self", tier: "default_claude_max_20x" }]);
    await pool.refresh();
    expect([...pool.current().keys()]).toEqual(["a2"]);
  });
});
