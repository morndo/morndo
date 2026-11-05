// The test pane's Claude Code session turns each line the fake box submitted into a typed prompt in the transcript. The
// box appends a line in one write, but a read can run while that write is half done, so a reader takes a line only once
// its newline is there.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeSession } from "./claude-session.ts";
import { readSubmitted, tempHome, until, wait, wholeLines } from "./helpers.ts";

const homes: { cleanup: () => void }[] = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });

describe("wholeLines", () => {
  it("returns the lines that end in a newline and leaves a last line without one", () => {
    expect(wholeLines("")).toEqual([]);
    expect(wholeLines('"a"')).toEqual([]);
    expect(wholeLines('"a"\n')).toEqual(['"a"']);
    expect(wholeLines('"a"\n\n"b"\n"c')).toEqual(['"a"', '"b"']);       // an empty line is skipped
  });
});

describe("readSubmitted", () => {
  it("is empty without a file, and gives the strings of the whole lines and not the start of the last one", () => {
    const home = tempHome();
    homes.push(home);
    expect(readSubmitted(home.home)).toEqual([]);
    const file = join(home.home, "submitted.jsonl");
    writeFileSync(file, `${JSON.stringify("one")}\n${JSON.stringify("two").slice(0, 3)}`);
    expect(readSubmitted(home.home)).toEqual(["one"]);                   // the old readers threw on the half line
    appendFileSync(file, `${JSON.stringify("two").slice(3)}\n`);
    expect(readSubmitted(home.home)).toEqual(["one", "two"]);
  });
});

describe("claudeSession.follow", () => {
  it("waits for the newline of a half-written line, then writes its prompt once", async () => {
    const home = tempHome();
    homes.push(home);
    const tmux = { socket: "none", tmux: () => "4242", kill: async () => {} };
    const session = claudeSession({ tmux, claudeDir: join(home.home, "claude"), pane: "%0" });
    const submitted = join(home.home, "submitted.jsonl");
    const text = "x".repeat(2000);
    const whole = JSON.stringify(text);
    writeFileSync(submitted, whole.slice(0, 1200));                      // the start of the line, not its end
    const stop = session.follow(home.home);
    try {
      await wait(150);                                                   // several rounds of the 25 ms timer
      expect(existsSync(session.transcript)).toBe(false);
      appendFileSync(submitted, `${whole.slice(1200)}\n`);
      expect(await until(() => existsSync(session.transcript))).toBe(true);
      await wait(150);                                                   // several more timer rounds: the prompt must not be written again
      const rows = readFileSync(session.transcript, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
      expect(rows.length).toBe(1);
      expect(rows[0].message.content).toContain(text);                   // a long text arrives inside the pasted_content tags
    } finally { stop(); }
  });
});
