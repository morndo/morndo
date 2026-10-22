// The reply style ask (T-308): which Stops of an exempt (orchestrator) lane are asked for a short, plain digest or
// card, and, over real HTTP, that an asked Stop is answered {"decision":"block","reason"} and kept marked statusAsked,
// as the status ask is (status-ask.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusContract } from "../src/config.ts";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { nodeOpener } from "../src/ops/node-files.ts";
import { agentPaths } from "../src/paths.ts";
import { replyStyleAsk, replyStyleReason, type NotLiveOf } from "../src/relay/digest-check.ts";
import { RelayFiles } from "../src/relay/relay-files.ts";
import { startRelay, type Relay } from "../src/relay/server.ts";
import { Spool } from "../src/relay/spool.ts";
import { captureLog, tempHome } from "./helpers.ts";

const ASK: StatusContract = { mode: "ask", exempt: ["manager"] };
const stop = (over: Record<string, unknown> = {}) => ({
  session_id: "s1", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "### Digest\nAll good.", ...over,
});
// n plain letter-only words: no digits and no hashes, so no rule but length can read them.
const words = (n: number) => Array.from({ length: n }, (_, i) => ["alpha", "beta", "gamma", "delta", "eps"][i % 5]!).join(" ");
const digest = (lines: string[]) => `### Digest\n${lines.join("\n")}`;
const long = () => digest(Array.from({ length: 6 }, () => words(43)));   // 6 lines, 258 words
const ask = (message: string, over: Record<string, unknown> = {}, notLiveOf?: NotLiveOf) =>
  replyStyleAsk(stop({ last_assistant_message: message, ...over }), "manager", ASK, notLiveOf);

describe("the reply style ask", () => {
  it("a 258-word digest is sent back once with the reason", async () => {
    const reason = await ask(long());
    expect(reason).toBe(replyStyleReason("digest", ["258 words (the limit is 120)"]));
    expect(reason).toContain("Your digest is too long or too hard to read on a phone");
    expect(reason).not.toContain("\n");                                  // one short paragraph
    expect(await ask(long(), { stop_hook_active: true })).toBeNull();     // once per turn
  });

  it("a compliant digest passes", async () => {
    const short = digest(["The build is green.", "Two lanes finished.", "One asks for a key.", "Reviews are clear.", "Nothing is open.", "The queue is empty."]);
    expect(await ask(short)).toBeNull();
    expect(await ask(`${short}\n<details><summary>More</summary>\n${words(300)} and #96\n</details>`)).toBeNull();   // only the visible part counts
  });

  it("it never blocks twice in a row", async () => {
    expect(await ask(long())).not.toBeNull();
    const rewrite = digest(Array.from({ length: 6 }, () => words(45)));  // a rewrite that is still too long
    expect(await ask(rewrite, { stop_hook_active: true })).toBeNull();   // the Stop Claude Code sends after the ask
  });

  it("a card over the limit is asked once", async () => {
    const line = "one plain line of the card";
    const card = (n: number) => [...Array.from({ length: n }, () => line), "[buttons ask-1] go=Go | stop=Stop"].join("\n");
    const reason = await ask(card(10));
    expect(reason).toBe(replyStyleReason("card", ["10 lines (the limit is 8)"]));
    expect(reason).toContain("Your card is too long");
    expect(await ask(card(10), { stop_hook_active: true })).toBeNull();
    expect(await ask(card(8))).toBeNull();                               // the buttons line is not counted
  });

  it("a non-manager lane is never asked", async () => {
    const body = stop({ last_assistant_message: long() });
    expect(await replyStyleAsk(body, "api", ASK)).toBeNull();
    expect(await replyStyleAsk(body, null, ASK)).toBeNull();
    expect(await replyStyleAsk(body, "manager", { mode: "off", exempt: ["manager"] })).toBeNull();
    expect(await replyStyleAsk(stop({ last_assistant_message: long(), hook_event_name: "SubagentStop" }), "manager", ASK)).toBeNull();
    expect(await replyStyleAsk(stop({ last_assistant_message: undefined }), "manager", ASK)).toBeNull();
    expect(await replyStyleAsk("text", "manager", ASK)).toBeNull();
  });

  it("the ask names the exact reason", async () => {
    expect(await ask(digest(Array.from({ length: 9 }, (_, i) => `plain line ${"abcdefghi"[i]}`))))
      .toBe(replyStyleReason("digest", ["9 lines (the limit is 8)"]));
    expect(await ask(digest(Array.from({ length: 5 }, () => words(30)))))
      .toBe(replyStyleReason("digest", ["150 words (the limit is 120)"]));
    expect(await ask(digest(["See #96 and 5b354d6 and ny-538, also defaced and 1234567"])))
      .toBe(replyStyleReason("digest", ['the jargon "#96", "5b354d6", "ny-538" (say what it is in words)']));
    const nine = digest([`${words(20)} #96`, ...Array.from({ length: 8 }, () => words(20))]);
    expect(await ask(nine)).toBe(replyStyleReason("digest", [
      "9 lines (the limit is 8)", "181 words (the limit is 120)", 'the jargon "#96" (say what it is in words)',
    ]));
  });

  it("only the visible part counts", async () => {
    expect(await ask(`<details><summary>draft</summary>\n${long()}\n</details>\nSTATUS: DONE\nThe week in one line.`)).toBeNull();
    expect(await ask(`<details>\n${long()}`)).toBe(replyStyleReason("digest", ["258 words (the limit is 120)"]));   // unclosed: nothing removed
    expect(await ask(`STATUS: DONE\n[quiet]\npreamble before the heading\n${digest(["One line.", "Two lines."])}`)).toBeNull();
    expect(await ask("STATUS: DONE\n[quiet]\nplain card line\n[buttons ask-1] go=Go | stop=Stop")).toBeNull();
    expect(await ask(words(500))).toBeNull();                            // neither a digest heading nor a buttons last line
    expect(await ask(`${digest(["One line."])}\n### Notes\n${words(200)}`)).toBeNull();   // the digest ends at the next heading
  });

  it("not live: a task listed as done while the board has its merge not live", async () => {
    const board: NotLiveOf = async () => [{ key: "T-310", shas: ["5b354d6aa"] }];
    expect(await ask(digest(["- [x] T-310 merged"]), {}, board))
      .toContain('"T-310" listed as done, but the board has the merge not live yet');
    const bySha = await ask(digest(["5b354d6 done"]), {}, board);
    expect(bySha).toContain('the jargon "5b354d6" (say what it is in words)');
    expect(bySha).toContain('"T-310" listed as done, but the board has the merge not live yet');
    expect(await ask(digest(["T-310 merged, not live until the next release"]), {}, board)).toBeNull();   // honest
    expect(await ask(digest(["- [x] T-311 merged"]), {}, board)).toBeNull();                              // not in the list
    const unreadable: NotLiveOf = async () => null;                     // the board can't be read: only this rule is skipped
    const withBoth = await ask(digest(["- [x] T-310 merged", "#96 needs a word", ...Array.from({ length: 7 }, (_, i) => `plain line ${"abcdefghi"[i]}`)]), {}, unreadable);
    expect(withBoth).toContain("9 lines (the limit is 8)");
    expect(withBoth).toContain('the jargon "#96" (say what it is in words)');
    expect(withBoth).not.toContain("not live yet");
    const spy: NotLiveOf = vi.fn(async () => [{ key: "T-310", shas: [] }]);
    await ask(digest(["T-310 is in review"]), {}, spy);                 // no done word: never named
    await ask(digest(["everything is done here"]), {}, spy);            // a done line that names nothing
    expect(spy).not.toHaveBeenCalled();
    await ask(digest(["- [x] T-310 merged"]), {}, spy);
    expect(spy).toHaveBeenCalledTimes(1);                                // once per Stop
    expect(await ask(digest(["- [x] T-310 merged"]))).toBeNull();       // no board wired: the rule is skipped
  });
});

describe("the reply style ask: how kira and markdown see the answer", () => {
  const line = "one plain line of the card";
  const lines = (n: number) => Array.from({ length: n }, () => line);

  it("a buttons line is read as kira reads it: last non-empty line, trimmed, any case, the id's grammar, no wider", async () => {
    for (const buttons of ["[BUTTONS ask-1] go=Go | stop=Stop", "   [Buttons ask-1] go=Go | stop=Stop  ", "[buttons ask-1]"]) {
      expect(await ask([...lines(10), buttons].join("\n")), buttons).toBe(replyStyleReason("card", ["10 lines (the limit is 8)"]));
      expect(await ask([...lines(8), buttons].join("\n")), buttons).toBeNull();                 // it is not a line
    }
    for (const notButtons of ["[buttons ask 1] go=Go", "[buttons ask-1 go=Go", `[buttons ${"a".repeat(33)}] go=Go`, "see [buttons ask-1] go=Go", "[buttons]"]) {
      expect(await ask([...lines(10), notButtons].join("\n")), notButtons).toBeNull();            // kira would not parse it: no card
    }
    expect(await ask([...lines(10), "[buttons ask-1] go=Go", ""].join("\n"))).not.toBeNull();     // trailing blank lines: still last
    expect(await ask(["[buttons ask-1] go=Go", ...lines(10)].join("\n"))).toBeNull();              // not last: no card
  });

  it("[quiet] is read as kira reads it: first thing, any case, leading space", async () => {
    expect(await ask(["  [QUIET] first line", ...lines(7), "[buttons ask-1] go=Go"].join("\n"))).toBeNull();   // 8 lines, the tag is not one
    expect(await ask(["[Quiet]", ...lines(8), "[buttons ask-1] go=Go"].join("\n"))).toBeNull();
    expect(await ask(["[quiet]", ...lines(9), "[buttons ask-1] go=Go"].join("\n"))).not.toBeNull();
  });

  it("a digest heading is ## or ### (up to three spaces in), and a heading in a code fence is no heading", async () => {
    const body = Array.from({ length: 6 }, () => words(43));
    expect(await ask(["## Digest", ...body].join("\n"))).toBe(replyStyleReason("digest", ["258 words (the limit is 120)"]));
    expect(await ask(["   ### Digest", ...body].join("\n"))).toBe(replyStyleReason("digest", ["258 words (the limit is 120)"]));
    expect(await ask(["#### Digest", ...body].join("\n"))).toBeNull();                              // not one of the two
    expect(await ask(["    ### Digest", ...body].join("\n"))).toBeNull();                           // four spaces: code, not a heading
    expect(await ask(["# Digest", ...body].join("\n"))).toBeNull();
    for (const fence of ["```", "~~~"]) {
      expect(await ask([fence, "### Digest", fence, ...body].join("\n"))).toBeNull();               // an example in a fence
      expect(await ask([fence + "md", "### Digest", ...body, fence].join("\n"))).toBeNull();
    }
    expect(await ask(["```", "### Notes", "```", "### Digest", ...body].join("\n"))).not.toBeNull();   // a closed fence ends
    expect(await ask(["### Digest", "short line", "```", "### Notes", "```", ...body].join("\n"))).not.toBeNull();   // a fenced heading doesn't end the digest
    expect(await ask(["## Digest", "short line", "### Sub", ...body].join("\n"))).not.toBeNull();  // a deeper heading is inside it
    expect(await ask(["## Digest", "short line", "## Next", ...body].join("\n"))).toBeNull();      // the same level ends it
  });

  it("not live is excused only for the task it is said of, and a key is read in any case", async () => {
    const board: NotLiveOf = async () => [{ key: "T-310", shas: ["5b354d6aa"] }, { key: "T-311", shas: [] }];
    const said = '"T-310" listed as done, but the board has the merge not live yet';
    expect(await ask(digest(["T-310 merged and T-311 not live"]), {}, board)).toContain(said);       // T-311's words are not T-310's
    expect(await ask(digest(["T-310 merged, not live until the next release"]), {}, board)).toBeNull();
    const second = await ask(digest(["T-310 merged (not live), T-311 merged"]), {}, board);
    expect(second).toContain('"T-311" listed as done');
    expect(second).not.toContain('"T-310"');
    expect(await ask(digest(["t-310 merged"]), {}, board)).toContain(said);                          // lower case: the same key
    expect(await ask(digest(["T-310 MERGED"]), {}, board)).toContain(said);
    expect(await ask(digest(["T-310 not live yet; merged, T-311 done"]), {}, board)).toContain('"T-311" listed as done');
  });
});

describe("the relay asks over HTTP", () => {
  let home: { home: string; cleanup: () => void };
  let adb: AgentDb;
  let spool: Spool;
  let relay: Relay;
  let window = "manager";
  beforeEach(async () => {
    home = tempHome();
    const paths = agentPaths(home.home);
    adb = openAgentDb(paths.dbPath);
    spool = new Spool(adb.db, adb.streamId, { now: () => 1_000 });
    const files = new RelayFiles({ dir: paths.relayFilesDir, db: adb.db, open: nodeOpener({ home: home.home, stateDir: paths.stateDir, configDir: paths.configDir }), now: () => 1_000 });
    window = "manager";
    relay = await startRelay({
      port: 0, spool, files, log: captureLog().log, onAppended: () => {}, now: () => 1_000,
      windowOf: () => window, ask: (body, w) => replyStyleAsk(body, w, ASK),
    });
  });
  afterEach(async () => { await relay.close(); adb.close(); home.cleanup(); });
  const post = (body: unknown) => fetch(`http://127.0.0.1:${relay.port}/hook/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("blocks the first long digest and keeps it marked statusAsked; the Stop after it passes", async () => {
    const message = long();
    const asked = await post(stop({ last_assistant_message: message }));
    expect(asked.status).toBe(200);
    expect(asked.headers.get("content-type")).toBe("application/json");
    expect(await asked.json()).toEqual({ decision: "block", reason: replyStyleReason("digest", ["258 words (the limit is 120)"]) });
    expect(spool.after(0, 10).map(e => e.body)).toEqual([{ ...stop({ last_assistant_message: message }), statusAsked: true }]);
    const after = await post(stop({ last_assistant_message: message, stop_hook_active: true }));
    expect(await after.json()).toEqual({ ok: true, queued: true });
    expect(spool.after(0, 10).map(e => (e.body as { statusAsked?: boolean }).statusAsked ?? false)).toEqual([true, false]);
  });

  it("a lane that is not exempt is not asked over HTTP", async () => {
    window = "api";
    const plain = await post(stop({ last_assistant_message: long() }));
    expect(await plain.json()).toEqual({ ok: true, queued: true });
    expect(spool.after(0, 10).map(e => (e.body as { statusAsked?: boolean }).statusAsked ?? false)).toEqual([false]);
  });
});
