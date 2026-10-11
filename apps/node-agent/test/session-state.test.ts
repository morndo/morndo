// The agent on Task 1's protocol (fleet clients spec §5): each pane's session `status` and `pid` in the inventory, from the
// session registry, its `topic` and `lastPrompt` from the transcript (RECONCILIATION.md ruling 13), and pane.keys by tmux
// key name from an allow-list. Real isolated tmux; the session file and the transcript are the test's (claude-session.ts),
// so the status is exactly what Claude Code would have written.
import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { claudeSession } from "./claude-session.ts";
import { isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

const SHELL = "bash --norc --noprofile";
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
beforeEach(() => { home = tempHome(); t = isolatedTmux(); h = opsHarness({ home: home.home, socket: t.socket }); });
afterEach(async () => { h.close(); await t.kill(); home.cleanup(); });

function lanes() {
  const shell = t.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "main", "-n", "shell", SHELL).trim();
  const claude = t.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "=main:", "-n", "lane", "sleep 600").trim();
  return { shell, session: claudeSession({ tmux: t, claudeDir: join(home.home, ".claude"), pane: claude }) };
}

describe("each pane's session state in the inventory (spec §5)", () => {
  it("reports the session file's own status and the session's pid, and null for both without a session", async () => {
    const { session } = lanes();
    for (const status of ["busy", "idle", "waiting", "shell"] as const) {
      session.status(status);
      const snap = await h.inventory.refresh();
      expect(snap.panes.find(p => p.window === "lane"), status).toMatchObject({ sessionId: session.sessionId, status, pid: session.pid });
      expect(snap.lanes.find(l => l.window === "lane"), status).toMatchObject({ status, pid: session.pid });
      expect(snap.panes.find(p => p.window === "shell")).toMatchObject({ status: null, pid: null });
    }
    session.status(null);                                            // a session file without a status (before 2.1.293)
    expect((await h.inventory.refresh()).panes.find(p => p.window === "lane")).toMatchObject({ sessionId: session.sessionId, status: null });
  });

  it("grows invVersion when only a status changes, so the fleet hears of it within one poll", async () => {
    const { session } = lanes();
    session.status("idle");
    const v = (await h.inventory.refresh()).invVersion;
    expect((await h.inventory.refresh()).invVersion).toBe(v);
    session.status("busy");
    expect((await h.inventory.refresh()).invVersion).toBe(v + 1);
  });

  it("reports the session's topic and last prompt, its transcript's latest ai-title and last-prompt entries, each absent when unknown (rulings 13, 46)", async () => {
    const { session } = lanes();
    session.status("idle");
    const before = (await h.inventory.refresh()).panes.find(p => p.window === "lane");
    expect(before).toMatchObject({ sessionId: session.sessionId });
    expect(before).not.toHaveProperty("topic");                        // no transcript yet
    expect(before).not.toHaveProperty("lastPrompt");
    const put = (...entries: object[]) => appendFileSync(session.transcript, entries.map(e => `${JSON.stringify(e)}\n`).join(""));
    put({ type: "ai-title", aiTitle: "Build the login page" },
      { type: "user", promptSource: "typed", message: { role: "user", content: "a long prompt ".repeat(500) } },
      { type: "last-prompt", lastPrompt: "add the tests" });
    const lane = async () => (await h.inventory.refresh()).panes.find(p => p.window === "lane");
    expect(await lane()).toMatchObject({ topic: "Build the login page", lastPrompt: "add the tests" });
    put({ type: "ai-title", aiTitle: "Login page, with tests" });          // appended later: the latest wins
    expect(await lane()).toMatchObject({ topic: "Login page, with tests", lastPrompt: "add the tests" });
    put({ type: "last-prompt", lastPrompt: "x".repeat(300) });
    expect((await lane())?.lastPrompt).toBe("x".repeat(200));             // at most 200 characters, so 64 panes fit one message
    const shell = (await h.inventory.refresh()).panes.find(p => p.window === "shell");
    expect(shell).toBeDefined();
    expect(shell).not.toHaveProperty("topic");                         // no session
    expect(shell).not.toHaveProperty("lastPrompt");
  });
});

describe("pane.keys by key name (spec §5)", () => {
  it("types tmux key names from the allow-list into the pane", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "shell", "-x", "100", "-y", "20", SHELL);
    const snap = await h.inventory.refresh();
    const p = snap.panes[0];
    if (!p || !snap.stamp) throw new Error("no pane");
    const names = ["e", "c", "h", "o", "Space", "k", "e", "y", "s", "Space", "4", "2", "Enter"];
    expect(await h.call("pane.keys", { workerId: p.workerId, names, expect: { server: snap.stamp, window: "shell" } }))
      .toMatchObject({ ok: true, result: { ok: true } });
    expect(await until(() => t.tmux("capture-pane", "-p", "-t", "=main:0").includes("\nkeys 42"))).toBe(true);
  });

  it("refuses a name off the list, data and names together, and neither (bad_args, not executed)", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "shell", SHELL);
    const snap = await h.inventory.refresh();
    const p = snap.panes[0];
    if (!p || !snap.stamp) throw new Error("no pane");
    const exp = { server: snap.stamp, window: "shell" };
    for (const keys of [{ names: ["F1"] }, { names: ["enter"] }, { names: ["Enter"], data: "x" }, {}, { names: [] }]) {
      expect(await h.call("pane.keys", { workerId: p.workerId, ...keys, expect: exp }), JSON.stringify(keys))
        .toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    }
  });
});
