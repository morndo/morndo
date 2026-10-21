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
});

// B6: a session is headless only when its own live file says so (entrypoint "sdk…", a `claude -p` run; "cli" is a lane's —
// the field is internal, sessions.ts). Fail open: no file, no entrypoint, an interactive one, a dead process — none is
// headless, so a lane's own Stop is never dropped; and an interactive file naming the same id (a headless resume of the
// lane's own session) makes it the lane's, whatever another file says.
describe("headless()", () => {
  const write = (name: string, fields: Record<string, unknown>) => writeFileSync(join(dir, "sessions", name), JSON.stringify(fields));
  it("a session whose only live file has an sdk entrypoint is headless", () => {
    mkdirSync(join(dir, "sessions"));
    for (const entrypoint of ["sdk-cli", "sdk-ts"]) {
      write("1.json", { pid: process.pid, sessionId: "sess-h", tmux: "qa:@0.%3", entrypoint });
      expect(sessionRegistry(dir).headless("sess-h"), entrypoint).toBe(true);
    }
  });
  it("is not headless: an interactive file, no entrypoint, an unknown id, a dead process, no sessions directory", () => {
    mkdirSync(join(dir, "sessions"));
    write("1.json", { pid: process.pid, sessionId: "sess-lane", tmux: "qa:@0.%3", entrypoint: "cli" });
    expect(sessionRegistry(dir).headless("sess-lane")).toBe(false);
    write("1.json", { pid: process.pid, sessionId: "sess-lane", tmux: "qa:@0.%3" });
    expect(sessionRegistry(dir).headless("sess-lane")).toBe(false);
    expect(sessionRegistry(dir).headless("sess-nobody")).toBe(false);
    write("1.json", { pid: 999_999_999, sessionId: "sess-gone", tmux: "qa:@0.%3", entrypoint: "sdk-cli" });
    expect(sessionRegistry(dir).headless("sess-gone")).toBe(false);
    expect(sessionRegistry(join(dir, "absent")).headless("sess-lane")).toBe(false);
  });
  it("a session id an interactive file also names is the lane's (a headless resume of the lane's own session)", () => {
    mkdirSync(join(dir, "sessions"));
    const interactive = { pid: process.pid, sessionId: "sess-lane", tmux: "qa:@0.%3", entrypoint: "cli" };
    const headless = { pid: process.pid, sessionId: "sess-lane", tmux: "qa:@0.%3", entrypoint: "sdk-cli" };
    for (const [first, second] of [[interactive, headless], [headless, interactive]] as const) {
      write("1.json", first);
      write("2.json", second);
      expect(sessionRegistry(dir).headless("sess-lane")).toBe(false);
    }
  });
});
