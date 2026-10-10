// The feed's liveness as the app wires it (ADR-0008 phase B, review L8): the real Desktop client in headless Chromium,
// a fake feed (harness.ts) and Playwright's clock. A hub that stops answering pings is replaced within 35 s and the new
// socket resumes from the cursor; a handshake refused because the device is signed out ends with "Signed out".
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
  await tab.clock.install();
  await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }] });
  await tab.goto(web.url);
  await tab.locator("button.row", { hasText: "alpha" }).first().waitFor();
}, 60_000);
afterEach(async () => { await tab.close(); });

const status = () => tab.locator(".conn").first().innerText();

describe("liveness in the app", () => {
  it("a hub that stops answering pings is replaced, and the new socket resumes from its cursor", { timeout: 30_000 }, async () => {
    await tab.evaluate(() => {
      const g = globalThis as unknown as FeedWin;
      g.__feedPush({ t: "events", events: [{ epoch: "e1", seq: 1, at: 1, body: { type: "WorkerRenamed", workerId: "%1", name: "alpha-2" } }] });
      g.__feedAnswersPings = false;
    });
    await tab.locator("button.row", { hasText: "alpha-2" }).first().waitFor();
    await tab.clock.fastForward(25_100);                               // the ping goes out (fastForward fires each due timer
    await tab.clock.fastForward(10_100);                               // once, so the pong deadline needs its own jump)
    await tab.waitForFunction(() => (globalThis as unknown as FeedWin).__feedOpened === 2, undefined, { timeout: 5000 });
    const hellos = await tab.evaluate(() => (globalThis as unknown as FeedWin).__feedSent.filter(m => (m as { t: string }).t === "hello"));
    expect(hellos.at(-1)).toEqual({ t: "hello", epoch: "e1", cursor: 1, layout: "desk" });
    expect(errors).toEqual([]);
  });
  it("a handshake refused because the device was signed out ends with Signed out, not Reconnecting forever", { timeout: 30_000 }, async () => {
    await tab.evaluate(() => {
      const g = globalThis as unknown as FeedWin;
      g.__feedRefuses = true;
      g.__signedOut = true;
      g.__feedClose(1006);                                             // the network drops; the reconnect is refused
    });
    await tab.clock.fastForward(2000);
    await tab.locator(".conn", { hasText: "Signed out" }).first().waitFor({ timeout: 5000 });
    const opened = await tab.evaluate(() => (globalThis as unknown as FeedWin).__feedOpened);
    await tab.clock.fastForward(120_000);
    expect(await tab.evaluate(() => (globalThis as unknown as FeedWin).__feedOpened)).toBe(opened);   // no more retries
    expect(await status()).toContain("Signed out");
  });
});
