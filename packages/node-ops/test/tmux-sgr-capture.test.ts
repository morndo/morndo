// tmux 3.4 `capture-pane -e` emits a curly underline as colon-form SGR (ESC[4:3m) and a hyperlink as OSC 8.
// Those sequences are styling, not typed text.
import { afterEach, describe, expect, it } from "vitest";
import { draftOnScreen } from "../src/tmux.ts";
import { isolatedTmux, type TestTmux } from "./isolated-tmux.ts";

const E = "\x1b";
let t: TestTmux | undefined;
afterEach(() => { const done = t?.kill(); t = undefined; return done; });

describe("a real tmux 3.4 capture", () => {
  it("keeps the words of a curly underline and a link, and drops the sequences", () => {
    t = isolatedTmux();
    t.tmux("new-session", "-d", "-s", "main", "-x", "120", "-y", "12", "bash", "--norc", "--noprofile");
    const id = t.tmux("list-panes", "-t", "=main", "-F", "#{pane_id}").trim();
    const cmd = String.raw`printf $'\033[4:3mcurly\033[0m \033]8;;http://inkwell.example\033\\linked\033]8;;\033\\ done\n'`;
    t.tmux("send-keys", "-t", id, "-l", cmd);
    t.tmux("send-keys", "-t", id, "Enter");
    let line = "";
    for (let i = 0; i < 30 && !line; i++) {
      const raw = t.tmux("capture-pane", "-p", "-e", "-t", id, "-S", "-15");
      line = raw.split("\n").find(l => l.includes(`${E}[4:3m`) && l.includes(`${E}]8;;`)) ?? "";
      if (!line) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    expect(line, "tmux 3.4 did not capture a curly underline and an OSC 8 link").not.toBe("");
    const screen = `${E}[39m❯ ${line}`;
    expect(draftOnScreen(screen)).toBe("curly linked done");
  });
});
