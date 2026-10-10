// A worker's folder that changes (fleet core §3.1, §7): one first listed without it (its node offline at the hub's start)
// shows it once WorkerMoved comes, live, without a resync. The real Desktop in headless Chromium, the hub faked at the
// browser's edge (harness.ts). Synthetic workers.
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

let web: Web;
beforeAll(async () => { web = await startWeb(); }, 60_000);
afterAll(async () => { await web?.close(); });

it("the open worker's folder chip follows WorkerMoved, with no new hello", { timeout: 30_000 }, async () => {
  const tab = await web.browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors: string[] = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }] });
  await tab.goto(web.url);
  await tab.locator("aside.side button.row", { hasText: "alpha" }).first().click();
  await tab.locator(".loc", { hasText: "/work/alpha" }).waitFor({ timeout: 5000 });
  await tab.evaluate(x => (globalThis as unknown as FeedWin).__feedPush(x),
    { t: "events", events: [{ epoch: "e1", seq: 1, at: 1, body: { type: "WorkerMoved", workerId: "%1", location: "proj" } }] });
  await tab.locator(".loc", { hasText: "proj" }).waitFor({ timeout: 5000 });
  expect(await tab.evaluate(() => (globalThis as unknown as FeedWin).__feedSent.filter(m => (m as { t: string }).t === "hello").length)).toBe(1);
  expect(errors).toEqual([]);
  await tab.close();
});
