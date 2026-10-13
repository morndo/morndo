// The sends rows of escalation answers, as the store reads them back: the row a request wrote, and every answer row
// under a key prefix (review of PR #55, round 3).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/adapters/store.ts";
import { answerKey } from "../src/application/escalation-service.ts";

const T0 = Date.UTC(2026, 9, 1, 8);
const ship = { kind: "option" as const, key: "ship" };

describe("answer rows in the store", () => {
  let dir: string, store: Store;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-answer-rows-")); store = new Store(dir); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  // One request can hold rows for two versions of an ask: asked again in between, the first never started at its node,
  // the same choice typed anew under the new version's key (round 3.6). Which row it reads back is the latest it
  // wrote, every time, not whichever SQLite meets first.
  it("reads back the latest row a request wrote when it wrote two", () => {
    const v1 = answerKey("ny-7", { messageId: "m1", askedAt: T0 - 60_000 }, ship);
    const v2 = answerKey("ny-7", { messageId: "m2", askedAt: T0 }, ship);
    store.startAnswer(v1, T0 - 2000, { workerId: "%0", request: "desk:r1" });
    store.startAnswer(v2, T0 - 1000, { workerId: "%0", request: "desk:r1" });
    expect(store.sendOfRequest("desk:r1")?.key).toBe(v2);
  });

  // The latest by insertion, never by the hub's clock (round 4.9): the clock stepped back between the two writes, so
  // the second row has the earlier time. It is still the one the request wrote last.
  it("reads back the row a request wrote last when the clock stepped back between the two", () => {
    const v1 = answerKey("ny-7", { messageId: "m1", askedAt: T0 - 60_000 }, ship);
    const v2 = answerKey("ny-7", { messageId: "m2", askedAt: T0 }, ship);
    store.startAnswer(v1, T0, { workerId: "%0", request: "desk:r1" });
    store.startAnswer(v2, T0 - 2000, { workerId: "%0", request: "desk:r1" });                 // NTP stepped back 2 s
    expect(store.sendOfRequest("desk:r1")?.key).toBe(v2);
  });

  // The rows under a prefix are a range of the primary key (round 3.7): the table also holds a day of steering sends,
  // which a scan of it would read too.
  it("reads the rows under a prefix by a range of the primary key, not a scan of every send", () => {
    store.startSend("pc.aaaaaaaa.0:3fa2c1d0-0000-4000-8000-000000000001", T0);              // a steering send
    store.startAnswer(answerKey("ny-7", { messageId: "m1", askedAt: T0 }, ship), T0, { workerId: "%0", request: "desk:r1" });
    const proto = Object.getPrototypeOf(store.db.prepare("SELECT 1")) as { all: (...args: unknown[]) => unknown[] };
    const all = vi.spyOn(proto, "all");
    expect(store.answersOfAsk("answer:").map(r => r.key)).toEqual(["answer:ny-7:m1:option:ship"]);
    const stmt = all.mock.contexts[0] as { source: string };
    const args = all.mock.calls[0] ?? [];
    all.mockRestore();
    const plan = (store.db.prepare(`EXPLAIN QUERY PLAN ${stmt.source}`).all(...args) as { detail: string }[]).map(r => r.detail);
    expect(plan.some(d => /^SEARCH sends USING INDEX sqlite_autoindex_sends_1 \(key>\? AND key<\?\)/.test(d))).toBe(true);
    expect(plan.filter(d => d.startsWith("SCAN sends"))).toEqual([]);
  });

  // The range holds exactly the keys under an ask's prefix (round 4.4 of the PR #55 review). The prefix ends in ":", as
  // every caller's does (askPrefix), so the bound is that ":" made ";": not a key one character past the prefix, nor
  // another ask whose message id only begins the same way. Any other prefix is refused rather than read with a bound
  // that may not hold (a last character of U+D7FF or U+10FFFF has no next one that SQLite keeps).
  it("reads exactly the keys under an ask's prefix, and refuses a prefix that does not end in a colon", () => {
    const keys = ["answer:ny-7:m1:option:ship", "answer:ny-7:m10:option:ship", "answer:ny-7:m1;", "answer:ny-7:m1", "answer;", "answe"];
    for (const key of keys) store.startAnswer(key, T0, { workerId: "%0", request: `desk:${key}` });
    expect(store.answersOfAsk("answer:ny-7:m1:").map(r => r.key)).toEqual(["answer:ny-7:m1:option:ship"]);
    expect(store.answersOfAsk("answer:").map(r => r.key).sort()).toEqual(keys.filter(k => k.startsWith("answer:")).sort());
    for (const prefix of ["answer:ny-7:m1", "answer:x\uD7FF", "answer:x\u{10FFFF}", ""]) {
      expect(() => store.answersOfAsk(prefix)).toThrow(/ends in ":"/);
    }
  });
});
