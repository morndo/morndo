// Decision briefs (ADR-0023 §6). A synthetic office, the real morndo-decide, headless Chromium.
// Desktop checks, then the phone sheet at 390×844 (per-factor table, 48px footer, Back, Undo).
// Run: npm run build && node e2e/briefs.e2e.ts
// Screenshots land in E2E_OUT, and also in QA_DIR when that is set (a private QA record, never this tree).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { contrastProblems } from "./contrast.ts";
import { assert, checks, outDir, pairedPage, startOffice } from "./harness.ts";

const ROOT = join(import.meta.dirname, "..");
const DECIDE = join(ROOT, "apps/board-cli/src/decide-main.ts");
const HUB = join(ROOT, "apps/hub/src/main.ts");
const OUT = outDir("briefs");
const QA = process.env.QA_DIR;
if (QA) mkdirSync(QA, { recursive: true });

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const DUE = day(10);
const LATER = day(24);

function brief(over = ""): string {
  return `---
topic: Support inbox triage
due: ${DUE}
minutes: 8
recommend: b
project: support
---

# Approve option B: extend the in-house triage script

## The ask
Approve **$2,400** of contractor time and **6 agent-days** to extend the in-house triage script. It pays back in about **3 weeks**.

Alternative: buy the hosted add-on (C) for **$180 a month**.
Main uncertainty: the saving comes from a two-week sample of 310 tickets.

## Why now
- Tickets waiting more than a day rose from 9 to 23 a week.
- The contractor's free slot runs until ${LATER}.
${over}

## Options compared
| Factor | A · Keep manual triage | B · Extend the triage script | C · Buy a hosted add-on |
|---|---|---|---|
| Year-one cost | $0 | $2,400 | $2,160 |
| Ongoing cost | 5 h a week | 1 day a quarter | $180 a month |
| Time to benefit | none | 3 weeks | 1 week |

Note: costs are cash only. Agent-days and staff hours are not priced.

## Why the recommendation
B keeps ticket text in our own systems and costs less than C from month 14.

Assumptions:
- The contractor's quote of $2,400 is a fixed price.

Downside case: if the saving is only 2 hours a week, switch to C at the review point.

## What would change the recommendation
If the script tags fewer than 60% of tickets in its first week, stop and choose C.

## Main risk and control
Risk: the script routes an urgent ticket to the wrong queue.
Control: for two weeks a person checks every ticket tagged urgent.

## What approval authorizes
Limits:
- Up to $2,400 with the contractor, at a fixed price.

Needs fresh approval: any spend above $2,400, or sending ticket text outside our systems.
Review point: ${LATER}, on tagging accuracy against the 60% line.

## If no decision by the due date
The slot lapses. Manual triage continues.

## Decision
- [a] Keep manual triage
- [b] Extend the triage script
- [c] Buy a hosted add-on

## Evidence
- [Two-week sample](https://example.com/triage-sample)
`;
}

// No recommendation, and option C has no column.
const vague = brief().replace("recommend: b\n", "").replace(" | C · Buy a hosted add-on", "").replace(" | $2,160", "").replace(" | $180 a month", "").replace(" | 1 week", "");

const office = await startOffice("briefs");
const decideEnv = { ...office.env, MORNDO_HUB: office.base, MORNDO_LANE: "manager" };
const c = checks(OUT);
const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: join(OUT, name) });
  if (QA) await page.screenshot({ path: join(QA, name) });
};

function runDecide(args: string[], markdown: string): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(process.execPath, [DECIDE, ...args], { env: decideEnv, encoding: "utf8", input: markdown });
    return { code: 0, out, err: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: err.stdout ?? "", err: err.stderr ?? "" };
  }
}

const browser = await chromium.launch();
try {
  const token = execFileSync(process.execPath, [HUB, "agent-token", "new", "qa-manager", "--role", "manager"], { env: office.env, encoding: "utf8" }).split("\n")[0]?.trim() ?? "";
  assert(token.startsWith("mat_"), "no agent token");
  decideEnv.MORNDO_AGENT_TOKEN = token;

  // Wide enough that the panel at its 640px maximum still leaves the conversation 560px, so End does not turn it into an overlay.
  const { page, context } = await pairedPage(browser, office, { width: 1920, height: 900 });
  c.watch(page);
  await page.locator(".rail").getByRole("button", { name: /Decisions/ }).click();
  const panel = page.getByRole("complementary", { name: "Decisions" });
  await panel.locator("[data-decision]").first().waitFor({ timeout: 15_000 });

  await c.check("a vague brief is refused and files nothing", async () => {
    const refused = runDecide(["new", "-"], vague);
    assert(refused.code === 1, `vague brief exited ${refused.code}: ${refused.err}`);
    assert(refused.err.includes("no_recommendation"), refused.err);
    assert(refused.err.includes("table_columns"), refused.err);
    await page.waitForTimeout(1200);
    assert(await page.getByText("Support inbox triage").count() === 0, "a refused brief showed a card");
  });

  let id = "";
  await c.check("a filed brief shows a compact card", async () => {
    const filed = runDecide(["new", "-"], brief());
    assert(filed.code === 0, `file failed ${filed.code}: ${filed.err}\n${filed.out}`);
    id = filed.out.trim();
    const card = panel.locator(`[data-decision="${id}"]`);
    await card.getByText("Support inbox triage").waitFor({ timeout: 10_000 });
    await card.getByText("Approve option B: extend the in-house triage script").waitFor();
    await card.getByText("Recommended: Extend the triage script").waitFor();
    await card.getByText("≈8 min").waitFor();
    await card.getByText(/Due /).waitFor();
    await card.getByText("Includes spend").waitFor();
    assert(await card.getByRole("button", { name: "Extend the triage script" }).count() === 0, "spend can be approved from the card");
    await shot(page, "briefs-card-light.png");
  });

  const phone = await pairedPage(browser, office, {
    width: 390, height: 844, phone: true, ready: "nav.tabbar",
    init: () => localStorage.setItem("morndo.tab", "today"),
  });
  c.watch(phone.page);
  await c.check("at 390 the sheet is per factor, the footer is 48px, and Back closes it", async () => {
    const row = phone.page.locator(`li[data-row="d:${id}"]`);
    await row.getByText("Includes spend").waitFor({ timeout: 15_000 });
    await row.getByRole("button", { name: "Read the brief" }).waitFor();
    assert(await row.getByRole("button", { name: "Extend the triage script" }).count() === 0, "spend can be approved from Today's card");
    await row.getByRole("button", { name: "Read the brief" }).click();
    const dialog = phone.page.getByRole("dialog", { name: "Approve option B: extend the in-house triage script" });
    await dialog.waitFor();
    assert(await dialog.locator("table.compare").evaluate(el => getComputedStyle(el).display) === "none", "the comparison is still a table");
    await dialog.getByRole("heading", { name: "Year-one cost" }).waitFor();
    await dialog.locator(".factors").getByText("Recommended").first().waitFor();
    const heights = await dialog.locator("footer button").evaluateAll(els => els.map(e => e.getBoundingClientRect().height));
    assert(heights.length >= 2 && heights.every(h => h >= 48), `footer heights ${JSON.stringify(heights)}`);
    const wide = await dialog.locator(".brief-body").evaluate(el => el.scrollWidth - el.clientWidth);
    assert(wide <= 1, `the sheet scrolls sideways by ${wide}px`);
    await phone.cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
    await phone.page.waitForTimeout(200);
    const headerPad = await dialog.locator("header").evaluate(el => parseFloat(getComputedStyle(el).paddingTop));
    const footerPad = await dialog.locator("footer").evaluate(el => parseFloat(getComputedStyle(el).paddingBottom));
    assert(headerPad >= 47 && footerPad >= 34, `insets not cleared: header ${headerPad}px, footer ${footerPad}px`);
    await phone.page.evaluate(() => {
      const vv = window.visualViewport as VisualViewport;
      Object.defineProperty(vv, "height", { configurable: true, get: () => window.innerHeight - 280 });
      Object.defineProperty(vv, "offsetTop", { configurable: true, get: () => 24 });
      vv.dispatchEvent(new Event("resize"));
    });
    await phone.page.waitForTimeout(200);
    const box = await dialog.boundingBox();
    const inner = await phone.page.evaluate(() => innerHeight);
    assert(box !== null && box.y >= 23 && box.y + box.height <= inner - 256 + 2, `sheet left the visual viewport: ${JSON.stringify(box)} inner ${inner}`);
    await phone.page.evaluate(() => {
      const vv = window.visualViewport as VisualViewport;
      delete (vv as unknown as Record<string, unknown>).height;
      delete (vv as unknown as Record<string, unknown>).offsetTop;
      vv.dispatchEvent(new Event("resize"));
    });
    await phone.cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
    await shot(phone.page, "briefs-phone-sheet-light.png");
    const problems = await contrastProblems(phone.page, "light", "dialog.sheet");
    assert(problems.length === 0, `phone contrast: ${problems.slice(0, 4).join("; ")}`);
    await dialog.locator("footer").getByRole("button", { name: "Extend the triage script" }).click();
    await dialog.getByRole("status").getByText("Answered: Extend the triage script").waitFor();
    await dialog.getByRole("button", { name: "Undo" }).click();
    await phone.page.waitForTimeout(6_000);
    const screen = office.tmux("capture-pane", "-p", "-J", "-t", office.office.panes.manager ?? "", "-S", "-80");
    assert(!screen.includes(`[tap ${id}]`), `an undone answer was typed:\n${screen.slice(-400)}`);
    await dialog.getByRole("button", { name: "Back", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await phone.page.goto(new URL(`/?decision=${encodeURIComponent(id)}`, phone.page.url()).href);
    const linked = phone.page.getByRole("dialog", { name: "Approve option B: extend the in-house triage script" });
    await linked.waitFor({ timeout: 15_000 });
    await linked.getByRole("button", { name: "Back", exact: true }).click();
    await linked.waitFor({ state: "hidden" });
  });

  const phoneDark = await pairedPage(browser, office, { width: 390, height: 844, phone: true, colorScheme: "dark", ready: "nav.tabbar" });
  c.watch(phoneDark.page);
  await c.check("the phone sheet meets contrast in the dark theme", async () => {
    await phoneDark.page.goto(new URL(`/?decision=${encodeURIComponent(id)}`, phoneDark.page.url()).href);
    const dialog = phoneDark.page.getByRole("dialog", { name: "Approve option B: extend the in-house triage script" });
    await dialog.waitFor({ timeout: 15_000 });
    await shot(phoneDark.page, "briefs-phone-sheet-dark.png");
    const problems = await contrastProblems(phoneDark.page, "dark", "dialog.sheet");
    assert(problems.length === 0, `dark phone contrast: ${problems.slice(0, 4).join("; ")}`);
  });
  await phoneDark.context.close();
  await phone.context.close();
  c.watch(page);
  if (QA) writeFileSync(join(QA, "open.md"), [
    "# PR 4 phone sheet",
    "",
    "Screenshots: briefs-phone-sheet-light.png, briefs-phone-sheet-dark.png.",
    "",
    "Open: the owner's check on a real iPhone. Chromium emulates the visual viewport and the safe areas. A physical iPhone is not on this box (ADR-0023).",
    "",
  ].join("\n"));

  await c.check("Enter opens the brief, Escape returns focus to the headline", async () => {
    const card = panel.locator(`[data-decision="${id}"]`);
    const open = card.getByRole("button", { name: "Approve option B: extend the in-house triage script" });
    await open.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Approve option B: extend the in-house triage script" });
    await dialog.waitFor();
    const headers = await dialog.locator("th[scope='col']").allInnerTexts();
    assert(headers.length === 3, `columns ${JSON.stringify(headers)}`);
    assert(headers.some(h => h.includes("Recommended")), `no Recommended header: ${JSON.stringify(headers)}`);
    await dialog.getByText("doesn't enforce the limits").waitFor();
    await shot(page, "briefs-modal-light.png");
    let problems: string[] = [];
    try {
      problems = await contrastProblems(page, "light", "dialog.brief");
    } finally {
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    }
    assert(problems.length === 0, `contrast: ${problems.slice(0, 4).join("; ")}`);
    assert(await open.evaluate(el => el === document.activeElement), "focus did not return to the headline");
  });

  await c.check("the decisions panel resizes from the keyboard", async () => {
    const grip = panel.getByRole("separator", { name: "Resize the decisions panel" });
    await grip.waitFor();
    const before = Number(await grip.getAttribute("aria-valuenow"));
    await grip.press("ArrowLeft");
    const after = Number(await grip.getAttribute("aria-valuenow"));
    assert(after === before + 16, `width ${before} -> ${after}`);
    await grip.press("Home");
    assert(await grip.getAttribute("aria-valuenow") === "360", `home ${await grip.getAttribute("aria-valuenow")}`);
    await grip.press("End");
    assert(await grip.getAttribute("aria-valuenow") === "640", `end ${await grip.getAttribute("aria-valuenow")}`);
    for (let i = 0; i < 12; i++) await grip.press("ArrowRight");
  });

  const dark = await pairedPage(browser, office, { width: 1920, height: 900, colorScheme: "dark" });
  c.watch(dark.page);
  await c.check("the open brief meets contrast in the dark theme", async () => {
    const panelDark = dark.page.getByRole("complementary", { name: "Decisions" });
    const card = panelDark.locator(`[data-decision="${id}"]`);
    await card.getByText("Support inbox triage").waitFor({ timeout: 10_000 });
    await shot(dark.page, "briefs-card-dark.png");
    await card.getByRole("button", { name: "Approve option B: extend the in-house triage script" }).click();
    const dialog = dark.page.getByRole("dialog", { name: "Approve option B: extend the in-house triage script" });
    await dialog.waitFor();
    await shot(dark.page, "briefs-modal-dark.png");
    const problems = await contrastProblems(dark.page, "dark", "dialog.brief");
    assert(problems.length === 0, `dark contrast: ${problems.slice(0, 4).join("; ")}`);
  });
  await dark.context.close();
  c.watch(page);

  await c.check("a restate while the brief is open refuses the old answer, then the new version is delivered", async () => {
    const card = panel.locator(`[data-decision="${id}"]`);
    await card.getByRole("button", { name: "Approve option B: extend the in-house triage script" }).click();
    const dialog = page.getByRole("dialog", { name: "Approve option B: extend the in-house triage script" });
    await dialog.waitFor();
    const dark = await pairedPage(browser, office, { width: 1920, height: 900, colorScheme: "dark" });
    c.watch(dark.page);
    const darkPanel = dark.page.getByRole("complementary", { name: "Decisions" });
    await darkPanel.locator(`[data-decision="${id}"]`).getByRole("button", { name: "Approve option B: extend the in-house triage script" }).click();
    const darkDialog = dark.page.getByRole("dialog", { name: "Approve option B: extend the in-house triage script" });
    await darkDialog.waitFor();
    const restatedBrief = brief("\n- Restated after the principal opened it.\n")
      .replace("| B · Extend the triage script |", "| B · Buy a hosted add-on |")
      .replace("- [b] Extend the triage script", "- [b] Buy a hosted add-on");
    const restated = runDecide(["restate", id, "-"], restatedBrief);
    assert(restated.code === 0, `restate failed ${restated.code}: ${restated.err}`);
    await dialog.getByText("restated this brief").waitFor({ timeout: 10_000 });
    await darkDialog.getByText("restated this brief").waitFor({ timeout: 10_000 });
    await shot(page, "briefs-restate-light.png");
    await shot(dark.page, "briefs-restate-dark.png");
    await dark.context.close();
    c.watch(page);
    assert(await dialog.getByRole("button", { name: "Send answer" }).count() === 0, "a restated brief can be answered before it is read");
    await dialog.getByRole("button", { name: "Show the new version" }).click();
    await dialog.getByRole("button", { name: /B · Buy a hosted add-on/ }).click();
    await dialog.getByRole("button", { name: "Send answer" }).click();
    const deadline = Date.now() + 12_000;
    let screen = "";
    const tap = `[tap ${id}] b (Buy a hosted add-on)`;
    while (Date.now() < deadline && !screen.includes(tap)) {
      await page.waitForTimeout(300);
      screen = office.tmux("capture-pane", "-p", "-J", "-t", office.office.panes.manager ?? "", "-S", "-80");
    }
    assert(screen.includes(tap), `tap line missing:\n${screen.slice(-500)}`);
    await dialog.getByRole("status").waitFor({ timeout: 8_000 });
    await page.keyboard.press("Escape");
  });

  await c.check("a plain ask says it was filed without a brief, and asking for one leaves it open", async () => {
    const card = panel.locator('[data-decision="ny-8"]');
    await card.getByText("Filed without a brief").waitFor();
    await card.getByRole("button", { name: "Details ›" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Ask for a brief" }).click();
    await dialog.getByText("Asked. This decision stays open.").waitFor({ timeout: 8_000 });
    const deadline = Date.now() + 12_000;
    const line = "Please restate ny-8 as a decision brief: morndo-decide template";
    let screen = "";
    while (Date.now() < deadline && !screen.includes(line)) {
      await page.waitForTimeout(300);
      screen = office.tmux("capture-pane", "-p", "-J", "-t", office.office.panes.manager ?? "", "-S", "-80");
    }
    assert(screen.includes(line), `ask-for-a-brief missing:\n${screen.slice(-500)}`);
    await page.keyboard.press("Escape");
    await card.waitFor();
    assert(await card.getByText(/You answered|Decided/).count() === 0, "asking for a brief answered the decision");
  });

  await context.close();
} finally {
  await browser.close();
  office.stop();
}

process.exit(c.finish());
