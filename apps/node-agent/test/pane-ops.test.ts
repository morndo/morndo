// pane.send, pane.keys and pane.frame on a real isolated tmux server with a stand-in for Claude Code's input box
// (fake-claude.fixture.ts). Spec §4 "The expectation check", §5.3, §9 "Pane reuse" with its negative control, and the
// test hooks that act on panes (noExpect, clockOffsetMs).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmodSync, mkdtempSync, writeFileSync as writeFile } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaneLock } from "@morndo/node-ops";
import { isolatedTmux, tempHome, until, wait, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

const FIXTURE = join(import.meta.dirname, "fake-claude.fixture.ts");
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
let lane = { workerId: "", stamp: "" };
const dirOf = (name: string) => { const d = join(home.home, name); mkdirSync(d, { recursive: true }); return d; };
const claude = (dir: string) => `${process.execPath} ${FIXTURE} ${dir}`;
const submitted = (dir: string) => (existsSync(join(dir, "submitted.jsonl")) ? readFileSync(join(dir, "submitted.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as string) : []);
const screen = (target: string) => t.tmux("capture-pane", "-p", "-t", target);

async function startLane(dir: string, name = "lane-a") {
  t.tmux("new-session", "-d", "-s", "main", "-n", name, "-x", "100", "-y", "20", claude(dir));
  expect(await until(() => screen("=main:0").includes("❯"))).toBe(true);
  const snap = await h.inventory.refresh();
  const p = snap.panes.find(x => x.window === name);
  if (!p || !snap.stamp) throw new Error("no lane");
  return { workerId: p.workerId, stamp: snap.stamp };
}

beforeEach(async () => {
  home = tempHome();
  t = isolatedTmux();
  h = opsHarness({ home: home.home, socket: t.socket });
  lane = await startLane(dirOf("a"));
});
afterEach(() => { h.close(); t.kill(); home.cleanup(); });

const send = (text: string, key: string, expect: Record<string, unknown> = {}, workerId = lane.workerId, harness = h, timeoutMs?: number) =>
  harness.call("pane.send", { workerId, text, expect: { server: lane.stamp, window: "lane-a", ...expect } }, { key, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });

describe("pane.send", () => {
  it("types once, answers the node's typedAt, and a repeat of the key returns the stored outcome without typing", async () => {
    const before = Date.now();
    const r = await send("hello world", "hub:s1");
    expect(r).toMatchObject({ ok: true, result: { problem: null } });
    const typedAt = r.ok ? (r.result as { typedAt: number }).typedAt : 0;
    expect(typedAt).toBeGreaterThanOrEqual(before);
    expect(typedAt).toBeLessThanOrEqual(Date.now());
    expect(await until(() => submitted(join(home.home, "a")).length === 1)).toBe(true);
    expect(await send("hello world", "hub:s1")).toEqual(r.ok ? { ...r, id: "r2" } : r);
    await wait(500);
    expect(submitted(join(home.home, "a"))).toEqual(["hello world"]);
  });

  it("refuses with no_pane (not executed) when the window, server or session differ, and frees the key for the retry", async () => {
    for (const wrong of [{ window: "lane-b" }, { server: "00000000" }, { sessionId: "3f0c1d2e-0000-4000-8000-000000000000" }]) {
      expect(await send("only once", "hub:s2", wrong)).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
      expect(h.doneKeys.status("hub:s2")).toEqual({ state: "unknown" });
    }
    expect(await send("only once", "hub:s2")).toMatchObject({ ok: true, result: { problem: null } });
    expect(await until(() => submitted(join(home.home, "a")).length === 1)).toBe(true);
    expect(submitted(join(home.home, "a"))).toEqual(["only once"]);
  });

  it("reports typedAt on the node's wall clock, which the clockOffsetMs test hook moves", async () => {
    const other = tempHome();
    const shifted = opsHarness({ home: other.home, socket: t.socket, hooks: { clockOffsetMs: 3_600_000 } });
    try {
      const before = Date.now();
      const r = await send("an hour ahead", "hub:c1", {}, lane.workerId, shifted);
      expect(r).toMatchObject({ ok: true, result: { problem: null } });
      const typedAt = r.ok ? (r.result as { typedAt: number }).typedAt : 0;
      expect(typedAt).toBeGreaterThanOrEqual(before + 3_600_000);
      expect(typedAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
    } finally {
      shifted.close();
      other.cleanup();
    }
  });

  it("draft_present frees the key: after the draft is cleared, the retry with the same key types once", async () => {
    t.tmux("send-keys", "-t", "=main:0", "-l", "half");
    expect(await until(() => screen("=main:0").includes("❯ half"))).toBe(true);
    expect(await send("the message", "hub:s3")).toMatchObject({ ok: false, error: { code: "draft_present", executed: "no" } });
    expect(h.doneKeys.status("hub:s3")).toEqual({ state: "unknown" });
    t.tmux("send-keys", "-t", "=main:0", "BSpace", "BSpace", "BSpace", "BSpace");
    expect(await until(() => !screen("=main:0").includes("half"))).toBe(true);
    expect(await send("the message", "hub:s3")).toMatchObject({ ok: true, result: { problem: null } });
    expect(await until(() => submitted(join(home.home, "a")).length === 1)).toBe(true);
    expect(submitted(join(home.home, "a"))).toEqual(["the message"]);
  });
});

describe("pane reuse after a tmux restart (spec §9)", () => {
  async function restartWithReusedPane() {
    t.kill();
    const fresh = dirOf("b");
    t.tmux("new-session", "-d", "-s", "main", "-n", "lane-a", "-x", "100", "-y", "20", claude(fresh));
    expect(await until(() => screen("=main:0").includes("❯"))).toBe(true);
    expect(t.tmux("list-panes", "-a", "-F", "#{pane_id}").trim()).toBe(lane.workerId.replace(/^.*\./, "%"));   // %N reused
    await h.inventory.refresh();                                          // the new server gets its own stamp
    expect(t.tmux("show-options", "-gqv", "@morndo-server").trim().slice(0, 8)).not.toBe(lane.stamp);
    return fresh;
  }

  it("a send to the old worker ID is no_pane, and the new pane in the reused %N receives nothing", async () => {
    const fresh = await restartWithReusedPane();
    expect(await send("meant for the old lane", "hub:r1")).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
    await wait(600);
    expect(submitted(fresh)).toEqual([]);
  });

  it("negative control: with the expectation check disabled, the same send types into the new pane", async () => {
    const fresh = await restartWithReusedPane();
    const other = tempHome();
    const unguarded = opsHarness({ home: other.home, socket: t.socket, guard: () => true });
    try {
      expect(await send("meant for the old lane", "hub:r2", {}, lane.workerId, unguarded)).toMatchObject({ ok: true, result: { problem: null } });
      expect(await until(() => submitted(fresh).length === 1)).toBe(true);
      expect(submitted(fresh)).toEqual(["meant for the old lane"]);
    } finally {
      unguarded.close();
      other.cleanup();
    }
  });

  it("negative control through the noExpect test hook: the same send types into the new pane", async () => {
    const fresh = await restartWithReusedPane();
    const other = tempHome();
    const unguarded = opsHarness({ home: other.home, socket: t.socket, hooks: { noExpect: true } });
    try {
      expect(await send("meant for the old lane", "hub:r3", {}, lane.workerId, unguarded)).toMatchObject({ ok: true, result: { problem: null } });
      expect(await until(() => submitted(fresh).length === 1)).toBe(true);
      expect(submitted(fresh)).toEqual(["meant for the old lane"]);
    } finally {
      unguarded.close();
      other.cleanup();
    }
  });
});

describe("pane.keys and pane.frame", () => {
  it("keys reach the expected pane only", async () => {
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "shell", "bash --norc --noprofile");
    const snap = await h.inventory.refresh();
    const shell = snap.panes.find(p => p.window === "shell");
    if (!shell) throw new Error("no shell");
    expect(await h.call("pane.keys", { workerId: shell.workerId, data: "echo keyed-$((6*7))\r", expect: { server: lane.stamp, window: "shell" } }))
      .toMatchObject({ ok: true, result: { ok: true } });
    expect(await until(() => screen("=main:shell").includes("keyed-42"))).toBe(true);
    expect(await h.call("pane.keys", { workerId: shell.workerId, data: "echo nope\r", expect: { server: lane.stamp, window: "lane-a" } }))
      .toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
    await wait(300);
    expect(screen("=main:shell")).not.toContain("nope");
  });

  it("frame shows a live pane, and null for a worker ID of another server", async () => {
    const live = await h.call("pane.frame", { workerId: lane.workerId });
    expect(live).toMatchObject({ ok: true, result: { frame: { cols: 100, rows: 20 } } });
    expect(JSON.stringify(live)).toContain("❯");
    expect(await h.call("pane.frame", { workerId: lane.workerId.replace(/\.[0-9a-f]{8}\./, ".00000000.") })).toMatchObject({ ok: true, result: { frame: null } });
  });
});

describe("a pane lock that comes too late (spec §5.3, \"Deadlines\")", () => {
  it("never types: the lock arrived after the deadline, so the answer is timeout, not executed, and the key is freed", async () => {
    h.close();
    let held = 0;
    // A lock that another typist holds for 1.2 s: it is granted, but after this request's deadline (1 s − 250 ms).
    const late = (): PaneLock => async f => { await wait(1200); held++; return f(); };
    h = opsHarness({ home: home.home, socket: t.socket, policy: { lockedPanes: { "lane-a": join(home.home, "lane-a.lock") } }, lock: late });
    expect(await send("too late", "hub:late", {}, lane.workerId, h, 1000)).toMatchObject({ ok: false, error: { code: "timeout", executed: "no" } });
    expect(held).toBe(1);
    expect(h.doneKeys.status("hub:late")).toEqual({ state: "unknown" });
    await wait(500);
    expect(submitted(join(home.home, "a"))).toEqual([]);
    expect(await send("in time", "hub:late", {}, lane.workerId, h, 5000)).toMatchObject({ ok: true });   // negative control: a deadline the lock makes
    expect(await until(() => submitted(join(home.home, "a")).length === 1)).toBe(true);
  });

  // pane.send has a second check of its own: node-ops' tmux send asks the deadline's signal again before its paste. Keys
  // have none, so for them the late check after the lock (guarded's ctx.ready()) is all that stands between a late lock
  // and the pane.
  it("keys never arrive either: the lock arrived after the deadline, so the answer is timeout, not executed", async () => {
    h.close();
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "shell", "bash --norc --noprofile");
    const late = (): PaneLock => async f => { await wait(1200); return f(); };
    h = opsHarness({ home: home.home, socket: t.socket, policy: { lockedPanes: { shell: join(home.home, "shell.lock") } }, lock: late });
    const shell = (await h.inventory.refresh()).panes.find(p => p.window === "shell");
    if (!shell) throw new Error("no shell");
    const keys = (data: string, timeoutMs: number) => h.call("pane.keys", { workerId: shell.workerId, data, expect: { server: lane.stamp, window: "shell" } }, { timeoutMs });
    expect(await keys("echo late-$((6*7))\r", 1000), "pane.keys past the deadline").toMatchObject({ ok: false, error: { code: "timeout", executed: "no" } });
    await wait(500);
    expect(screen("=main:shell")).not.toContain("late-42");
    expect(await keys("echo in-time-$((6*7))\r", 5000)).toMatchObject({ ok: true, result: { ok: true } });   // negative control: a deadline the lock makes
    expect(await until(() => screen("=main:shell").includes("in-time-42"))).toBe(true);
  });
});

describe("a window named like an Object.prototype key (Task 8 review)", () => {
  it("\"constructor\" and \"__proto__\" find no lock in lockedPanes and are typed into; a window the policy names takes its lock", async () => {
    h.close();
    const taken: unknown[] = [];
    // As node-ops' paneLock: a lock file path is a string, anything else throws.
    const lock = (path: string): PaneLock => async f => {
      if (typeof path !== "string") throw new TypeError(`a lock path must be a string, not ${typeof path}`);
      taken.push(path);
      return f();
    };
    h = opsHarness({ home: home.home, socket: t.socket, policy: { lockedPanes: { "lane-a": join(home.home, "lane-a.lock") } }, lock });
    for (const name of ["constructor", "__proto__"]) {
      const dir = dirOf(name === "__proto__" ? "proto" : name);
      t.tmux("new-window", "-d", "-t", "=main:", "-n", name, claude(dir));
      let workerId = "";
      expect(await until(async () => (workerId = (await h.inventory.refresh()).panes.find(p => p.window === name)?.workerId ?? "") !== "")).toBe(true);
      expect(await until(() => screen(`=main:${name}`).includes("❯"))).toBe(true);
      const r = await h.call("pane.send", { workerId, text: `to ${name}`, expect: { server: lane.stamp, window: name } }, { key: `hub:${name}` });
      expect(r, `${name}: ${JSON.stringify(r)}`).toMatchObject({ ok: true, result: { problem: null } });
      expect(await until(() => submitted(dir).length === 1), name).toBe(true);
    }
    expect(taken).toEqual([]);
    expect(await send("locked", "hub:lane-a")).toMatchObject({ ok: true });            // negative control: lane-a's lock is taken
    expect(taken).toEqual([join(home.home, "lane-a.lock")]);
  });
});

const hasFlock = (() => { try { execFileSync("flock", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe("the pane lock (spec §3.1 \"Pane lock\")", () => {
  it.skipIf(!hasFlock)("a pane whose lock another typist holds is busy, not executed, and the key is freed", async () => {
    h.close();
    const lockFile = join(home.home, "manager.lock");
    writeFileSync(lockFile, "");
    h = opsHarness({ home: home.home, socket: t.socket, policy: { lockedPanes: { "lane-a": lockFile } } });
    const holder = spawn("flock", ["-x", lockFile, "-c", "echo held; sleep 5"], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise(r => holder.stdout.once("data", r));
    try {
      expect(await h.call("pane.send", { workerId: lane.workerId, text: "locked out", expect: { server: lane.stamp, window: "lane-a" } }, { key: "hub:l1", timeoutMs: 1500 }))
        .toMatchObject({ ok: false, error: { code: "busy", executed: "no" } });
      expect(h.doneKeys.status("hub:l1")).toEqual({ state: "unknown" });
      expect(submitted(join(home.home, "a"))).toEqual([]);
    } finally {
      holder.kill();
    }
  }, 20_000);
});

// The wrapper stands in for `tmux` on PATH: it stalls the first load-buffer for 8 s (as a loaded or stopped tmux would)
// and passes everything else to the real binary.
describe("pane.send with a tmux that stalls at the paste", () => {
  it("cuts the paste at 5 s, answers internal (it may have acted), and the next send is not blocked behind it", async () => {
    const bin = mkdtempSync(join(tmpdir(), "morndo-wrap-"));
    const flag = join(bin, "hang");
    const real = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
    writeFile(join(bin, "tmux"), `#!/bin/sh\ncase " $* " in *" load-buffer "*) if [ -e "${flag}" ]; then rm -f "${flag}"; sleep 8; fi ;; esac\nexec ${real} "$@"\n`);
    chmodSync(join(bin, "tmux"), 0o755);
    writeFile(flag, "");
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      const t0 = Date.now();
      const first = await send("first", "hub:v31a", {}, lane.workerId, h, 10_000);
      expect(Date.now() - t0).toBeLessThan(6500);
      expect(first).toMatchObject({ ok: false, error: { code: "internal", executed: "maybe" } });
      const second = await send("second", "hub:v31b", {}, lane.workerId, h, 10_000);
      expect(second).toMatchObject({ ok: true, result: { problem: null } });
    } finally { process.env.PATH = saved; }
  }, 30_000);
  it("a styled capture that outlasts the deadline answers timeout, executed no, and types nothing", async () => {
    const bin = mkdtempSync(join(tmpdir(), "morndo-wrap-"));
    const flag = join(bin, "slow");
    const real = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
    writeFile(join(bin, "tmux"), `#!/bin/sh\ncase " $* " in *" capture-pane "*" -e "*) if [ -e "${flag}" ]; then rm -f "${flag}"; sleep 2; fi ;; esac\nexec ${real} "$@"\n`);
    chmodSync(join(bin, "tmux"), 0o755);
    writeFile(flag, "");
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      expect(await send("late text", "hub:v44", {}, lane.workerId, h, 1500)).toMatchObject({ ok: false, error: { code: "timeout", executed: "no" } });
      await wait(1500);
      expect(submitted(join(home.home, "a"))).toEqual([]);
    } finally { process.env.PATH = saved; }
  }, 30_000);
  // The worst case for the deadline: the paste really runs (the wrapper calls tmux), then the client hangs past the
  // deadline until the 5 s SIGKILL. The text arrived, so the answer must stay in doubt and keep the key (ADR-0012
  // decision 7): only an abort before the paste is "not executed".
  it("a paste killed after the deadline stays in doubt: executed maybe, the key kept, and a retry with the key types nothing", async () => {
    const bin = mkdtempSync(join(tmpdir(), "morndo-wrap-"));
    const flag = join(bin, "typed-then-hang");
    const real = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
    writeFile(join(bin, "tmux"), `#!/bin/sh\ncase " $* " in *" load-buffer "*) if [ -e "${flag}" ]; then rm -f "${flag}"; ${real} "$@"; sleep 8; exit 0; fi ;; esac\nexec ${real} "$@"\n`);
    chmodSync(join(bin, "tmux"), 0o755);
    writeFile(flag, "");
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      const t0 = Date.now();
      const first = await send("typed once", "hub:killed-late", {}, lane.workerId, h, 2000);
      expect(Date.now() - t0).toBeGreaterThan(2000);                     // answered after the deadline, at the kill
      expect(first).toMatchObject({ ok: false, error: { code: "internal", executed: "maybe" } });
      expect(h.doneKeys.status("hub:killed-late")).toMatchObject({ state: "started" });
      expect(await until(() => submitted(join(home.home, "a")).length === 1)).toBe(true);
      expect(await send("typed once", "hub:killed-late", {}, lane.workerId, h, 5000)).toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe" } });
      await wait(1000);
      expect(submitted(join(home.home, "a"))).toEqual(["typed once"]);
    } finally { process.env.PATH = saved; }
  }, 30_000);
});
