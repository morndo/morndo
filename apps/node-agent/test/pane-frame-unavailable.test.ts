// pane.frame for a live pane while tmux does not answer: a "not now" answer, never frame:null (review V22; ports.ts:73-74).
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

const FIXTURE = join(import.meta.dirname, "fake-claude.fixture.ts");
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
let workerId = "";
beforeEach(async () => {
  home = tempHome(); t = isolatedTmux(); h = opsHarness({ home: home.home, socket: t.socket });
  const dir = join(home.home, "a"); mkdirSync(dir, { recursive: true });
  t.tmux("new-session", "-d", "-s", "main", "-n", "lane-a", "-x", "100", "-y", "20", `${process.execPath} ${FIXTURE} ${dir}`);
  expect(await until(() => t.tmux("capture-pane", "-p", "-t", "=main:0").includes("❯"))).toBe(true);
  workerId = (await h.inventory.refresh()).panes[0]?.workerId ?? "";
});
afterEach(async () => { h.close(); await t.kill(); home.cleanup(); });

describe("pane.frame while tmux does not answer", () => {
  it("a stalled tmux (SIGSTOP) is timeout, executed no; a frame comes back with tmux", async () => {
    const pid = Number(t.tmux("display-message", "-p", "#{pid}").trim());
    process.kill(pid, "SIGSTOP");
    try {
      expect(await h.call("pane.frame", { workerId }, { timeoutMs: 15_000 })).toMatchObject({ ok: false, error: { code: "timeout", executed: "no" } });
    } finally { process.kill(pid, "SIGCONT"); }
    expect(await h.call("pane.frame", { workerId })).toMatchObject({ ok: true, result: { frame: { cols: 100, rows: 20 } } });
  }, 30_000);
  it("running out of file descriptors (EMFILE) is timeout, not frame:null", async () => {
    const fds: number[] = [];
    try {
      try { for (;;) fds.push(openSync("/dev/null", "r")); } catch { /* EMFILE */ }
      expect(await h.call("pane.frame", { workerId })).toMatchObject({ ok: false, error: { code: "timeout" } });
    } finally { for (const fd of fds) closeSync(fd); }
  });
  it("a pane that is gone is still frame:null (control)", async () => {
    expect(await h.call("pane.frame", { workerId: workerId.replace(/\.[0-9a-f]{8}\./, ".00000000.") })).toMatchObject({ ok: true, result: { frame: null } });
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "other", "sleep 600");
    t.tmux("kill-window", "-t", "=main:0");
    expect(await h.call("pane.frame", { workerId })).toMatchObject({ ok: true, result: { frame: null } });
  });
});
