// After paste+Enter, a swallowed Enter leaves the text in the box. A short message that was delivered must not look
// unsent just because the box now holds something one character away from it.
import { afterEach, describe, expect, it } from "vitest";
import { tmuxAdapter } from "../src/tmux.ts";
import { isolatedTmux, type TestTmux } from "./isolated-tmux.ts";

const RULE = "────────────────────────────────";
let t: TestTmux | undefined;
afterEach(() => { const done = t?.kill(); t = undefined; return done; });

// The pane draws its own box with the terminal's echo off, as a TUI does. With echo on, the kernel's echo of a
// multi-line paste and the redraw interleave, even mid-line: n_tty wakes the reader at the first newline and echoes the
// rest as it goes (drivers/tty/n_tty.c), so the box line can lose its leading ❯.
async function pane(redraw: string) {
  t = isolatedTmux();
  const script = `stty -echo\nprintf '%s\\n' '${RULE}' '❯ ' '${RULE}'\nIFS= read -r line\n${redraw}\nsleep 30\n`;
  t.tmux("new-session", "-d", "-s", "main", "-x", "80", "-y", "24", "bash", "--norc", "--noprofile", "-c", script);
  const id = t.tmux("list-panes", "-t", "=main", "-F", "#{pane_id}").trim();
  for (let i = 0; i < 40 && !t.tmux("capture-pane", "-p", "-t", id).includes("❯"); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return id;
}

describe("an unsubmitted paste", () => {
  it("is not the paste when the read-back merely lost one character", async () => {
    const id = await pane(`holed="\${line:0:1}\${line:2}"\nprintf '%s\\n' '${RULE}' "❯ $holed" '${RULE}'`);
    expect(await tmuxAdapter({ socket: t!.socket, session: "main" }).send(id, "Hello there friend")).toBeNull();
  });
  it.each(["es", "ys", "ye"])("is not a delivered yes when the box shows %s", async (shown) => {
    const id = await pane(`printf '%s\\n' '${RULE}' '❯ ${shown}' '${RULE}'`);
    expect(await tmuxAdapter({ socket: t!.socket, session: "main" }).send(id, "yes")).toBeNull();
  });
  it("is not_submitted when the read-back is the paste itself", async () => {
    const id = await pane(`printf '%s\\n' '${RULE}' "❯ $line" '${RULE}'`);
    expect(await tmuxAdapter({ socket: t!.socket, session: "main" }).send(id, "Hello there friend")).toBe("not_submitted");
  });
  it("is not_submitted when the paste is folded into a chip", async () => {
    const id = await pane(`printf '%s\\n' '${RULE}' '❯ [Pasted text #1 +12 lines]' '${RULE}'`);
    const text = Array.from({ length: 12 }, (_, n) => `line ${n} of the notes`).join("\n");
    expect(await tmuxAdapter({ socket: t!.socket, session: "main" }).send(id, text)).toBe("not_submitted");
  });
  it("is not_submitted when only leading space was trimmed from the paste", async () => {
    const id = await pane(`printf '%s\\n' '${RULE}' '❯ fix the build' '${RULE}'`);
    expect(await tmuxAdapter({ socket: t!.socket, session: "main" }).send(id, "\n\n  fix the build")).toBe("not_submitted");
  });
  it("is not the paste when the box shows something else", async () => {
    const id = await pane(`printf '%s\\n' '${RULE}' '❯ something else' '${RULE}'`);
    expect(await tmuxAdapter({ socket: t!.socket, session: "main" }).send(id, "Hello there friend")).toBeNull();
  });
});
