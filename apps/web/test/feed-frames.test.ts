// The app decodes every frame the hub sends (ADR-0008, A2): a malformed frame is dropped and the app keeps working; a
// frame type it doesn't know is ignored; an event of a type it doesn't know keeps its place in the sequence (O1), so
// the next event applies without a resync. Real Desktop client in headless Chromium, fake feed (harness.ts).
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

let web: Web;
let tab: Page;
let errors: string[];
beforeAll(async () => { web = await startWeb(); }, 60_000);
afterAll(async () => { await web?.close(); });
beforeEach(async () => {
  tab = await web.browser.newPage();
  errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }] });
  await tab.goto(web.url);
  await tab.locator("button.row", { hasText: "alpha" }).first().waitFor();
}, 60_000);
afterEach(async () => { await tab.close(); });

const raw = (s: string) => tab.evaluate(r => (globalThis as unknown as FeedWin).__feedRaw(r), s);
const push = (m: unknown) => tab.evaluate(x => (globalThis as unknown as FeedWin).__feedPush(x), m);
const hellos = () => tab.evaluate(() => (globalThis as unknown as FeedWin).__feedSent.filter(m => (m as { t: string }).t === "hello").length);
const rename = (seq: number, name: string) => ({ epoch: "e1", seq, at: 1, body: { type: "WorkerRenamed", workerId: "%1", name } });

describe("frames the app can't use", () => {
  it("are dropped without an error, and the app keeps applying good ones", { timeout: 20_000 }, async () => {
    await raw("not json at all");
    await raw("null");
    await raw("[1,2]");
    await push({ t: "snapshot", epoch: "e2", seq: -1, workers: [{ id: "%9", name: "intruder" }] });                  // malformed
    await push({ t: "messages", worker: "%1" });                                                                          // malformed
    await push({ t: "from-a-newer-hub", x: 1 });                                                                          // unknown
    await push({ t: "events", events: [rename(1, "gamma")] });
    await tab.locator("button.row", { hasText: "gamma" }).first().waitFor({ timeout: 5000 });
    expect(await tab.locator("button.row", { hasText: "intruder" }).count()).toBe(0);
    expect(errors).toEqual([]);
    expect(await hellos()).toBe(1);                                    // nothing above forced a resync
  });
  it("an event of a type the app doesn't know keeps its place: the next one applies without a resync", { timeout: 20_000 }, async () => {
    await push({ t: "events", events: [{ epoch: "e1", seq: 1, at: 1, body: { type: "WorkerLearnedToFly", workerId: "%1" } }, rename(2, "delta")] });
    await tab.locator("button.row", { hasText: "delta" }).first().waitFor({ timeout: 5000 });
    expect(errors).toEqual([]);
    expect(await hellos()).toBe(1);
  });
  it("a malformed event drops its frame and resyncs, as a gap would", { timeout: 20_000 }, async () => {
    await push({ t: "events", events: [{ epoch: "e1", seq: 1, at: 1, body: { type: "WorkerRenamed", workerId: "%1" } }] });
    await tab.waitForFunction(() => (globalThis as unknown as FeedWin).__feedSent.filter(m => (m as { t: string }).t === "hello").length === 2, undefined, { timeout: 5000 });
    expect(errors).toEqual([]);
  });
});

describe("a list element the app can't read (review M1)", () => {
  it("is dropped alone: the rest of the snapshot applies", { timeout: 20_000 }, async () => {
    await push({ t: "snapshot", epoch: "e3", seq: 0, workers: [
      { id: "%5", name: "kept", location: "/w", title: null, lastMessageAt: null, needsYou: false, state: "quiet", changedAt: 0 },
      { id: "%6", name: "broken", needsYou: "yes" },
      { id: "%7", name: "w".repeat(400), location: "/w", title: null, lastMessageAt: null, needsYou: false, state: "hibernating", changedAt: 0 },
    ] });
    await tab.locator("button.row", { hasText: "kept" }).first().waitFor({ timeout: 5000 });
    expect(await tab.locator("button.row", { hasText: "broken" }).count()).toBe(0);
    expect(await tab.locator("button.row", { hasText: "w".repeat(400) }).count()).toBe(1);   // long name, unknown state
    expect(errors).toEqual([]);
  });
});
