// A frame with its guard is one tmux command (EF5): the pane's session and server stamp are read with the frame, not by a
// second spawn first. Real isolated tmux server; a `tmux` on PATH that counts its calls and runs the real one.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { terminalAdapter } from "../src/terminal.ts";
import { isolatedTmux, type TestTmux } from "./isolated-tmux.ts";

let t: TestTmux, dir: string, pane: string, oldPath: string | undefined, real: string;
const calls = () => (readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean).length);
beforeAll(() => {
  t = isolatedTmux();
  t.tmux("new-session", "-d", "-s", "qa", "-x", "50", "-y", "10", "bash --norc --noprofile");
  t.tmux("set-option", "-g", "@morndo-server", "0123abcd-0000-4000-8000-000000000000");
  pane = t.tmux("list-panes", "-t", "qa", "-F", "#{pane_id}").trim();
  dir = mkdtempSync(join(tmpdir(), "morndo-frame-guard-"));
  real = (process.env.PATH ?? "").split(":").map(d => join(d, "tmux")).find(p => { try { readFileSync(p); return true; } catch { return false; } }) ?? "/opt/homebrew/bin/tmux";
  writeFileSync(join(dir, "tmux"), `#!/bin/sh\necho "$@" >> "${join(dir, "calls.log")}"\nexec "${real}" "$@"\n`);
  chmodSync(join(dir, "tmux"), 0o755);
  writeFileSync(join(dir, "calls.log"), "");
  oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
});
afterAll(async () => { process.env.PATH = oldPath; await t.kill(); rmSync(dir, { recursive: true, force: true }); });

describe("a guarded frame", () => {
  it("is one tmux spawn, and the frame when the session and the server stamp are the lane's", async () => {
    const before = calls();
    const frame = await terminalAdapter({ socket: t.socket }).frame(pane, { session: "qa", server: "0123abcd" });
    expect(calls() - before).toBe(1);
    expect(frame).toMatchObject({ cols: 50, rows: 10 });
  });
  it("is null for another server's stamp or another session (negative control)", async () => {
    const term = terminalAdapter({ socket: t.socket });
    expect(await term.frame(pane, { session: "qa", server: "00000000" })).toBeNull();
    expect(await term.frame(pane, { session: "other", server: "0123abcd" })).toBeNull();
  });
  it("without a guard is the frame as before", async () => {
    expect(await terminalAdapter({ socket: t.socket }).frame(pane)).toMatchObject({ cols: 50, rows: 10 });
  });
});
