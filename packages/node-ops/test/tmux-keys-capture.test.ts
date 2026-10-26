// The tmux adapter's additions for fleet clients (src/tmux.ts; docs/design/fleet-clients/README.md §5), on an isolated tmux
// server: keys by name, a capture of N lines with attributes, and the launcher's literal paste. A recorder pane (a shell
// that turns on bracketed paste, puts its terminal in raw mode and copies every byte it gets to a file) shows exactly what
// tmux sent. Synthetic text only.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KeyName } from "@morndo/protocol";
import { tmuxAdapter } from "../src/tmux.ts";
import { isolatedTmux, type TestTmux } from "./isolated-tmux.ts";

let t: TestTmux;
let dir: string;
beforeEach(() => { t = isolatedTmux(); dir = mkdtempSync(join(tmpdir(), "morndo-keys-")); });
afterEach(async () => { await t.kill(); rmSync(dir, { recursive: true, force: true }); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(f: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error(`not within ${ms} ms`); await sleep(20); }
}
// A pane that records the bytes it receives, once its terminal is raw (so Enter stays CR and C-c a byte, not a signal).
async function recorder(): Promise<{ pane: string; got: () => string }> {
  const out = join(dir, "got.bin");
  t.tmux("new-session", "-d", "-s", "main", "-x", "120", "-y", "40",
    `sh -c 'printf "\\033[?2004h"; stty raw -echo; : > ${out}.ready; exec cat > ${out}'`);
  await until(() => existsSync(`${out}.ready`));
  const pane = t.tmux("list-panes", "-t", "=main", "-F", "#{pane_id}").trim();
  return { pane, got: () => (existsSync(out) ? readFileSync(out, "latin1") : "") };
}

describe("sendKeyNames", () => {
  it("presses each named key as tmux names it", async () => {
    const r = await recorder();
    const names: KeyName[] = ["a", "1", "Space", "Tab", "BSpace", "Enter", "C-c", "C-u", "C-d", "Escape", "Up"];
    expect(await tmuxAdapter({ socket: t.socket, session: "main" }).sendKeyNames(r.pane, names)).toBe(true);
    await until(() => r.got().length >= 12);
    expect(r.got()).toMatch(/^a1 \t\x7f\r\x03\x15\x04\x1b\x1b(?:\[A|OA)$/);
  });
  it("refuses a name off the allow-list, no names, a pane that isn't one, and a pane that is gone; nothing is typed (negative controls)", async () => {
    const r = await recorder();
    const keys = tmuxAdapter({ socket: t.socket, session: "main" });
    expect(await keys.sendKeyNames(r.pane, ["kill-server" as KeyName])).toBe(false);
    expect(await keys.sendKeyNames(r.pane, ["Enter", "M-x" as KeyName])).toBe(false);
    expect(await keys.sendKeyNames(r.pane, [])).toBe(false);
    expect(await keys.sendKeyNames("main:0", ["Enter"])).toBe(false);
    expect(await keys.sendKeyNames("%999", ["Enter"])).toBe(false);
    await sleep(200);
    expect(r.got()).toBe("");
    expect(t.tmux("list-sessions", "-F", "#{session_name}").trim()).toBe("main");
  });
});

describe("capture with lines and attributes", () => {
  const PRINT = `sh -c 'i=1; while [ $i -le 300 ]; do echo "line $i"; i=$((i+1)); done; printf "\\033[2mdim tail\\033[0m\\n"; exec sleep 600'`;
  async function printed(): Promise<string> {
    t.tmux("new-session", "-d", "-s", "main", "-x", "120", "-y", "40", PRINT);
    const pane = t.tmux("list-panes", "-t", "=main", "-F", "#{pane_id}").trim();
    await until(() => t.tmux("capture-pane", "-p", "-t", pane).includes("dim tail"));
    return pane;
  }
  it("answers the screen's last N lines, from the history as well, without the pane's empty bottom", async () => {
    const pane = await printed();
    const text = await tmuxAdapter({ socket: t.socket, session: "main" }).capture(pane, { lines: 50 });
    const lines = text?.split("\n") ?? [];
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("line 252");
    expect(lines.at(-1)).toBe("dim tail");
  });
  it("with attributes, keeps tmux's escapes (kira reads dim text so); without, or by default, none", async () => {
    const pane = await printed();
    const tmux = tmuxAdapter({ socket: t.socket, session: "main" });
    expect(await tmux.capture(pane, { lines: 5, attributes: true })).toContain("\x1b[");
    expect(await tmux.capture(pane, { lines: 5, attributes: false })).not.toContain("\x1b[");
    expect(await tmux.capture(pane, { lines: 5 })).not.toContain("\x1b[");
  });
  it("joins a wrapped line unless join is false", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-x", "20", "-y", "10", `sh -c 'echo "${"w".repeat(50)}"; echo end; exec sleep 600'`);
    const pane = t.tmux("list-panes", "-t", "=main", "-F", "#{pane_id}").trim();
    await until(() => t.tmux("capture-pane", "-p", "-t", pane).includes("end"));
    const tmux = tmuxAdapter({ socket: t.socket, session: "main" });
    expect((await tmux.capture(pane, { lines: 10 }))?.split("\n")).toEqual(["w".repeat(50), "end"]);
    expect((await tmux.capture(pane, { lines: 10, attributes: false, join: false }))?.split("\n")).toEqual(["w".repeat(20), "w".repeat(20), "w".repeat(10), "end"]);
  });
  it("a count out of range, a pane that isn't one or is gone: null", async () => {
    const pane = await printed();
    const tmux = tmuxAdapter({ socket: t.socket, session: "main" });
    for (const lines of [0, 2001, 1.5]) expect(await tmux.capture(pane, { lines, attributes: false }), String(lines)).toBeNull();
    expect(await tmux.capture("main:0", { lines: 5, attributes: false })).toBeNull();
    expect(await tmux.capture("%999", { lines: 5, attributes: false })).toBeNull();
  });
});

describe("pasteLiteral (the launcher at a shell's prompt)", () => {
  it("pastes one line bracketed, every control character and newline left out, and presses no Enter", async () => {
    const r = await recorder();
    await tmuxAdapter({ socket: t.socket, session: "main" }).pasteLiteral(r.pane, "claude-as acct2\n--resume x\x1b[201~;rm\r");
    await until(() => r.got().endsWith("\x1b[201~"));
    expect(r.got()).toBe("\x1b[200~claude-as acct2--resume x[201~;rm\x1b[201~");
  });
  it("rejects a pane that isn't one, or is gone", async () => {
    await recorder();
    const tmux = tmuxAdapter({ socket: t.socket, session: "main" });
    await expect(tmux.pasteLiteral("main:0", "x")).rejects.toThrow("not a pane ID");
    await expect(tmux.pasteLiteral("%999", "x")).rejects.toThrow("tmux exited");
  });
});
