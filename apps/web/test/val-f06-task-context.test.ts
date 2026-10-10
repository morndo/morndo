// Validation of review finding #6 (Today.svelte, a task's More): a ledger item of kind "time" that the manager also posted
// buttons for is now a task (escalation-service.ts: "The list's kind decides"), so it shows only as a Today row. The
// message that asked it (`context`, the button message's body) was behind "Read why it asks" on the decision card before;
// a task's More must still show it. The real Today.svelte, compiled by Vite's Svelte plugin, in headless Chromium, with
// plain props standing in for the feed, the catch-up session and the quick answers. Synthetic data only.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const NOW = Date.now();
const MESSAGE = "Your hands are needed for the contract. The venue holds the date only until Friday noon.";
const task = {
  id: "ny-9", asker: { kind: "manager", name: "Manager", workerId: "%0" }, need: "time",
  title: "Sign the venue contract: print it, sign page 4 and send it back",
  shortTitle: null, summary: null, minutes: null, link: null, details: null,
  context: MESSAGE, contextKind: "markdown",
  options: [{ key: "now", label: "Doing it now", detail: null }, { key: "later", label: "Later today", detail: null }],
  answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null, askedAt: NOW - 60_000,
  messageId: "m2", tracking: "ledger", status: "open", source: "open", decision: null, resolution: null, settledAt: null, askedAgain: false,
  answerable: null, version: "v1",
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Today from "/src/lib/phone/Today.svelte";
  const item = ${JSON.stringify(task)};
  const feed = { decisions: [item], workers: [], status: "live", primed: true, caughtUpAt: null };
  const session = { later: {}, cards: [], count: 0 };
  const quick = { state: { pending: {}, sent: {}, failed: {}, later: {} }, now: Date.now(), answer() {}, undo() {}, retry() {}, later() {}, back() {} };
  mount(Today, { target: document.body, props: { feed, session, quick, verifiedFresh: true, verify: async () => true, onCatchUp() {}, onDecide() {} } });
  window.__ready = true;
</script></body></html>`;

let web: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });
afterEach(async () => { await tab.context().close(); });

describe("a task the manager posted buttons for (finding #6)", () => {
  it("shows the manager's message behind the task's More", async () => {
    tab = await (await web.browser.newContext()).newPage();
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as unknown as { __ready?: boolean }).__ready === true);
    const row = tab.locator('[data-row="d:ny-9"]');
    await row.waitFor();
    expect(await row.getAttribute("data-kind")).toBe("task");                         // a task row, not a decision
    await row.getByRole("button", { name: "More" }).click();
    const more = row.locator(".more");
    await more.waitFor();
    // Control: More opened and shows the long text the title left out.
    expect(await more.innerText()).toContain("print it, sign page 4 and send it back");
    // The finding: the message that asked it is nowhere in the task's More.
    expect(await more.innerText(), "the manager's button message (context) behind More").toContain("The venue holds the date only until Friday noon.");
  }, 60_000);
});
