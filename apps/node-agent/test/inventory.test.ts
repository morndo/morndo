// The inventory and reads on a real, isolated tmux server (`tmux -L test-<uuid>`). Plan Review Focus:
// 1. window names with spaces, unicode, dots, slashes (and a tab) are reported exactly and routed by worker ID;
// 2. tmux not running when the agent starts, or dying mid-run: an empty inventory, no crash, old worker IDs no_pane,
//    and a server that appears gets a stamp;
// 3. 64 panes with full captures fit one 512 KiB message, each capture capped at 6 KiB with `truncated`.
// The file runs as a service manager may start the agent: with no locale (LANG, LC_ALL and LC_CTYPE unset) and not
// inside tmux (TMUX and TMUX_PANE unset; a client inside tmux writes UTF-8 whatever the locale). Names must come through
// all the same (tmux -u).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tmuxAdapter } from "@morndo/node-ops";
import { LIMITS, parseWorkerId } from "@morndo/protocol";
import { isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

const SHELL = "bash --norc --noprofile";
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
const UNSET = ["LANG", "LC_ALL", "LC_CTYPE", "TMUX", "TMUX_PANE"] as const;
const saved = UNSET.map(k => process.env[k]);
beforeAll(() => { for (const k of UNSET) delete process.env[k]; });
afterAll(() => { UNSET.forEach((k, i) => { const v = saved[i]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }); });
beforeEach(() => { home = tempHome(); t = isolatedTmux(); h = opsHarness({ home: home.home, socket: t.socket }); });
afterEach(() => { h.close(); t.kill(); home.cleanup(); });

const stampNow = () => t.tmux("show-options", "-gqv", "@morndo-server").trim().slice(0, 8);
// The window name tmux itself shows for a pane (the whole output is the name: no splitting on anything).
const windowOf = (pane: string) => t.tmux("display-message", "-p", "-t", pane, "#{window_name}").replace(/\n$/, "");

describe("what the inventory reports", () => {
  const NAMES = ["fix: a/b ü.2", "x.y/z", "two  spaces", "tab\there", "ünïcødé ✓"];

  it("only single-pane windows of the policy's session, under worker IDs, with names exactly as they are", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", NAMES[0] as string, "-x", "80", "-y", "20", SHELL);
    for (const n of NAMES.slice(1)) t.tmux("new-window", "-d", "-t", "=main:", "-n", n, SHELL);
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "split", SHELL);
    t.tmux("split-window", "-d", "-t", "=main:split", SHELL);            // two panes: not a lane
    t.tmux("new-session", "-d", "-s", "other", "-n", "elsewhere", SHELL); // another session: not reported
    const r = await h.call("inventory.get", {});
    if (!r.ok) throw new Error(r.error.message);
    const { panes, invVersion } = r.result as { panes: { workerId: string; window: string; cwd: string }[]; invVersion: number };
    expect(panes.map(p => p.window).sort()).toEqual([...NAMES].sort());
    expect(invVersion).toBe(1);
    const stamp = stampNow();
    expect(stamp).toMatch(/^[0-9a-f]{8}$/);
    for (const p of panes) {
      const ref = parseWorkerId(p.workerId);
      expect(ref).toMatchObject({ node: "pc", server: stamp });
      expect(windowOf(`%${ref?.pane}`)).toBe(p.window);
      expect(p.workerId).toMatch(/^pc\.[0-9a-f]{8}\.\d+$/);              // URL-safe, nothing of the name in it
    }
    // Routed by worker ID with the exact name as the expectation: each pane gets only its own keys. A name with a
    // control character (the tab) is listed, but no expectation can name it: OP_ARGS refuses it here as at the fleet
    // (Review Focus 1).
    const steerable = panes.filter(p => !p.window.includes("\t"));
    expect(steerable).toHaveLength(NAMES.length - 1);
    for (const [i, p] of steerable.entries()) {
      const res = await h.call("pane.keys", { workerId: p.workerId, data: `echo routed-${i}-$((6*7))\r`, expect: { server: stamp, window: p.window } });
      expect(res).toMatchObject({ ok: true, result: { ok: true } });
    }
    for (const [i, p] of steerable.entries()) {
      expect(await until(async () => {
        const c = await h.call("pane.captureMany", { workerIds: [p.workerId] });
        const text = c.ok ? (c.result as { captures: { text: string | null }[] }).captures[0]?.text ?? "" : "";
        return text.includes(`routed-${i}-42`) && steerable.every((_, j) => j === i || !text.includes(`routed-${j}-42`));
      })).toBe(true);
    }
    const tabbed = panes.find(p => p.window.includes("\t"));
    if (!tabbed) throw new Error("no tab window");
    expect(await h.call("pane.keys", { workerId: tabbed.workerId, data: "x", expect: { server: stamp, window: tabbed.window } }))
      .toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
  });

  it("grows invVersion only when what is reported changes", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "one", SHELL);
    expect((await h.inventory.refresh()).invVersion).toBe(1);
    expect((await h.inventory.refresh()).invVersion).toBe(1);
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "two", SHELL);
    expect((await h.inventory.refresh()).invVersion).toBe(2);
    t.tmux("rename-window", "-t", "=main:two", "deux");
    expect((await h.inventory.refresh()).invVersion).toBe(3);
  });
});

describe("tmux not running, or dying mid-run (Review Focus 2)", () => {
  it("answers an empty inventory without a server, and stamps the server once one appears", async () => {
    expect(await h.call("inventory.get", {})).toMatchObject({ ok: true, result: { panes: [], invVersion: 0 } });
    expect(await h.call("pane.captureMany", { workerIds: ["pc.0a1b2c3d.0"] })).toMatchObject({ ok: true, result: { captures: [{ text: null, truncated: false }] } });
    expect(await h.call("pane.send", { workerId: "pc.0a1b2c3d.0", text: "x", expect: { server: "0a1b2c3d", window: "a" } }, { key: "hub:none" }))
      .toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
    expect(h.doneKeys.status("hub:none")).toEqual({ state: "unknown" });
    t.tmux("new-session", "-d", "-s", "main", "-n", "late", SHELL);
    const r = await h.call("inventory.get", {});
    expect(r).toMatchObject({ ok: true, result: { panes: [{ window: "late" }] } });
    expect(t.tmux("show-options", "-gqv", "@morndo-server").trim()).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  });

  it("empties the inventory when the server dies, and old worker IDs answer no_pane (not executed)", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "api", SHELL);
    const before = await h.inventory.refresh();
    const old = before.panes[0];
    if (!old) throw new Error("no pane");
    const stamp = before.stamp ?? "";
    t.kill();
    expect(await h.call("inventory.get", {})).toMatchObject({ ok: true, result: { panes: [], invVersion: 2 } });
    const exp = { server: stamp, window: "api" };
    expect(await h.call("pane.send", { workerId: old.workerId, text: "hi", expect: exp }, { key: "hub:dead" })).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
    expect(await h.call("pane.keys", { workerId: old.workerId, data: "x", expect: exp })).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
    expect(await h.call("pane.frame", { workerId: old.workerId })).toMatchObject({ ok: true, result: { frame: null } });
    expect(await h.call("pane.captureMany", { workerIds: [old.workerId] })).toMatchObject({ ok: true, result: { captures: [{ text: null }] } });
  });
});

describe("capture size (Review Focus 3)", () => {
  it("64 panes with full captures fit one 512 KiB message; each capture keeps its last 6 KiB and says truncated", async () => {
    // 200 lines of 180 characters with quotes, backslashes and non-ASCII, which JSON encoding makes longer.
    const line = (i: number) => `${String(i).padStart(3, "0")} "quoted" \\back\\ ü ❯ ─ ${"x".repeat(150)}`;
    const file = join(home.home, "screen.txt");
    writeFileSync(file, `${Array.from({ length: 200 }, (_, i) => line(i)).join("\n")}\n`);
    const show = `sh -c 'cat "${file}"; exec sleep 600'`;
    t.tmux("new-session", "-d", "-s", "main", "-n", "w0", "-x", "250", "-y", "50", show);
    for (let i = 1; i < 64; i++) t.tmux("new-window", "-d", "-t", "=main:", "-n", `w${i}`, show);
    const snap = await h.inventory.refresh();
    expect(snap.panes).toHaveLength(64);
    const ids = snap.panes.map(p => p.workerId);
    const raw = tmuxAdapter({ socket: t.socket, session: "main" });
    expect(await until(async () => (await Promise.all(snap.lanes.map(l => raw.capture(l.pane)))).every(c => c?.includes(line(199)) ?? false), 10_000)).toBe(true);
    const reply = await h.call("pane.captureMany", { workerIds: ids });
    if (!reply.ok) throw new Error(reply.error.message);
    const message = JSON.stringify({ v: 1, t: "res", ...reply });
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(LIMITS.maxMessageBytes);
    const captures = (reply.result as { captures: { workerId: string; text: string | null; truncated: boolean }[] }).captures;
    expect(captures.map(c => c.workerId)).toEqual(ids);
    for (const c of captures) {
      expect(c.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(c.text))).toBeLessThanOrEqual(LIMITS.captureBytesPerPane);
      expect(c.text?.endsWith(line(199))).toBe(true);                   // the bottom of the pane is kept
      expect(c.text?.startsWith(line(0).slice(0, 3)) ?? true).toBe(false);
    }
    // Negative control: the same captures uncapped would not fit one message.
    const uncapped = await Promise.all(snap.lanes.map(l => raw.capture(l.pane)));
    expect(Buffer.byteLength(JSON.stringify(uncapped))).toBeGreaterThan(LIMITS.maxMessageBytes);
  }, 60_000);
});
