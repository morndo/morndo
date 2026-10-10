// Validation of review finding #4 (range 4272ccc..84e2b42): a task he kept for later on Today (its row's Later, quick.ts)
// is "off today: never waiting, never the headline" (horizon.ts; ADR-0009, readability pass: "Later on a task keeps it
// under 'Kept for later today' on this device until midnight"). The end of catch-up (CaughtUp, via CatchUp's horizon()
// call) must agree with Today. Real Today and CatchUp components sharing one feed, one session and one QuickAnswers, as
// Phone.svelte wires them; the hub is faked at the browser's edge (harness.ts). Synthetic data only.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="today"></div><div id="cu"></div><script type="module">
  import { mount } from "svelte";
  import { LiveFeed } from "/src/lib/feed.svelte.ts";
  import { CatchUpSession } from "/src/lib/catchup/session.svelte.ts";
  import { QuickAnswers } from "/src/lib/phone/quick.svelte.ts";
  import Today from "/src/lib/phone/Today.svelte";
  import CatchUp from "/src/lib/phone/CatchUp.svelte";
  const feed = new LiveFeed();
  const session = new CatchUpSession({ feed, answer: async () => ({ ok: true }) });
  const quick = new QuickAnswers(async () => ({ ok: true }));
  feed.start(); session.start(); quick.start();
  globalThis.__openCatchUp = () => session.open({});
  const noop = () => {};
  mount(Today, { target: document.getElementById("today"), props: { feed, session, quick, verifiedFresh: true, verify: async () => true, onCatchUp: noop, onDecide: noop } });
  // quick is passed as Today gets it, so a fix that hands CatchUp the same QuickAnswers is exercised as wired.
  mount(CatchUp, { target: document.getElementById("cu"), props: { feed, session, quick, outgoing: [], verifiedFresh: true, verify: async () => true,
    onBack: noop, onDay: noop, onQueue: async () => {}, onRetry: noop, onDiscard: noop, onEchoes: noop, onScreen: noop } });
</script></body></html>`;

const task = (id: string, title: string, deadline: number) => ({
  id, asker: { kind: "manager", name: "manager", workerId: "%0" }, need: "time", title, context: null, contextKind: "markdown",
  options: [], answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline, blocking: false, project: null, askedAt: Date.now() - 3_600_000,
  messageId: null, tracking: "ledger", status: "open", source: "open", decision: null, resolution: null, settledAt: null, askedAgain: false,
  answerable: null, version: `${id}-v1`,
});

let web: Web;
let tab: Page;
let errors: string[];
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });
beforeEach(async () => {
  tab = await web.browser.newPage({ viewport: { width: 390, height: 844 } });
  errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }] });
  await tab.goto(web.url);
  await tab.locator("#today .conn.live").waitFor({ timeout: 15_000 });
}, 60_000);
afterEach(async () => { await tab.close(); });

const push = (m: unknown) => tab.evaluate(x => (globalThis as unknown as FeedWin).__feedPush(x), m);

// He taps Later on the task's row on Today, then catch-up opens and ends (a task is no card, so the run is empty).
async function keepThenCatchUp(id: string, title: string, deadline: number) {
  await push({ t: "decisions", items: [task(id, title, deadline)], ledger: { configured: true, ok: true, at: Date.now() } });
  const row = tab.locator(`#today li[data-row="d:${id}"]`);
  await row.getByRole("button", { name: "Later", exact: true }).click();
  await row.getByRole("button", { name: "Bring back" }).waitFor({ timeout: 5000 });
  await tab.locator("#today li.sect", { hasText: "Kept for later today" }).waitFor({ timeout: 5000 });
  await tab.evaluate(() => (globalThis as unknown as { __openCatchUp: () => void }).__openCatchUp());
  await tab.locator("#cu h2", { hasText: "You're caught up." }).waitFor({ timeout: 5000 });
}

describe("finding #4: catch-up's end screen and Today agree on a task kept for later", () => {
  it("an overdue task kept for later: Today says nothing waits, so the end screen doesn't say a decision waits", { timeout: 30_000 }, async () => {
    await keepThenCatchUp("t-over", "Sign the synthetic form", Date.now() - 3_600_000);
    const today = (await tab.locator("#today .hero").innerText()).replace(/\s+/g, " ");
    const end = (await tab.locator("#cu .next").innerText()).replace(/\s+/g, " ");
    console.log(`[val-f04] Today hero: ${today}\n[val-f04] CaughtUp next: ${end}`);
    expect(today).not.toContain("waiting now");                                 // Today: kept, off today, not waiting
    expect(end).not.toMatch(/Still waiting|decisions? waits?/);                  // the end screen must agree
    expect(errors).toEqual([]);
  });
  it("a task kept for later with a time still to come: Today doesn't make it the headline, nor does the end screen", { timeout: 30_000 }, async () => {
    const soon = Date.now() + 2 * 3_600_000;
    await keepThenCatchUp("t-soon", "Call the synthetic office", soon);
    const today = (await tab.locator("#today .hero").innerText()).replace(/\s+/g, " ");
    const end = (await tab.locator("#cu .next").innerText()).replace(/\s+/g, " ");
    console.log(`[val-f04] Today hero: ${today}\n[val-f04] CaughtUp next: ${end}`);
    expect(today).not.toContain("Call the synthetic office");                   // Today: never the headline
    expect(end).not.toContain("Call the synthetic office");                     // the end screen must agree
    expect(errors).toEqual([]);
  });
});
