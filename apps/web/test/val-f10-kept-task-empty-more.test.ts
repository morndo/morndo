// Validation of review finding #10: a task kept for later with nothing behind More (no long text, details, link, default
// or recommendation) still gets a More button, because hasMore counts the own-words action that the kept branch hides.
// More must either be absent on such a row or open onto something. A control row (the same task, not kept) shows the
// own-words button behind More, so the harness and the toggle are known to work. Synthetic items only.
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Today from "/src/lib/phone/Today.svelte";
  import { QuickAnswers } from "/src/lib/phone/quick.svelte.ts";
  const NOW = Date.now();
  const task = (id, title) => ({
    id, asker: { kind: "manager", name: "Manager", workerId: "%0" }, need: "time", title,
    shortTitle: null, summary: null, minutes: null, link: null, details: null, context: null, contextKind: "markdown",
    options: [], answerBy: "words", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null,
    askedAt: NOW - 60_000, messageId: null, tracking: "ledger", status: "open", source: "open", decision: null, resolution: null,
    settledAt: null, askedAgain: false, answerable: null, version: "v1",
  });
  const kept = task("t-kept", "Sign the lease");
  const open = task("t-open", "Water the plants");
  try { localStorage.clear(); } catch {}
  const quick = new QuickAnswers(async () => ({ ok: true }));
  quick.later(kept.id, kept.version);
  mount(Today, { target: document.body, props: {
    feed: { decisions: [kept, open], workers: [], status: "live", primed: true, caughtUpAt: null },
    session: { later: {}, cards: [], count: 0 },
    quick, verifiedFresh: true, verify: async () => true, onCatchUp: () => {}, onDecide: () => {},
  } });
</script></body></html>`;

let web: Web;
let page: Page;
beforeAll(async () => {
  web = await startWeb(PAGE);
  page = await web.browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(web.url);
  await page.locator('[data-row="d:t-open"]').waitFor();
}, 60_000);
afterAll(async () => { await web?.close(); });

describe("finding #10: More on a kept task with nothing behind it", () => {
  it("control: the same task, not kept, opens More onto the own-words button", async () => {
    const row = page.locator('[data-row="d:t-open"]');
    await row.getByRole("button", { name: "More" }).click();
    await expect(row.locator(".more").getByRole("button", { name: "Answer in my own words" }).count()).resolves.toBe(1);
  });

  it("the kept task sits under 'Kept for later today' with Bring back, and More is absent or opens onto something", async () => {
    const row = page.locator('[data-row="d:t-kept"]');
    await expect(page.getByText("Kept for later today").count()).resolves.toBe(1);
    await expect(row.getByRole("button", { name: "Bring back" }).count()).resolves.toBe(1);
    const moreBtn = row.getByRole("button", { name: "More" });
    if ((await moreBtn.count()) === 0) return;              // fixed by hiding More: nothing to open
    await moreBtn.click();
    const panel = row.locator(".more");
    const content = { text: (await panel.innerText()).trim(), children: await panel.locator(":scope > *").count() };
    expect(content, "More opened an empty panel on a kept task").not.toEqual({ text: "", children: 0 });
  });
});
