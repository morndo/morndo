// The test pane's Claude Code session turns each line the fake box submitted into a typed prompt in the transcript. The
// box appends a line in one write, but a read can run while that write is half done, so a reader takes a line only once
// its newline is there.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeSession } from "./claude-session.ts";
import { tempHome } from "./helpers.ts";

const homes: { cleanup: () => void }[] = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });

describe("claudeSession.follow", () => {
  it("waits for the newline of a half-written line, then writes its prompt once", () => {
    const home = tempHome();
    homes.push(home);
    const tmux = { socket: "none", tmux: () => "4242", kill: async () => {} };
    const session = claudeSession({ tmux, claudeDir: join(home.home, "claude"), pane: "%0" });
    const submitted = join(home.home, "submitted.jsonl");
    const text = "x".repeat(2000);
    const whole = JSON.stringify(text);
    const ROUND = 25;                                                    // the timer's period in follow()
    const rows = () => readFileSync(session.transcript, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
    writeFileSync(submitted, whole.slice(0, 1200));                      // the start of the line, not its end
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });      // the rounds are counted, not waited for
    let stop = () => {};
    try {
      stop = session.follow(home.home);
      vi.advanceTimersByTime(6 * ROUND);                                 // six rounds with the line half there: no prompt, no throw
      expect(existsSync(session.transcript)).toBe(false);
      appendFileSync(submitted, `${whole.slice(1200)}\n`);
      vi.advanceTimersByTime(ROUND);                                     // the next round writes it
      expect(rows().length).toBe(1);
      expect(rows()[0].message.content).toContain(text);                 // a long text arrives inside the pasted_content tags
      vi.advanceTimersByTime(6 * ROUND);                                 // and the rounds after it do not write it again
      expect(rows().length).toBe(1);
    } finally { stop(); vi.useRealTimers(); }
  });
});
