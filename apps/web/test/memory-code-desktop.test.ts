// The console's one-time code on a memory Ask's card (ADR-0031 round 3, docs/design/memory/README.md "App"): the button
// on the Ask's own card and nowhere else, the code shown once with its expiry and the exact command, and gone when it is
// closed, when it runs out, or when the note is decided — never stored anywhere the page keeps. The real DecisionsPanel
// through BriefHarness, in headless Chromium. Synthetic data only.
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const CODE = "K7M2-9QPX-4TWB";
const CODE2 = "VR72-M4XK-9QTB";
const COMMAND = "morndo memory approve N-12";

type Item = Record<string, unknown>;

// The Ask a pending Note files (memory-asks.ts shape): id mem-n-12 from the note N-12, asker "memory", held open by
// the hub (tracking "hub"), Approve and Reject under a tap.
const memory = (over: Item = {}): Item => ({
  id: "mem-n-12", asker: { kind: "worker", name: "memory", workerId: null }, need: "decision",
  title: 'Approve the procedure "Deploy the api" for repo:shop-api?', shortTitle: null, summary: null, minutes: null,
  link: null, details: null, context: "Written by lane:api-fix (tier 3)\n\n1. Tag.", contextKind: "markdown",
  options: [
    { key: "approve", label: "Approve", detail: "It reaches every lane's skills at the next sync" },
    { key: "reject", label: "Reject", detail: "The note is invalidated and reaches no lane" },
  ],
  answerBy: "tap", recommendation: null,
  ifNoAnswer: "The note stays out of every lane's skills until you approve it.",
  deadline: null, blocking: false, project: null,
  askedAt: NOW - 3_600_000, messageId: null, tracking: "hub", status: "open", source: "open",
  decision: null, resolution: null, settledAt: null, askedAgain: false, answerable: null,
  version: "v1", brief: null, briefVersion: 0, draftedBy: null, notice: null,
  ...over,
});

// A plain manager ask, for the card that must not have the button.
const plain: Item = {
  id: "d-1", asker: { kind: "manager", name: "Manager", workerId: "w-manager" }, need: "decision",
  title: "Ship the weekly notes", shortTitle: "Weekly notes", summary: "Ship the weekly notes", minutes: null,
  link: null, details: null, context: null, contextKind: "markdown",
  options: [{ key: "b", label: "Ship it", detail: null }, { key: "a", label: "Hold", detail: null }],
  answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null,
  askedAt: NOW - 3_600_000, messageId: null, tracking: "hub", status: "open", source: "open",
  decision: null, resolution: null, settledAt: null, askedAgain: false, answerable: null,
  version: "v1", brief: null, briefVersion: 0, draftedBy: null, notice: null,
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script type="module">
  import "@morndo/brand/tokens.css";
  import "/src/lib/desktop/desk-tokens.css";
  import { mount } from "svelte";
  import Harness from "/test/BriefHarness.svelte";
  mount(Harness, { target: document.body, props: { initial: [], now: ${NOW} } });
</script></body></html>`;

let web: Web;
let tab: Page;
let errors: string[];
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });

async function ready() {
  tab = await (await web.browser.newContext()).newPage();
  errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.goto(web.url);
  await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
}
const show = (items: Item[]) => tab.evaluate(n => (globalThis as unknown as { __setItems: (x: unknown) => void }).__setItems(n), items);
const setNow = (n: number) => tab.evaluate(t => (globalThis as unknown as { __setNow: (x: number) => void }).__setNow(t), n);
const asksSoFar = () => tab.evaluate(() => [...(globalThis as unknown as { __memoryCodeCalls?: string[] }).__memoryCodeCalls ?? []]);
// What the card's next mint answers, in place of the harness's own fake.
const mint = (outcome: unknown) => tab.evaluate(o => { (globalThis as { __memoryCode?: (id: string) => unknown }).__memoryCode = () => o; }, outcome);

// The code appears nowhere the page holds: neither shown nor in its HTML, nor in either store.
async function nowhere(needle: string) {
  const page = await tab.evaluate(() => ({ text: document.body.innerText, html: document.body.outerHTML }));
  expect(page.text.includes(needle), "body text").toBe(false);
  expect(page.html.includes(needle), "body html").toBe(false);
  const stored = await tab.evaluate(s => {
    let found = false;
    for (const st of [localStorage, sessionStorage]) {
      for (let i = 0; i < st.length; i++) {
        const k = st.key(i) ?? "";
        if (k.includes(s) || (st.getItem(k) ?? "").includes(s)) found = true;
      }
    }
    return found;
  }, needle);
  expect(stored, "storage").toBe(false);
}

describe("the console code on a memory Ask's card", () => {
  it("a memory Ask's card has a Console code button; another card does not", async () => {
    await ready();
    await show([memory(), plain]);
    await tab.locator('[data-decision="mem-n-12"]').waitFor();
    expect(await tab.locator('[data-decision="mem-n-12"] [data-memory-code-ask]').count()).toBe(1);
    expect(await tab.locator('[data-decision="d-1"] [data-memory-code-ask]').count()).toBe(0);
    expect(errors).toEqual([]);
  }, 60_000);

  it("the button asks for the note's code once and shows it with its expiry and the exact console command", async () => {
    await ready();
    await show([memory()]);
    const card = tab.locator('[data-decision="mem-n-12"]');
    await card.getByRole("button", { name: "Console code…" }).click();
    expect(await asksSoFar()).toEqual(["N-12"]);                 // the note's own id, not the Ask's
    await card.locator("[data-memory-code]").waitFor();
    expect(await card.locator("[data-memory-code]").textContent()).toBe(CODE);
    await card.getByText("Valid for 10 min").waitFor();
    expect(await card.locator("[data-memory-command]").textContent()).toBe(COMMAND);
    expect(await card.locator("[data-memory-code-ask]").count()).toBe(0);   // shown: nothing to ask for
    expect(errors).toEqual([]);
  }, 60_000);

  it("closing the code removes it, and it is never shown again: asking again gets a new one", async () => {
    await ready();
    await show([memory()]);
    const card = tab.locator('[data-decision="mem-n-12"]');
    await card.getByRole("button", { name: "Console code…" }).click();
    await card.locator("[data-memory-code]").waitFor();
    await card.getByRole("button", { name: "Close" }).click();
    await card.locator("[data-memory-reveal]").waitFor({ state: "detached" });
    await nowhere(CODE);
    await mint({ ok: true, code: CODE2, expiresAt: NOW + 600_000 });
    await card.getByRole("button", { name: "Console code…" }).click();   // a new ask, not the old code back
    expect(await asksSoFar()).toEqual(["N-12", "N-12"]);
    await card.locator("[data-memory-code]").waitFor();
    expect(await card.locator("[data-memory-code]").textContent()).toBe(CODE2);
    expect(errors).toEqual([]);
  }, 60_000);

  it("an expired code disappears by itself", async () => {
    await ready();
    await show([memory()]);
    const card = tab.locator('[data-decision="mem-n-12"]');
    await card.getByRole("button", { name: "Console code…" }).click();
    await card.locator("[data-memory-code]").waitFor();
    await setNow(NOW + 600_001);                                  // past expiresAt: the ten minutes are up
    await card.locator("[data-memory-reveal]").waitFor({ state: "detached" });
    await card.getByText("The code expired. Ask for a new one.").waitFor();
    await nowhere(CODE);
    expect(await card.getByRole("button", { name: "Console code…" }).count()).toBe(1);
    expect(errors).toEqual([]);
  }, 60_000);

  it("an expired code is dropped from the card's state, not only hidden: the clock going back does not bring it back", async () => {
    await ready();
    await show([memory()]);
    const card = tab.locator('[data-decision="mem-n-12"]');
    await card.getByRole("button", { name: "Console code…" }).click();
    await card.locator("[data-memory-code]").waitFor();
    await setNow(NOW + 600_001);
    await card.getByText("The code expired. Ask for a new one.").waitFor();
    await setNow(NOW);                                            // a device clock set back: before expiresAt again
    await card.getByText("The code expired. Ask for a new one.").waitFor();
    expect(await card.locator("[data-memory-code]").count()).toBe(0);
    await nowhere(CODE);
    expect(errors).toEqual([]);
  }, 60_000);

  it("a refusal is said in words and shows no code", async () => {
    await ready();
    await mint({ ok: false, text: "Verify with your passkey first, then ask again." });
    await show([memory()]);
    const card = tab.locator('[data-decision="mem-n-12"]');
    await card.getByRole("button", { name: "Console code…" }).click();
    await card.getByRole("alert").filter({ hasText: "Verify with your passkey first, then ask again." }).waitFor();
    expect(await card.locator("[data-memory-code]").count()).toBe(0);
    expect(await asksSoFar()).toEqual(["N-12"]);
    expect(errors).toEqual([]);
  }, 60_000);

  it("the code is not on the card once the note is decided", async () => {
    await ready();
    await show([memory()]);
    const card = tab.locator('[data-decision="mem-n-12"]');
    await card.getByRole("button", { name: "Console code…" }).click();
    await card.locator("[data-memory-code]").waitFor();
    await show([memory({
      status: "answered",
      decision: { choice: { kind: "option", key: "approve", label: "Approve" }, at: NOW, via: "here", endpointId: null, sessionId: null },
    })]);
    await card.locator("[data-memory-reveal]").waitFor({ state: "detached" });
    await nowhere(CODE);
    expect(errors).toEqual([]);
  }, 60_000);
});
