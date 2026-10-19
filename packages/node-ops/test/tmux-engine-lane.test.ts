// The engine layer's lane draws its input as "❯ " and the text, the last line on screen, with no rule above it. send types
// there only when the caller says the pane is such a lane (from its registry); otherwise that line is a shell prompt's.
import { afterEach, describe, expect, it } from "vitest";
import { engineLaneBoxOnScreen, tmuxAdapter } from "../src/tmux.ts";
import { isolatedTmux, type TestTmux } from "./isolated-tmux.ts";

let t: TestTmux | undefined;
afterEach(() => { const done = t?.kill(); t = undefined; return done; });

// A pane that prints `screen` and then reads one line with the echo off, as the lane's raw input does, and shows it back.
async function pane(screen: string) {
  t = isolatedTmux();
  const script = `stty -echo\nprintf '%s' '${screen}'\nIFS= read -r line\nprintf '\\nGOT:%s' "$line"\nsleep 30\n`;
  t.tmux("new-session", "-d", "-s", "main", "-x", "80", "-y", "24", "bash", "--norc", "--noprofile", "-c", script);
  const id = t.tmux("list-panes", "-t", "=main", "-F", "#{pane_id}").trim();
  for (let i = 0; i < 40 && !t.tmux("capture-pane", "-p", "-t", id).includes("❯"); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  return id;
}
const ENGINE = "engine-lane codex ready in /work/demo\n· turn done · STATUS: DONE\n❯ ";

describe("engineLaneBoxOnScreen", () => {
  it("is the last line on screen being the lane's input line", () => {
    expect(engineLaneBoxOnScreen(ENGINE)).toBe(true);
    expect(engineLaneBoxOnScreen("you: ping\n❯ half a draft\n\n\n")).toBe(true);
  });
  it("is not a menu's choice, a line with text below it, or a screen with no such line", () => {
    expect(engineLaneBoxOnScreen("Do you want to proceed?\n❯ 1. Yes\n  2. No")).toBe(false);
    expect(engineLaneBoxOnScreen("❯ 1. Yes")).toBe(false);
    expect(engineLaneBoxOnScreen("❯ old prompt\nthe agent answered here")).toBe(false);
    expect(engineLaneBoxOnScreen("user@host:~$ ")).toBe(false);
    expect(engineLaneBoxOnScreen("")).toBe(false);
  });
});

describe("send to an engine lane", () => {
  it("types into the lane's input line and submits, when the caller knows it is an engine lane", async () => {
    const id = await pane(ENGINE);
    expect(await tmuxAdapter({ socket: t!.socket, session: "main" }).send(id, "Build the demo", { engineLane: true })).toBeNull();
    expect(t!.tmux("capture-pane", "-p", "-t", id)).toContain("GOT:Build the demo");
  });
  it("refuses a pane that is not a registered engine lane though its last line looks like one: that is a shell prompt's (negative control)", async () => {
    const id = await pane(ENGINE);
    expect(await tmuxAdapter({ socket: t!.socket, session: "main" }).send(id, "rm -rf x")).toBe("no_input_box");
    expect(t!.tmux("capture-pane", "-p", "-t", id)).not.toContain("GOT:");
  });
  it("still waits for a draft in the lane's input line", async () => {
    const id = await pane(`${ENGINE}half a draft`);
    expect(await tmuxAdapter({ socket: t!.socket, session: "main" }).send(id, "Build the demo", { engineLane: true })).toBe("draft_present");
  });
  it("refuses an engine lane that shows no input line (its engine child printed over it, or it ended)", async () => {
    const id = await pane("engine-lane codex ready\nthe agent is writing here");
    expect(await tmuxAdapter({ socket: t!.socket, session: "main" }).send(id, "x", { engineLane: true })).toBe("no_input_box");
  });
});
