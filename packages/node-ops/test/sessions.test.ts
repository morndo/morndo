// Contract test for the session registry on synthetic fixtures shaped like Claude Code 2.1.286's files (moved from the
// hub's claude-sessions.test.ts with the registry, fleet core Task 2).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // fleet clients §5: each pane's session status and pid, from a session file in 2.1.293's recorded shape
  // (test/fixtures/claude-code/2.1.293/session-file.json, synthetic values), its pid made this process so it is live.
  it("reads the session's status and its process from a recorded session file", () => {
    mkdirSync(join(dir, "sessions"));
    const recorded = JSON.parse(readFileSync(join(import.meta.dirname, "../../../test/fixtures/claude-code/2.1.293/session-file.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "sessions", `${process.pid}.json`), JSON.stringify({ ...recorded, pid: process.pid }));
    expect(sessionRegistry(dir).byPane().get("%7")).toEqual({
      sessionId: "5e1f0c2a-7b3d-4e8f-9a6b-0c1d2e3f4a5b", name: "fixture-lane", pane: "%7", cwd: "/work/demo", version: "2.1.293", pid: process.pid, status: "idle",
    });
  });
  it("keeps each status Claude Code writes; one it doesn't know, or none, is null (negative control)", () => {
    mkdirSync(join(dir, "sessions"));
    for (const [status, kept] of [["busy", "busy"], ["idle", "idle"], ["waiting", "waiting"], ["shell", "shell"], ["compacting", null], ["Idle", null], [7, null], [undefined, null]] as const) {
      writeFileSync(join(dir, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s-live", tmux: "qa:@0.%3", cwd: "/tmp/demo", version: "2.1.293", status, updatedAt: 1 }));
      expect(sessionRegistry(dir).byPane().get("%3")?.status, String(status)).toBe(kept);
    }
  });
  // B6 (T-306): a headless run started inside a lane writes its own session file naming the lane's pane. Whichever file
  // readdirSync lists last must not decide who owns the pane, or the lane's own Stop is judged foreign and dropped.
  describe("two live sessions in one pane (B6)", () => {
    const lane = { pid: process.pid, sessionId: "sess-lane", tmux: "qa:@0.%3", entrypoint: "cli", startedAt: 1_000, updatedAt: 5 };
    const headless = { pid: process.pid, sessionId: "sess-headless", tmux: "qa:@0.%3", entrypoint: "sdk-cli", startedAt: 2_000, updatedAt: 9 };
    const bothOrders = (a: Record<string, unknown>, b: Record<string, unknown>, keep: () => void) => {
      for (const [first, second] of [[a, b], [b, a]] as const) {
        rmSync(join(dir, "sessions"), { recursive: true, force: true });
        mkdirSync(join(dir, "sessions"));
        writeFileSync(join(dir, "sessions", "1.json"), JSON.stringify(first));
        writeFileSync(join(dir, "sessions", "2.json"), JSON.stringify(second));
        keep();
      }
    };
    it("a pane holding the lane's own session and a headless run's keeps the lane's, in either file order", () => {
      bothOrders(lane, headless, () => expect(sessionRegistry(dir).byPane().get("%3")?.sessionId).toBe("sess-lane"));
    });
    it("with no entrypoint the earlier startedAt wins, either order; a headless run older than the lane's own still loses", () => {
      const early = { pid: process.pid, sessionId: "sess-early", tmux: "qa:@0.%3", startedAt: 1_000, updatedAt: 9 };   // the later updatedAt must not win
      const late = { pid: process.pid, sessionId: "sess-late", tmux: "qa:@0.%3", startedAt: 2_000, updatedAt: 1 };
      bothOrders(early, late, () => expect(sessionRegistry(dir).byPane().get("%3")?.sessionId).toBe("sess-early"));
      const noStart = { pid: process.pid, sessionId: "sess-nostart", tmux: "qa:@0.%3", updatedAt: 1 };
      bothOrders(noStart, early, () => expect(sessionRegistry(dir).byPane().get("%3")?.sessionId).toBe("sess-early"));   // no startedAt counts as later
      bothOrders({ ...headless, startedAt: 500 }, lane, () => expect(sessionRegistry(dir).byPane().get("%3")?.sessionId).toBe("sess-lane"));   // rank before age
    });
  });
});
