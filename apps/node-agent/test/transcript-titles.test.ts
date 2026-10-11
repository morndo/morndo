// The topic and last prompt of a session (src/ops/transcript-titles.ts; RECONCILIATION.md rulings 13, 46 and 56): its
// transcript's latest ai-title and last-prompt entries, read from the tail and then from what was appended. Temporary
// transcripts with synthetic texts in Claude Code's shapes; no tmux.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptTitles } from "../src/ops/transcript-titles.ts";
import { tempHome } from "./helpers.ts";

let home: { home: string; cleanup: () => void };
let file = "";
beforeEach(() => { home = tempHome(); file = join(home.home, "s1.jsonl"); });
afterEach(() => home.cleanup());
const line = (o: object) => `${JSON.stringify(o)}\n`;
const titles = () => new TranscriptTitles(id => (id === "s1" ? file : null));

describe("a session's topic and last prompt (ruling 13)", () => {
  it("reads the latest ai-title and last-prompt, then only what was appended; a line still being written waits", async () => {
    const t = titles();
    expect(await t.read("s1")).toEqual({ topic: null, lastPrompt: null });              // no transcript yet
    writeFileSync(file, line({ type: "ai-title", aiTitle: "Build the login page" }) + line({ type: "last-prompt", lastPrompt: "add the tests" }));
    expect(await t.read("s1")).toEqual({ topic: "Build the login page", lastPrompt: "add the tests" });
    const next = JSON.stringify({ type: "ai-title", aiTitle: "Login page, with tests" });
    appendFileSync(file, next.slice(0, 12));
    expect((await t.read("s1")).topic).toBe("Build the login page");
    appendFileSync(file, `${next.slice(12)}\n`);
    expect((await t.read("s1")).topic).toBe("Login page, with tests");
    expect(await t.read("s2")).toEqual({ topic: null, lastPrompt: null });              // no transcript for that session
  });

  it("skips a last-prompt entry without lastPrompt, as 2 of 448 on the owner's PC were: no throw, never \"undefined\" (ruling 56)", async () => {
    writeFileSync(file, line({ type: "last-prompt" }) + line({ type: "last-prompt", lastPrompt: null }));
    const t = titles();
    expect(await t.read("s1")).toEqual({ topic: null, lastPrompt: null });
    appendFileSync(file, line({ type: "last-prompt", lastPrompt: "run the tests" }) + line({ type: "last-prompt", sessionId: "s1" }));
    expect(await t.read("s1")).toEqual({ topic: null, lastPrompt: "run the tests" });   // one without keeps the last known
    appendFileSync(file, line({ type: "ai-title" }) + "{\"type\":\"last-prompt\",\"lastPrompt\":\n");   // no aiTitle; a broken line
    expect(await t.read("s1")).toEqual({ topic: null, lastPrompt: "run the tests" });
  });

  it("cuts each to 200 characters, and reads only the last 4 MiB of a long transcript", async () => {
    writeFileSync(file, line({ type: "ai-title", aiTitle: "far back" })
      + line({ type: "assistant", message: { content: "z".repeat(1000) } }).repeat(5000) + line({ type: "last-prompt", lastPrompt: "p".repeat(300) }));
    expect(await titles().read("s1")).toEqual({ topic: null, lastPrompt: "p".repeat(200) });
  });
});
