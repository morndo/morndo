// After paste+Enter, a swallowed Enter leaves the text in the box. The read-back can omit the one character under
// the cursor; that must not look like the paste was submitted.
import { afterEach, describe, expect, it } from "vitest";
import { tmuxAdapter } from "../src/tmux.ts";
import { isolatedTmux, type TestTmux } from "./isolated-tmux.ts";

const RULE = "────────────────────────────────";
let t: TestTmux | undefined;
afterEach(() => { t?.kill(); t = undefined; });

async function pane(redraw: string) {
  t = isolatedTmux();
  const script = `printf '%s\\n' '${RULE}' '❯ ' '${RULE}'\nIFS= read -r line\n${redraw}\nsleep 30\n`;
  t.tmux("new-session", "-d", "-s", "main", "-x", "80", "-y", "24", "bash", "--norc", "--noprofile", "-c", script);
  const id = t.tmux("list-panes", "-t", "=main", "-F", "#{pane_id}").trim();
  for (let i = 0; i < 40 && !t.tmux("capture-pane", "-p", "-t", id).includes("❯"); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return id;
}

describe("an unsubmitted paste", () => {
  it("is not_submitted even when the read-back lost the character under the cursor", async () => {
    const id = await pane(`holed="\${line:0:1}\${line:2}"\nprintf '%s\\n' '${RULE}' "❯ $holed" '${RULE}'`);
    expect(await tmuxAdapter({ socket: t!.socket, session: "main" }).send(id, "Hello there friend")).toBe("not_submitted");
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
  it("is not the paste when the box shows something else", async () => {
    const id = await pane(`printf '%s\\n' '${RULE}' '❯ something else' '${RULE}'`);
    expect(await tmuxAdapter({ socket: t!.socket, session: "main" }).send(id, "Hello there friend")).toBeNull();
  });
});
