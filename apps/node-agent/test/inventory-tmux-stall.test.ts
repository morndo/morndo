// A tmux that does not answer is not an empty inventory (review V26). Real isolated tmux server; the stall is SIGSTOP,
// which makes tmux's client wait until the 5 s exec timeout. A gone server and a missing session stay `[]`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedTmux, tempHome, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
beforeEach(() => { home = tempHome(); t = isolatedTmux(); h = opsHarness({ home: home.home, socket: t.socket }); });
afterEach(() => { h.close(); t.kill(); home.cleanup(); });

describe("an inventory read that tmux did not answer", () => {
  it("rejects and keeps the last snapshot, and recovers when tmux answers again", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "api", "sleep 600");
    const before = await h.inventory.refresh();
    expect(before.panes.map(p => p.window)).toEqual(["api"]);
    const pid = Number(t.tmux("display-message", "-p", "#{pid}").trim());
    process.kill(pid, "SIGSTOP");
    try {
      await expect(h.inventory.refresh()).rejects.toThrow(/tmux/);
      expect(h.inventory.last().panes.map(p => p.window)).toEqual(["api"]);
      expect(h.inventory.invVersion).toBe(before.invVersion);
    } finally { process.kill(pid, "SIGCONT"); }
    const after = await h.inventory.refresh();
    expect(after.panes.map(p => p.window)).toEqual(["api"]);
    expect(after.invVersion).toBe(before.invVersion);
  }, 30_000);
  it("still answers [] when the policy's session does not exist (control)", async () => {
    t.tmux("new-session", "-d", "-s", "other", "-n", "x", "sleep 600");
    expect((await h.inventory.refresh()).panes).toEqual([]);
  });
  it("still answers [] when the server is gone (control)", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "api", "sleep 600");
    await h.inventory.refresh();
    t.kill();
    expect((await h.inventory.refresh()).panes).toEqual([]);
  });
});
