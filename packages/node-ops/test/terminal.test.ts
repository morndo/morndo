// The terminal adapter on a private tmux server: frames (size, cursor, colors) and keys as the browser's terminal sends them.
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyArgs, terminalAdapter } from "../src/terminal.ts";

const SOCKET = `morndo-term-${process.pid}`;
const tmux = (...a: string[]) => execFileSync("tmux", ["-L", SOCKET, ...a], { encoding: "utf8" });
const term = terminalAdapter({ socket: SOCKET });
let pane = "";
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(f: () => Promise<boolean>, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await wait(100); } return false; }

beforeAll(() => {
  tmux("new-session", "-d", "-s", "qa", "-x", "60", "-y", "12", "bash --norc --noprofile");
  tmux("send-keys", "-t", "qa", "PS1='$ '; clear", "Enter");
  pane = tmux("list-panes", "-t", "qa", "-F", "#{pane_id}").trim();
});
afterAll(() => { try { tmux("kill-server"); } catch { /* gone */ } });

describe("keys", () => {
  it("splits ASCII (as hex bytes) from other text (as literal UTF-8), in order", () => {
    expect(keyArgs("%1", "a\rä\x1b[A")).toEqual([
      "send-keys", "-t", "%1", "-H", "61", "0d", ";", "send-keys", "-t", "%1", "-l", "ä", ";", "send-keys", "-t", "%1", "-H", "1b", "5b", "41",
    ]);
  });
  it("typed text and Enter run in the pane; the Up arrow recalls it, as in a real terminal", async () => {
    expect(await term.keys(pane, "echo frame-$((6*7))\r")).toBe(true);
    expect(await until(async () => tmux("capture-pane", "-p", "-t", pane).includes("frame-42"))).toBe(true);
    await term.keys(pane, "\x1b[A");                                     // Up: bash shows the last command again
    expect(await until(async () => /\$ echo frame-\$\(\(6\*7\)\)\s*$/.test(tmux("capture-pane", "-p", "-t", pane).trimEnd()))).toBe(true);
    await term.keys(pane, "\x03");                                       // Ctrl+C clears the line
  });
  it("refuses a bad pane or too much text (negative control)", async () => {
    expect(await term.keys("main:0", "x")).toBe(false);
    expect(await term.keys(pane, "x".repeat(5000))).toBe(false);
  });
});

describe("frames", () => {
  it("has the pane's size and cursor, one line per row, with colors kept", async () => {
    await term.keys(pane, "clear; printf '\\033[31mred\\033[0m\\n'\r");
    expect(await until(async () => { const g = await term.frame(pane); return g !== null && g !== "unavailable" && g.lines.some(l => l.includes("\x1b[31mred")); })).toBe(true);
    const f = await term.frame(pane);
    expect(f).toMatchObject({ cols: 60, rows: 12, cursor: true });
    if (f === null || f === "unavailable") throw new Error("no frame");
    expect(f.lines).toHaveLength(12);
    expect(f.y).toBeGreaterThan(0);
  });
  it("is null for a pane that doesn't exist", async () => {
    expect(await term.frame("%999999")).toBeNull();
  });
});
