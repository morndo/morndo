// Desktop decision briefs (ADR-0023 §6): the compact card, the brief modal, and the markdown subset.
// The real DecisionsPanel, compiled by Vite, in headless Chromium. Synthetic data only.
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DecisionBrief } from "@morndo/domain";
import type { DecisionItem } from "../src/lib/desktop/decisions.ts";
import { startWeb, type Web } from "./harness.ts";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const DUE = Date.parse("2026-10-16T21:59:59Z");

const brief = (): DecisionBrief => ({
  topic: "Support inbox triage",
  due: DUE,
  minutes: 4,
  headline: "Approve option B: extend the in-house triage script",
  recommend: "b",
  ask: { text: "Approve **$2,400** of contractor time.", alternative: "Buy the hosted add-on.", uncertainty: "The sample covers two weeks." },
  whyNow: "- The contractor's slot ends on 2026-10-20.",
  options: [
    { key: "a", label: "Keep manual triage" },
    { key: "b", label: "Extend the triage script" },
    { key: "c", label: "Buy a hosted add-on" },
  ],
  comparison: {
    rows: [
      { factor: "Year-one cost", cells: ["$0", "$2,400", "$2,160"] },
      { factor: "Ongoing cost", cells: ["5 h a week", "1 day a quarter", "$180 a month"] },
      { factor: "Time to benefit", cells: ["none", "3 weeks", "1 week"] },
    ],
    note: "Costs are cash only.",
  },
  why: { text: "B keeps ticket text in-house.", assumptions: ["The quote is a fixed price."], downside: "If the saving is small, switch at the review." },
  changeIf: "If fewer than 60% of tickets are tagged, choose C.",
  risk: { risk: "An urgent ticket goes to the wrong queue.", control: "A person checks every urgent ticket for two weeks." },
  authorizes: { limits: ["Up to $2,400 with the contractor."], freshApproval: "Any spend above $2,400.", reviewPoint: "2026-11-07, on tagging accuracy." },
  ifNoAnswer: "The slot lapses and manual triage continues.",
  evidence: [{ label: "Two-week sample", url: "https://example.com/triage-sample" }],
  blocking: true, project: "support", task: null, ref: null,
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
  recommendation: "Approve option B: extend the in-house triage script",
  ifNoAnswer: "The slot lapses and manual triage continues.",
  deadline: DUE,
  blocking: true,
  project: "support",
  askedAt: NOW - 2 * 3_600_000,
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
  brief: brief(),
  briefVersion: 1,
  ...over,
});

const spend = item("d-1", {});
const plain = item("ny-400", {
  brief: null,
  briefVersion: 0,
  tracking: "ledger",
  title: "Pick the weekday for the newsletter",
  shortTitle: "Newsletter send day",
  summary: "Pick the weekday for the newsletter",
  minutes: null,
  blocking: false,
  project: null,
  recommendation: "Tuesday",
  ifNoAnswer: "It waits until Friday.",
  deadline: DUE,
  options: [
    { key: "tue", label: "Tuesday", detail: null },
    { key: "thu", label: "Thursday", detail: null },
  ],
  version: "v-plain",
  details: "The list has no brief.",
  context: "Sent on a weekday the team already works.",
});

const SAMPLE = [
  "Approve **$2,400** and the [sample](https://example.com/sample).",
  "",
  "- one item",
  "",
  "> a quoted line",
  "",
  "```",
  "tag-rate",
  "```",
  "",
  "~~old~~ and *note*",
  "",
  "| Factor | A |",
  "|---|---|",
  "| Cost | $0 |",
  "",
  "# not a heading",
  "",
  "<img src=x onerror=alert(1)>",
  "",
  "See [the quote](http://example.com/quote).",
].join("\n");

const TAGS = ["p", "br", "strong", "em", "del", "code", "pre", "ul", "ol", "li", "blockquote", "a", "table", "thead", "tbody", "tr", "th", "td"];

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="desk-tokens" style="height:720px;display:flex"><div id="panel" style="width:440px;display:flex;flex-direction:column"></div></div>
<script type="module">
  import "@morndo/brand/tokens.css";
  import "/src/lib/desktop/desk-tokens.css";
  import { mount } from "svelte";
  import { renderBriefMarkdown, BRIEF_MARKDOWN_TAGS } from "/src/lib/markdown.ts";
  import DecisionsPanel from "/src/lib/desktop/DecisionsPanel.svelte";
  window.__html = renderBriefMarkdown(${JSON.stringify(SAMPLE)});
  window.__tags = BRIEF_MARKDOWN_TAGS;
  mount(DecisionsPanel, { target: document.getElementById("panel"), props: {
    items: ${JSON.stringify([spend, plain])},
    ledger: { configured: false, ok: true, at: null },
    now: ${NOW},
    verifiedFresh: true,
    onAnswer: async () => null,
    onOpenScreen() {},
    onOpenChat() {},
  } });
  window.__ready = true;
</script></body></html>`;

let web: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });

describe("desktop decision briefs", () => {
  it("renders the brief markdown subset and drops what lint refuses", async () => {
    tab = await (await web.browser.newContext()).newPage();
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
    const html = await tab.evaluate(() => (globalThis as { __html?: string }).__html ?? "");
    const tags = await tab.evaluate(() => (globalThis as { __tags?: string[] }).__tags ?? []);
    expect(tags).toEqual(TAGS);
    expect(html).toContain("<strong>");
    expect(html).toContain('href="https://example.com/sample"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain("<del>");
    expect(html).not.toMatch(/<h[1-6]/);
    expect(html).not.toMatch(/<img|<script/i);
    expect(html).not.toContain("http://example.com");
  }, 60_000);

  it("shows a compact card and opens the brief in a dialog named by the headline", async () => {
    if (!tab) {
      tab = await (await web.browser.newContext()).newPage();
      await tab.goto(web.url);
      await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
    }
    const card = tab.locator('[data-decision="d-1"]');
    await card.waitFor();
    expect(await card.locator(".facts").count()).toBe(0);
    await card.getByText("Includes spend").waitFor();
    await card.getByText("Recommended: Extend the triage script").waitFor();
    expect(await card.getByRole("button", { name: "Extend the triage script" }).count()).toBe(0);
    const open = card.getByRole("button", { name: "Approve option B: extend the in-house triage script" });
    expect(await open.getAttribute("aria-haspopup")).toBe("dialog");
    await open.focus();
    await tab.keyboard.press("Enter");
    const dialog = tab.getByRole("dialog", { name: "Approve option B: extend the in-house triage script" });
    await dialog.waitFor();
    await dialog.getByRole("columnheader", { name: /Recommended/ }).waitFor();
    expect(await dialog.locator("th[scope='col']").count()).toBe(3);
    await dialog.getByText("Costs are cash only.").waitFor();
    await dialog.getByText("doesn't enforce the limits").waitFor();
    await tab.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    expect(await open.evaluate(el => el === document.activeElement)).toBe(true);
    const plainCard = tab.locator('[data-decision="ny-400"]');
    await plainCard.getByText("Filed without a brief").waitFor();
    await plainCard.getByRole("button", { name: "Tuesday", exact: true }).waitFor();
    await plainCard.getByRole("button", { name: "Details ›" }).click();
    const plainDialog = tab.getByRole("dialog", { name: "Pick the weekday for the newsletter" });
    await plainDialog.getByRole("button", { name: "Ask for a brief" }).waitFor();
    await tab.keyboard.press("Escape");
  }, 60_000);
});
