// Review round 1, in the browser: a restate keeps the acknowledged brief, a pick does not survive
// "Show the new version", an answer in doubt survives closing the modal, and duplicate rows still render.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { startWeb, type Web } from "./harness.ts";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const DUE = Date.parse("2026-10-16T21:59:59Z");

const brief = (label = "Extend the triage script") => ({
  topic: "Support inbox triage", due: DUE, minutes: 4, headline: "Approve option B: extend the in-house triage script",
  recommend: "b",
  ask: { text: "Approve **$2,400**.", alternative: "A **fixed** price.", uncertainty: "Two weeks." },
  whyNow: "The slot ends soon.",
  options: [
    { key: "a", label: "Keep manual triage" },
    { key: "b", label },
    { key: "c", label: "Buy a hosted add-on" },
  ],
  comparison: {
    rows: [
      { factor: "Year-one cost", cells: ["$0", "$2,400", "$2,160"] },
      { factor: "Year-one cost", cells: ["staff", "script", "vendor"] },
    ],
    note: "Costs are cash only.",
  },
  why: { text: "B keeps ticket text in-house.", assumptions: ["Fixed price.", "Fixed price."], downside: "Switch later." },
  changeIf: "If **fewer than 60%** are tagged.",
  risk: { risk: "Wrong queue.", control: "A person checks." },
  authorizes: { limits: ["Up to $2,400.", "Up to $2,400."], freshApproval: "Above $2,400.", reviewPoint: "November." },
  ifNoAnswer: "The slot lapses.",
  evidence: [
    { label: "diff", url: "https://example.com/same" },
    { label: "checks", url: "https://example.com/same" },
  ],
  blocking: true, project: "support", task: null, ref: null,
});

const base = (id: string, over: Record<string, unknown>) => ({
  id, asker: { kind: "manager", name: "Manager", workerId: "w-manager" }, need: "decision",
  title: "Approve option B: extend the in-house triage script", shortTitle: "Support inbox triage",
  summary: "Approve option B: extend the in-house triage script", minutes: 4, link: null, details: null,
  context: null, contextKind: "markdown",
  options: [{ key: "b", label: "Extend the triage script", detail: null }],
  answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: DUE, blocking: true, project: "support",
  askedAt: NOW - 3_600_000, messageId: null, tracking: "hub", status: "open", source: "open", decision: null,
  resolution: null, settledAt: null, askedAgain: false, answerable: null, version: "v1", inbox: null,
  brief: brief(), briefVersion: 1, ...over,
});

const ITEMS = [
  base("d-1", {}),
  base("d-old", { status: "settled", deadline: NOW - 86_400_000, brief: null, briefVersion: 0, title: "Old release window", shortTitle: "Old release", summary: null }),
  base("q-screen", {
    brief: null, briefVersion: 0, answerBy: "screen", answerable: "on_screen", title: "Which queue?",
    shortTitle: "Queue", summary: "Which queue?", options: [{ key: "1", label: "Inbox", detail: null }],
    asker: { kind: "worker", name: "reviewer", workerId: "w-reviewer" },
  }),
];

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script type="module">
  import "@morndo/brand/tokens.css";
  import "/src/lib/desktop/desk-tokens.css";
  import { mount } from "svelte";
  import Harness from "/test/BriefHarness.svelte";
  mount(Harness, { target: document.body, props: { initial: ${JSON.stringify(ITEMS)}, now: ${NOW} } });
</script></body></html>`;

let web: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });

async function ready() {
  tab = await (await web.browser.newContext()).newPage();
  const errors: string[] = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.goto(web.url);
  await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
  return errors;
}

describe("desktop brief review", () => {
  it("keeps the acknowledged brief until Show the new version, then drops the old pick", async () => {
    await ready();
    const card = tab.locator('[data-decision="d-1"]');
    await card.getByRole("button", { name: "Approve option B: extend the in-house triage script" }).click();
    const dialog = tab.getByRole("dialog");
    await dialog.getByRole("button", { name: /B · Extend the triage script/ }).click();
    await dialog.getByText("Your answer: B · Extend the triage script").waitFor();
    const next = structuredClone(ITEMS[0]) as { version: string; briefVersion: number; brief: { options: { label: string }[]; ask: { text: string } } };
    next.version = "v2";
    next.briefVersion = 2;
    next.brief.options[1]!.label = "Buy a hosted add-on";
    next.brief.ask.text = "Approve the hosted add-on instead.";
    await tab.evaluate(items => (globalThis as unknown as { __setItems: (n: unknown) => void }).__setItems(items), [next, ITEMS[1], ITEMS[2]]);
    await dialog.getByText("restated this brief").waitFor();
    expect(await dialog.getByText("$2,400").count()).toBeGreaterThan(0);
    expect(await dialog.getByText("Approve the hosted add-on instead.").count()).toBe(0);
    await dialog.getByRole("button", { name: "Show the new version" }).click();
    expect(await dialog.getByText("Your answer:").count()).toBe(0);
    await dialog.getByRole("button", { name: /B · Buy a hosted add-on/ }).waitFor();
    await dialog.getByText("Approve the hosted add-on instead.").waitFor();
  }, 60_000);

  it("renders duplicate rows, limits and evidence links", async () => {
    const errors = await ready();
    await tab.locator('[data-decision="d-1"]').getByRole("button", { name: "Approve option B: extend the in-house triage script" }).click();
    const dialog = tab.getByRole("dialog");
    expect(await dialog.getByRole("rowheader", { name: "Year-one cost" }).count()).toBe(2);
    expect(await dialog.getByRole("link", { name: "diff" }).count()).toBe(1);
    expect(await dialog.getByRole("link", { name: "checks" }).count()).toBe(1);
    expect(errors.join("\n")).not.toContain("each_key_duplicate");
  }, 60_000);

  it("an answer in doubt is still Check again after the modal is closed and opened", async () => {
    await ready();
    await tab.evaluate(() => { (globalThis as { __problem?: { code: string; text: string } }).__problem = { code: "uncertain", text: "May have been sent." }; });
    const card = tab.locator('[data-decision="d-1"]');
    await card.getByRole("button", { name: "Approve option B: extend the in-house triage script" }).click();
    const dialog = tab.getByRole("dialog");
    await dialog.getByRole("button", { name: /B · Extend the triage script/ }).click();
    await dialog.getByRole("button", { name: "Send answer" }).click();
    await dialog.getByRole("button", { name: "Check again" }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click().catch(() => {});
    await tab.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await card.getByRole("button", { name: "Approve option B: extend the in-house triage script" }).click();
    await tab.getByRole("dialog").getByRole("button", { name: "Check again" }).waitFor();
  }, 60_000);

  it("a decision answered elsewhere leaves the modal without Send answer", async () => {
    await ready();
    const card = tab.locator('[data-decision="d-1"]');
    await card.getByRole("button", { name: "Approve option B: extend the in-house triage script" }).click();
    const dialog = tab.getByRole("dialog");
    await dialog.getByRole("button", { name: /B · Extend the triage script/ }).click();
    const next = structuredClone(ITEMS[0]) as { status: string };
    next.status = "answered";
    await tab.evaluate(items => (globalThis as unknown as { __setItems: (n: unknown) => void }).__setItems(items), [next, ITEMS[1], ITEMS[2]]);
    await dialog.getByText("no longer open").waitFor();
    expect(await dialog.getByRole("button", { name: "Send answer" }).count()).toBe(0);
  }, 60_000);

  it("a screen ask offers the terminal from the modal", async () => {
    await ready();
    await tab.locator('[data-decision="q-screen"]').getByRole("button", { name: "Which queue?" }).click();
    const dialog = tab.getByRole("dialog");
    await dialog.getByRole("button", { name: /Answer in #reviewer's terminal/ }).click();
    expect(await tab.evaluate(() => (globalThis as { __screen?: boolean }).__screen)).toBe(true);
  }, 60_000);

  it("picking an option moves focus to Send answer", async () => {
    await ready();
    await tab.locator('[data-decision="d-1"]').getByRole("button", { name: "Approve option B: extend the in-house triage script" }).click();
    const dialog = tab.getByRole("dialog");
    await dialog.getByRole("button", { name: /B · Extend the triage script/ }).click();
    await dialog.getByRole("button", { name: "Send answer" }).waitFor();
    expect(await tab.evaluate(() => document.activeElement?.textContent ?? "")).toContain("Send answer");
  }, 60_000);

  it("one-line fields stay inline and markdown fields render", async () => {
    await ready();
    await tab.locator('[data-decision="d-1"]').getByRole("button", { name: "Approve option B: extend the in-house triage script" }).click();
    const dialog = tab.getByRole("dialog");
    const alt = dialog.locator("p.pair", { hasText: "Alternative" });
    expect(await alt.locator("p").count()).toBe(0);
    expect(await alt.locator("strong").count()).toBe(1);
    expect(await dialog.locator("strong", { hasText: "fewer than 60%" }).count()).toBe(1);
  }, 60_000);

  it("a settled card does not show a due chip", async () => {
    await ready();
    await tab.getByRole("button", { name: /^Decided/ }).click();
    const card = tab.locator('[data-decision="d-old"]');
    await card.waitFor();
    expect(await card.locator(".chip").count()).toBe(0);
  }, 60_000);
});
