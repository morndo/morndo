// Contract test for the session registry on synthetic fixtures shaped like Claude Code 2.1.286's files (moved from the
// hub's claude-sessions.test.ts with the registry, fleet core Task 2).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionRegistry } from "../src/sessions.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-claude-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("session registry", () => {
  it("maps live sessions to their tmux pane and finds their transcript", () => {
    mkdirSync(join(dir, "sessions"));
    mkdirSync(join(dir, "projects", "-tmp-demo"), { recursive: true });
    writeFileSync(join(dir, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s-live", tmux: "qa:@0.%3", name: "builder-1a", cwd: "/tmp/demo", version: "2.1.286", updatedAt: 1 }));
    writeFileSync(join(dir, "sessions", "2.json"), JSON.stringify({ pid: 999_999_999, sessionId: "s-dead", tmux: "qa:@1.%4" }));
    writeFileSync(join(dir, "projects", "-tmp-demo", "s-live.jsonl"), "");
    const reg = sessionRegistry(dir);
    const panes = reg.byPane();
    expect([...panes.keys()]).toEqual(["%3"]);                       // the dead process's entry is ignored
    expect(panes.get("%3")?.name).toBe("builder-1a");
    expect(reg.transcriptPath("s-live")).toBe(join(dir, "projects", "-tmp-demo", "s-live.jsonl"));
    expect(reg.transcriptPath("nope")).toBeNull();
  });
  it("keeps a normal version and drops one that would not fit the fleet's hello", () => {
    mkdirSync(join(dir, "sessions"));
    for (const [pid, version, kept] of [[process.pid, "2.1.286", "2.1.286"], [process.pid, "1".repeat(65), null], [process.pid, "has space", null], [process.pid, 7, null]] as const) {
      writeFileSync(join(dir, "sessions", "1.json"), JSON.stringify({ pid, sessionId: "s-live", tmux: "qa:@0.%3", name: null, cwd: "/tmp/demo", version, updatedAt: 1 }));
      expect(sessionRegistry(dir).byPane().get("%3")?.version, String(version)).toBe(kept);
    }
  });
});
