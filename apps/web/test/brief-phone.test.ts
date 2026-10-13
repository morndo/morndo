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
  inbox: null,
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

const noop = "() => {}";
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="phone" style="height:844px">
  <div id="sheet"></div>
  <div id="spend"></div>
  <div id="free"></div>
  <div id="plain"></div>
  <div id="today"></div>
</div>
<script type="module">
  import "@morndo/brand/tokens.css";
  import "/src/lib/phone/phone.css";
  import { mount } from "svelte";
  import { AnswerSession } from "/src/lib/desktop/answer-session.svelte.ts";
  import BriefSheet from "/src/lib/phone/BriefSheet.svelte";
  import DecisionCard from "/src/lib/phone/DecisionCard.svelte";
  import Today from "/src/lib/phone/Today.svelte";
  import { QuickAnswers } from "/src/lib/phone/quick.svelte.ts";
  const spend = ${JSON.stringify(spend)};
  const free = ${JSON.stringify(free)};
  const plain = ${JSON.stringify(plain)};
  const session = new AnswerSession(spend);
  window.__picks = [];
  mount(BriefSheet, { target: document.getElementById("sheet"), props: {
    item: spend, now: ${NOW}, session, answering: null, note: null, verifiedFresh: true,
    onPick: async (body, label) => { window.__picks.push({ body, label }); return true; },
    onUndo() {},
    onAskBrief: async () => ({ ok: true }),
  } });
  const card = (id, item) => mount(DecisionCard, { target: document.getElementById(id), props: {
    item, primed: true, index: 1, of: 1, now: ${NOW}, answering: null, refusal: null, note: null,
    onPick: async () => false, onUndo: ${noop}, onVerifyAgain: ${noop}, onTryAgain: ${noop}, onScreen: ${noop}, onNext: ${noop},
    onOpenBrief() { window.__opened = item.id; },
  } });
  card("spend", spend);
  card("free", free);
  card("plain", plain);
  const quick = new QuickAnswers(async () => ({ ok: true }));
  const feed = { decisions: [spend, free, plain], workers: [], status: "live", primed: true, caughtUpAt: null };
  const catchup = { later: {}, cards: [], count: 0 };
  mount(Today, { target: document.getElementById("today"), props: {
    feed, session: catchup, quick, verifiedFresh: true, verify: async () => true,
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
