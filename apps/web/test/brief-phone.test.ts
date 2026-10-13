// The phone's decision brief (ADR-0023 §6.3): the sheet, the per-factor comparison, the 48px footer,
// and the compact card on catch-up and Today. Synthetic data only.
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DecisionBrief } from "@morndo/domain";
import type { DecisionItem } from "../src/lib/desktop/decisions.ts";
import { startWeb, type Web } from "./harness.ts";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const DUE = Date.parse("2026-12-01T16:00:00Z");

const spendBrief = (): DecisionBrief => ({
  topic: "Support inbox triage",
  due: DUE,
  minutes: 4,
  headline: "Approve option B: extend the in-house triage script",
  recommend: "b",
  ask: { text: "Approve contractor time.", alternative: "Buy the hosted add-on.", uncertainty: "The sample covers two weeks." },
  whyNow: "- The contractor's slot ends soon.",
  options: [
    { key: "a", label: "Keep manual triage" },
    { key: "b", label: "Extend the triage script" },
    { key: "c", label: "Buy a hosted add-on" },
  ],
  comparison: {
    rows: [{ factor: "Year-one cost", cells: ["$0", "$2,400", "$2,160"] }],
    note: "Costs are cash only.",
  },
  why: { text: "B keeps ticket text in-house.", assumptions: ["The quote is a fixed price."], downside: "If the saving is small, switch at the review." },
  changeIf: "If fewer than 60% of tickets are tagged, choose C.",
  risk: { risk: "An urgent ticket goes to the wrong queue.", control: "A person checks every urgent ticket for two weeks." },
  authorizes: { limits: ["The contractor's quote, at a fixed price."], freshApproval: "Any further spend.", reviewPoint: "The next review, on tagging accuracy." },
  ifNoAnswer: "The slot lapses and manual triage continues.",
  evidence: [{ label: "Two-week sample", url: "https://example.com/triage-sample" }],
  blocking: true, project: "support", task: null, ref: null,
});

const freeBrief = (): DecisionBrief => ({
  ...spendBrief(),
  topic: "Release timing",
  headline: "Approve option A: ship the release candidate today",
  recommend: "a",
  options: [
    { key: "a", label: "Ship today" },
    { key: "b", label: "Wait for Monday" },
  ],
  comparison: { rows: [{ factor: "When it ships", cells: ["today", "Monday"] }], note: "No money in this one." },
});

const item = (id: string, over: Partial<DecisionItem>): DecisionItem => ({
  id: id as DecisionItem["id"],
  asker: { kind: "manager", name: "Manager", workerId: "w-manager" },
  need: "decision",
  title: "Approve option B: extend the in-house triage script",
  shortTitle: "Support inbox triage",
  summary: "Approve option B: extend the in-house triage script",
  minutes: 4,
  link: null,
  details: null,
  context: null,
  contextKind: "markdown",
  options: [
    { key: "b", label: "Extend the triage script", detail: null },
    { key: "a", label: "Keep manual triage", detail: null },
    { key: "c", label: "Buy a hosted add-on", detail: null },
  ],
  answerBy: "tap",
  recommendation: "Extend the triage script",
  ifNoAnswer: "The slot lapses.",
  deadline: DUE,
  blocking: true,
  project: "support",
  askedAt: NOW - 3_600_000,
  messageId: null,
  tracking: "hub",
  status: "open",
  source: "open",
  decision: null,
  resolution: null,
  settledAt: null,
  askedAgain: false,
  answerable: null,
  version: "v1",
  brief: spendBrief(),
  briefVersion: 1,
  draftedBy: null,
  ...over,
});

const spend = item("d-1", {});
const free = item("d-2", {
  brief: freeBrief(),
  title: "Approve option A: ship the release candidate today",
  shortTitle: "Release timing",
  summary: "Approve option A: ship the release candidate today",
  options: [
    { key: "a", label: "Ship today", detail: null },
    { key: "b", label: "Wait for Monday", detail: null },
  ],
  recommendation: "Ship today",
});
const plain = item("ny-400", {
  brief: null,
  briefVersion: 0,
  title: "Pick the weekday for the newsletter",
  shortTitle: "Newsletter send day",
  summary: "Pick the weekday for the newsletter",
  options: [
    { key: "tue", label: "Tuesday", detail: null },
    { key: "thu", label: "Thursday", detail: null },
  ],
  recommendation: "Tuesday",
});
// A brief-backed card the hub would refuse an answer for (its list can't be read). A free brief, so it has quick
// answers to disable (a spend brief is read first).
const refused = item("d-3", {
  answerable: "cant_check",
  brief: freeBrief(),
  title: "Approve option A: ship the release candidate today",
  shortTitle: "Release timing",
  summary: "Approve option A: ship the release candidate today",
  options: [
    { key: "a", label: "Ship today", detail: null },
    { key: "b", label: "Wait for Monday", detail: null },
  ],
  recommendation: "Ship today",
});
// Answered here, delivered: the footer says where the answer stands.
const answeredHere = item("d-4", {
  status: "answered",
  decision: { choice: { kind: "option", key: "b", label: "Extend the triage script" }, at: NOW - 1_000, via: "here", endpointId: null, sessionId: null, delivery: { state: "delivered", at: NOW - 500 } },
});
// The same answer given on another device.
const answeredElsewhere = item("d-5", {
  status: "answered",
  decision: { choice: { kind: "option", key: "b", label: "Extend the triage script" }, at: NOW - 1_000, via: "elsewhere", endpointId: null, sessionId: null },
});
// Closed without him: the sheet says it is no longer open.
const settled = item("d-6", { status: "settled", settledAt: NOW - 1_000, resolution: null });
// A plain ask with no options and no brief: the footer's only way in is his own words.
const wordsOnly = item("ny-401", {
  brief: null, briefVersion: 0, options: [], answerBy: "words", recommendation: null,
  title: "Name the release", shortTitle: "Release name", summary: "Name the release",
});
// A brief that keeps the asker's own message and the list's link (a new version, so the session takes it as its own).
const withAsker = item("d-7", { version: "v2", context: "The manager's button said: **ship it**", contextKind: "markdown", link: "https://example.com/ledger-row" });

const noop = "() => {}";
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="phone" style="height:844px">
  <div id="sheet"></div>
  <div id="spend"></div>
  <div id="free"></div>
  <div id="plain"></div>
  <div id="refused"></div>
  <div id="today"></div>
</div>
<script type="module">
  import "@morndo/brand/tokens.css";
  import "/src/lib/phone/phone.css";
  import { mount } from "svelte";
  import SheetHarness from "/test/BriefSheetHarness.svelte";
  import DecisionCard from "/src/lib/phone/DecisionCard.svelte";
  import Today from "/src/lib/phone/Today.svelte";
  import { QuickAnswers } from "/src/lib/phone/quick.svelte.ts";
  const spend = ${JSON.stringify(spend)};
  const free = ${JSON.stringify(free)};
  const plain = ${JSON.stringify(plain)};
  const refused = ${JSON.stringify(refused)};
  mount(SheetHarness, { target: document.getElementById("sheet"), props: { initial: spend, now: ${NOW} } });
  const card = (id, item) => mount(DecisionCard, { target: document.getElementById(id), props: {
    item, primed: true, index: 1, of: 1, now: ${NOW}, answering: null, refusal: null, note: null,
    onPick: async () => false, onUndo: ${noop}, onVerifyAgain: ${noop}, onTryAgain: ${noop}, onScreen: ${noop}, onNext: ${noop},
    onOpenBrief() { window.__opened = item.id; },
  } });
  card("spend", spend);
  card("free", free);
  card("plain", plain);
  card("refused", refused);
  const quick = new QuickAnswers(async () => ({ ok: true }));
  const feed = { decisions: [spend, free, plain], workers: [], status: "live", primed: true, caughtUpAt: null };
  const catchup = { later: {}, cards: [], count: 0 };
  mount(Today, { target: document.getElementById("today"), props: {
    feed, session: catchup, quick, verifiedFresh: false, verify: async () => (globalThis.__passkeyOk !== false),
    onCatchUp: ${noop}, onDecide(id) { window.__decide = id; }, onReadBrief(id) { window.__read = id; },
  } });
  window.__ready = true;
</script></body></html>`;

let web: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });

describe("the phone brief sheet", () => {
  it("opens per factor, with a 48px footer, and Back is history", async () => {
    const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
    tab = await context.newPage();
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message));
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
    const dialog = tab.getByRole("dialog", { name: "Approve option B: extend the in-house triage script" });
    await dialog.waitFor();
    expect(await dialog.locator("table.compare").evaluate(el => getComputedStyle(el).display)).toBe("none");
    await dialog.getByRole("heading", { name: "Year-one cost" }).waitFor();
    await dialog.locator(".factors").getByText("Recommended").first().waitFor();
    await dialog.getByText("Costs are cash only.").waitFor();
    const heights = await dialog.locator("footer .act").evaluateAll(els => els.map(e => e.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThanOrEqual(2);
    expect(heights.every(h => h >= 48)).toBe(true);
    await dialog.getByRole("button", { name: "Other answers" }).click();
    await dialog.getByRole("heading", { name: "Decision", exact: true }).waitFor();
    await dialog.getByRole("button", { name: /Keep manual triage/ }).waitFor();
    await dialog.locator("footer").getByRole("button", { name: "Extend the triage script" }).click();
    const picks = await tab.evaluate(() => (globalThis as unknown as { __picks: { body: { key?: string }; label: string }[] }).__picks);
    expect(picks).toEqual([{ body: { key: "b" }, label: "Extend the triage script" }]);
    expect(await dialog.getByRole("button", { name: "Send answer" }).count()).toBe(0);
    await tab.evaluate(() => { (history as { back: () => void }).back = () => { (globalThis as { __back?: number }).__back = 1; }; });
    await dialog.getByRole("button", { name: "Back" }).click();
    expect(await tab.evaluate(() => (globalThis as { __back?: number }).__back)).toBe(1);
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);

  it("catch-up and Today use the compact card: spend is read first, a plain ask still decides now", async () => {
    const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
    tab = await context.newPage();
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
    await tab.evaluate(() => document.querySelector("dialog")?.close());
    const spendCard = tab.locator("#spend");
    await spendCard.getByText("Includes spend").waitFor();
    await spendCard.getByRole("button", { name: "Read the brief" }).waitFor();
    expect(await spendCard.getByRole("button", { name: "Extend the triage script" }).count()).toBe(0);
    const freeCard = tab.locator("#free");
    await freeCard.getByRole("button", { name: "Ship today" }).waitFor();
    await freeCard.getByRole("button", { name: "Read the brief" }).waitFor();
    const plainCard = tab.locator("#plain");
    await plainCard.getByRole("button", { name: "Answer in my own words" }).waitFor();
    expect(await plainCard.getByRole("button", { name: "Read the brief" }).count()).toBe(0);
    const today = tab.locator("#today");
    const spendRow = today.locator('li[data-row="d:d-1"]');
    await spendRow.getByRole("button", { name: "Read the brief" }).waitFor();
    expect(await spendRow.getByRole("button", { name: "Decide now" }).count()).toBe(0);
    expect(await spendRow.getByRole("button", { name: "Extend the triage script" }).count()).toBe(0);
    const freeRow = today.locator('li[data-row="d:d-2"]');
    await freeRow.getByRole("button", { name: "Ship today" }).waitFor();
    await freeRow.getByRole("button", { name: "Read the brief" }).waitFor();
    await today.locator('li[data-row="d:ny-400"]').getByRole("button", { name: "Decide now" }).waitFor();
    await context.close();
  }, 60_000);
});

// What the sheet and the cards say once an answer was refused, went through, or can't be given: the states review
// round 1 pinned for PR 4's phone sheet. Each test drives the harness's state from outside.
describe("the sheet and cards report what happened to an answer", () => {
  const setItem = (t: Page, v: DecisionItem) => t.evaluate(x => (globalThis as unknown as { __setItem: (i: DecisionItem) => void }).__setItem(x), v);
  const setRefusal = (t: Page, v: { key: string; code: string; text: string }) =>
    t.evaluate(x => (globalThis as unknown as { __setRefusal: (r: { key: string; code: string; text: string }) => void }).__setRefusal(x), v);
  const counts = (t: Page) => t.evaluate(() => (globalThis as unknown as { __counts: () => { verifyAgain: number; tryAgain: number } }).__counts());

  it("counts an answer down while the due line stays put", async () => {
    const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
    tab = await context.newPage();
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
    const dialog = tab.locator("dialog.sheet");
    await dialog.waitFor();
    const due = await dialog.locator(".meta").innerText();
    await tab.evaluate(() => {
      const g = globalThis as unknown as {
        __freezeClock?: boolean;
        __setClock: (t: number) => void;
        __setAnswering: (a: { label: string; sending: boolean; commitAt: number }) => void;
      };
      const t = Date.now();
      g.__freezeClock = true;
      g.__setClock(t);
      g.__setAnswering({ label: "Extend the triage script", sending: false, commitAt: t + 5_000 });
    });
    await dialog.getByText("Goes in 5 s.").waitFor({ timeout: 3_000 });
    await tab.waitForTimeout(1_300);
    const note = await dialog.locator("footer .note").innerText();
    expect(note === "Goes in 4 s." || note === "Goes in 3 s.").toBe(true);
    expect(await dialog.locator(".meta").innerText()).toBe(due);
    await context.close();
  }, 60_000);

  it("shows the session clock on the first answer after the sheet mounts", async () => {
    const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
    tab = await context.newPage();
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
    await tab.locator("dialog.sheet").waitFor();
    const first = await tab.evaluate(async () => {
      const orig = window.setInterval.bind(window);
      let started = 0;
      window.setInterval = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
        started += 1;
        return orig(fn, ms, ...rest);
      }) as typeof window.setInterval;
      (globalThis as unknown as { __setAnswering: (a: { label: string; sending: boolean; commitAt: number }) => void })
        .__setAnswering({ label: "Extend the triage script", sending: false, commitAt: Date.now() + 5_000 });
      await Promise.resolve();
      return { said: document.querySelector("dialog.sheet footer .note")?.textContent ?? "", started };
    });
    expect(first.said).toBe("Goes in 5 s.");
    expect(first.started).toBe(0);
    await context.close();
  }, 60_000);

  it("counts the answer window down from a live clock, not the sheet's mount time", async () => {
    const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
    tab = await context.newPage();
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
    await tab.locator("dialog.sheet").waitFor();
    await tab.waitForTimeout(1_200);                                   // the sheet has been open past a tick
    const said = await tab.evaluate(() => new Promise<string>(resolve => {
      (globalThis as unknown as { __setAnswering: (a: { label: string; sending: boolean; commitAt: number }) => void })
        .__setAnswering({ label: "Extend the triage script", sending: false, commitAt: Date.now() + 5_000 });
      requestAnimationFrame(() => resolve(document.querySelector("dialog.sheet footer .note")?.textContent ?? ""));
    }));
    expect(said).toBe("Goes in 5 s.");
    await context.close();
  }, 60_000);

  it("says a refused answer in the sheet, with the passkey retry and Try again", async () => {
    const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
    tab = await context.newPage();
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
    const dialog = tab.getByRole("dialog");                       // one sheet: the item swaps under it
    await dialog.waitFor();
    await setRefusal(tab, { key: "d:d-1", code: "step_up", text: "Not sent: confirm with your passkey, then it goes." });
    expect(await dialog.getByRole("alert").getByText("Not sent: confirm with your passkey, then it goes.").count()).toBe(1);
    const confirm = dialog.getByRole("button", { name: "Confirm with passkey and send" });
    expect(await confirm.count()).toBe(1);
    await confirm.click();
    expect((await counts(tab)).verifyAgain).toBe(1);
    await setRefusal(tab, { key: "d:d-1", code: "unknown", text: "Not sure it went: the hub didn't answer. If it arrived, this card says so; Try again sends the same answer, and it is typed at most once." });
    const again = dialog.getByRole("button", { name: "Try again" });
    expect(await again.count()).toBe(1);
    await again.click();
    expect((await counts(tab)).tryAgain).toBe(1);
    await context.close();
  }, 60_000);

  it("says where an answered or closed decision stands", async () => {
    const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
    tab = await context.newPage();
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
    const dialog = tab.getByRole("dialog");                       // one sheet: the item swaps under it
    await dialog.waitFor();
    await tab.evaluate(() => (globalThis as unknown as { __setRunAnswered: (v: boolean) => void }).__setRunAnswered(true));
    expect(await dialog.getByText("Sent. The manager gets it as your decision and acts on it.").count()).toBe(1);
    await tab.evaluate(() => (globalThis as unknown as { __setRunAnswered: (v: boolean) => void }).__setRunAnswered(false));
    await setItem(tab, answeredHere);
    expect(await dialog.getByText("Delivered. You chose Extend the triage script.").count()).toBe(1);
    await setItem(tab, answeredElsewhere);
    expect(await dialog.getByText("Answered on another device: “Extend the triage script”.").count()).toBe(1);
    await setItem(tab, settled);
    expect(await dialog.getByText("This decision is no longer open.").count()).toBe(1);
    expect(await dialog.locator("footer").getByRole("button", { name: "Back" }).count()).toBe(1);
    await context.close();
  }, 60_000);

  it("says why an unanswerable decision can't be answered, and disables its choices", async () => {
    const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
    tab = await context.newPage();
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
    const dialog = tab.getByRole("dialog");                       // one sheet: the item swaps under it
    await dialog.waitFor();
    await setItem(tab, refused);
    expect(await dialog.getByText("The manager's list can't be read right now, so answers are paused. Try again in a moment.").count()).toBe(1);
    expect(await dialog.locator("#brief-choices .act").first().isDisabled()).toBe(true);
    expect(await dialog.locator("#brief-choices").getByRole("button", { name: "Answer in my own words" }).isDisabled()).toBe(true);
    await context.close();
  }, 60_000);

  it("opens the answer box from the words-only footer button", async () => {
    const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
    tab = await context.newPage();
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
    const dialog = tab.getByRole("dialog");                       // one sheet: the item swaps under it
    await dialog.waitFor();
    await setItem(tab, wordsOnly);
    const open = dialog.locator("footer").getByRole("button", { name: "Answer in my own words" });
    await open.waitFor();
    await open.click();
    await dialog.locator("#brief-words").waitFor({ timeout: 3_000 });
    await context.close();
  }, 60_000);

  it("still shows the asker's message and link on a brief-backed sheet", async () => {
    const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
    tab = await context.newPage();
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
    const dialog = tab.getByRole("dialog");                       // one sheet: the item swaps under it
    await dialog.waitFor();
    await setItem(tab, withAsker);
    await dialog.getByRole("heading", { name: "From the asker" }).waitFor({ timeout: 3_000 });
    expect(await dialog.getByText("ship it").count()).toBe(1);
    const link = dialog.getByRole("link", { name: /Open the link/ });
    expect(await link.count()).toBe(1);
    expect(await link.getAttribute("href")).toBe("https://example.com/ledger-row");
    await context.close();
  }, 60_000);

  it("keeps the recommended row's accent bar off the star and the key", async () => {
    const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
    tab = await context.newPage();
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
    const dialog = tab.getByRole("dialog", { name: "Approve option B: extend the in-house triage script" });
    await dialog.waitFor();
    const pad = await dialog.locator(".factors li.rec").first().evaluate(el => getComputedStyle(el).paddingLeft);
    expect(pad).toBe("8px");
    await context.close();
  }, 60_000);

  it("says the catch-up word when Today's passkey check does not finish", async () => {
    const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
    tab = await context.newPage();
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
    await tab.evaluate(() => { document.querySelector("dialog")?.close(); (globalThis as { __passkeyOk?: boolean }).__passkeyOk = false; });
    const row = tab.locator("#today").locator('li[data-row="d:d-2"]');
    await row.getByRole("button", { name: "Ship today" }).click();
    await row.getByText("Not answered: the passkey check didn't finish.").waitFor({ timeout: 3_000 });
    await context.close();
  }, 60_000);

  it("says why a compact card's answers are paused, and doesn't say the minutes twice", async () => {
    const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
    tab = await context.newPage();
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
    await tab.evaluate(() => document.querySelector("dialog")?.close());
    const spendCard = tab.locator("#spend");
    expect(await spendCard.getByText("≈4 min").count()).toBe(1);
    const refusedCard = tab.locator("#refused");
    expect(await refusedCard.getByText("The manager's list can't be read right now, so answers are paused. Try again in a moment.").count()).toBe(1);
    expect(await refusedCard.getByRole("button", { name: "Ship today" }).isDisabled()).toBe(true);
    await context.close();
  }, 60_000);
});
