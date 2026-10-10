// Validator for review finding #9 (range 4272ccc..84e2b42): Today's hero counts every "Anytime" row that needs him as
// a task, so a decision he kept for later in catch-up (non-blocking, no deadline) reads as "1 task you can do anytime".
// ADR-0009 Copy: "with nothing urgent it counts the tasks he can do anytime"; docs/domain.md: `tap` is a decision,
// `time` is a task. Mounts the real Today.svelte with plain props; synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Today from "/src/lib/phone/Today.svelte";
  const now = Date.now();
  const item = (id, o = {}) => ({
    id, asker: { kind: "manager", name: "Manager", workerId: "%1" }, need: "decision", title: "Question " + id, shortTitle: null,
    context: null, contextKind: "markdown", options: [], answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: null,
    blocking: false, project: null, askedAt: now - 60000, messageId: null, tracking: "ledger", status: "open", source: "open",
    decision: null, resolution: null, settledAt: null, askedAgain: false, answerable: null, version: "v1", ...o,
  });
  const cases = {
    // The finding's scenario: the only open item is a non-blocking decision without a deadline, kept for later.
    kept: { decisions: [item("pick", { title: "Pick the colour" })], later: { pick: "v1" } },
    // Control: a real task without a time.
    task: { decisions: [item("call", { need: "time", title: "Call the accountant" })], later: {} },
    // The "Then:" branch: a task later today, plus the kept decision without a deadline.
    then: { decisions: [item("pick", { title: "Pick the colour" }), item("slot", { need: "time", title: "Sign the form", deadline: now + 3 * 3600000 })], later: { pick: "v1" } },
  };
  const c = cases[new URLSearchParams(location.search).get("case")];
  const feed = { primed: true, status: "live", caughtUpAt: null, decisions: c.decisions, workers: [] };
  const session = { later: c.later, cards: [], count: 0 };
  const quick = { state: { pending: {}, sent: {}, failed: {}, later: {} }, now, answer() {}, back() {}, later() {}, retry() {}, undo() {} };
  mount(Today, { target: document.body, props: { feed, session, quick, verifiedFresh: true, verify: async () => true, onCatchUp() {}, onDecide() {} } });
</script></body></html>`;

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); });
afterAll(async () => { await web?.close(); });

async function hero(c: string): Promise<{ kicker: string; say: string; kinds: string[]; page: Page }> {
  const page = await web.browser.newPage();
  await page.goto(`${web.url}?case=${c}`);
  await page.locator(".hero .kicker").waitFor();
  return {
    kicker: (await page.locator(".hero .kicker").innerText()).trim(),
    say: (await page.locator(".hero .say").innerText()).trim(),
    kinds: await page.locator("li.ev").evaluateAll(els => els.map(e => `${e.getAttribute("data-row")}:${e.getAttribute("data-kind")}`)),
    page,
  };
}

describe("finding #9: the hero's anytime count names decisions as tasks", () => {
  it("control: a task without a time is counted as a task", async () => {
    const h = await hero("task");
    expect(h.kicker).toBe("Nothing urgent");
    expect(h.say).toContain("1 task you can do anytime");
    await h.page.close();
  });

  it("a decision kept for later (non-blocking, no deadline) is not called a task", async () => {
    const h = await hero("kept");
    expect(h.kicker).toBe("Nothing urgent");                      // setup: nothing waits now
    expect(h.kinds).toEqual(["d:pick:decision"]);                 // setup: its row is a decision, under Anytime
    console.log("hero says:", JSON.stringify(h.say));
    expect(h.say).not.toMatch(/\btasks?\b/);
    await h.page.close();
  });

  it("with a later task as the headline, the kept decision is not counted as a task either", async () => {
    const h = await hero("then");
    expect(h.kicker).toBe("Nothing needs you until");
    console.log("hero says:", JSON.stringify(h.say));
    expect(h.say).not.toMatch(/\btasks? you can do anytime\b/);
    await h.page.close();
  });
});
