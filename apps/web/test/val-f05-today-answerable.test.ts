// Validation of review finding 5 (range 4272ccc..84e2b42): a task's row on Today offers Done (and starts the 5-second
// window) for an item the hub already marks as not answerable (`answerable: "cant_check"`, the manager's list can't be
// read: E10), while the phone's DecisionCard disables answering and says why. The real Today.svelte with the real
// QuickAnswers in headless Chromium; the feed and session are plain objects, the answer path a fake that refuses as the
// hub does. Synthetic data only.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const PAUSED = "The manager's list can't be read right now, so answers are paused. Try again in a moment.";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Today from "/src/lib/phone/Today.svelte";
  import { QuickAnswers } from "/src/lib/phone/quick.svelte.ts";
  import { REFUSALS } from "/src/lib/desktop/decisions.ts";
  const task = (id, title, o) => ({
    id, asker: { kind: "manager", name: "Manager", workerId: null }, need: "time", title, shortTitle: null, summary: null,
    minutes: 10, link: null, details: null, context: null, contextKind: "markdown", options: [], answerBy: "words",
    recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null, askedAt: Date.now() - 60000,
    messageId: null, tracking: "ledger", status: "open", source: "open", decision: null, resolution: null, settledAt: null,
    askedAgain: false, answerable: null, version: "v-" + id, ...o,
  });
  const decisions = [
    task("ny-paused", "Paused task to sign", { source: "unreadable", answerable: "cant_check" }),
    task("ny-open", "Open task to sign", {}),
  ];
  window.__answers = [];
  // As postAnswer gives it when the hub answers 409 cant_check (catchup/answer.ts).
  const quick = new QuickAnswers(async (id, body) => { window.__answers.push({ id, body }); return { ok: false, code: "cant_check", text: REFUSALS.cant_check }; });
  quick.start();
  const feed = { decisions, workers: [], status: "live", primed: true, caughtUpAt: null };
  const session = { later: {}, cards: [], count: 0 };
  mount(Today, { target: document.body, props: { feed, session, quick, verifiedFresh: true, verify: async () => true, onCatchUp: () => {}, onDecide: () => {} } });
</script></body></html>`;

let web: Web;
let tab: Page;
let errors: string[];
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });
afterEach(async () => { await tab.context().close(); });

async function open() {
  const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
  tab = await context.newPage();
  errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.goto(web.url);
  await tab.locator('li[data-row="d:ny-open"]').waitFor({ timeout: 15_000 });
}
const row = (id: string) => tab.locator(`li[data-row="d:${id}"]`);
const enabledDone = (id: string) => row(id).locator("button:not([disabled])", { hasText: /^Done$/ });

describe("finding 5: a task row and the hub's answerable", () => {
  it("control: an answerable task row offers an enabled Done", { timeout: 30_000 }, async () => {
    await open();
    expect(await enabledDone("ny-open").count()).toBe(1);
    expect(errors).toEqual([]);
  });

  it("a task the hub refuses answers for (cant_check) says answers are paused and offers no enabled Done", { timeout: 30_000 }, async () => {
    await open();
    const text = await row("ny-paused").innerText();
    const done = await enabledDone("ny-paused").count();
    expect({ saysPaused: text.includes(PAUSED), enabledDone: done }, `row text: ${JSON.stringify(text)}`).toEqual({ saysPaused: true, enabledDone: 0 });
    expect(errors).toEqual([]);
  });

  it("tapping a paused task's Done never starts a 5-second window the hub will refuse", { timeout: 30_000 }, async () => {
    await open();
    if (await enabledDone("ny-paused").count()) {
      await enabledDone("ny-paused").click();
      const during = await row("ny-paused").innerText();
      await row("ny-paused").getByText(PAUSED).waitFor({ timeout: 10_000 });
      const after = await row("ny-paused").innerText();
      const sent = await tab.evaluate(() => (globalThis as unknown as { __answers: unknown[] }).__answers);
      expect(during, `after the window: ${JSON.stringify(after)}; posted: ${JSON.stringify(sent)}`).not.toMatch(/goes in \d+ s/);
    }
    expect(errors).toEqual([]);
  });
});
