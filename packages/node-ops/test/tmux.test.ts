// The tmux adapter against a private tmux server with synthetic panes (never the principal's real sessions).
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tmuxAdapter } from "../src/tmux.ts";

const SOCKET = `morndo-test-${process.pid}`;
const tmux = (...a: string[]) => execFileSync("tmux", ["-L", SOCKET, ...a], { encoding: "utf8" });

beforeAll(() => {
  tmux("new-session", "-d", "-s", "qa", "-n", "build | er", "-x", "80", "-y", "20", "bash --norc --noprofile");
  tmux("new-window", "-t", "qa", "-n", "second", "bash --norc --noprofile");
  tmux("send-keys", "-t", "qa:0", "PS1='$ '; clear; echo synthetic-line-1", "Enter");
});
afterAll(() => { try { tmux("kill-server"); } catch { /* gone */ } });

describe("tmux adapter", () => {
  it("lists panes with names that contain separators and spaces", async () => {
    const workers = await tmuxAdapter({ socket: SOCKET, session: null }).listWorkers();
    expect(workers.map(w => w.name).sort()).toEqual(["build | er", "second"]);
    expect(workers.every(w => /^%\d+$/.test(w.id))).toBe(true);
  });
  it("filters by session", async () => {
    expect(await tmuxAdapter({ socket: SOCKET, session: "other" }).listWorkers()).toEqual([]);
  });
  it("captures a pane's text without trailing blank lines", async () => {
    const t = tmuxAdapter({ socket: SOCKET, session: null });
    const first = (await t.listWorkers()).find(w => w.name === "build | er");
    await new Promise(r => setTimeout(r, 300));
    const text = await t.capture(first?.id ?? "");
    expect(text).toContain("synthetic-line-1");
    expect(text?.endsWith("\n")).toBe(false);
  });
  it("refuses pane IDs that aren't pane IDs, and returns nothing without a server", async () => {
    expect(await tmuxAdapter({ socket: SOCKET, session: null }).capture("qa:0; kill-server")).toBeNull();
    expect(await tmuxAdapter({ socket: `${SOCKET}-none`, session: null }).listWorkers()).toEqual([]);
  });
});
