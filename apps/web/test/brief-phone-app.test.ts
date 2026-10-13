// The phone app around the brief sheet, mounted whole (review round 1): the sheet is a history entry over whatever he
// was doing — a conversation, catch-up or Today — and the answer it starts belongs to the run's card on top. The hub
// is faked at the browser's edge and its answer endpoint gated (harness.ts); the navigation stand-ins keep shallow-
// routing state the way Kit 2.70.3 does, raw entries included. Synthetic data only.
import type { BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DecisionBrief } from "@morndo/domain";
import type { DecisionItem } from "../src/lib/desktop/decisions.ts";
import { answerGate, fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const DUE = Date.parse("2026-12-01T16:00:00Z");
const ALPHA = "pc.3fa2c1d0.1";

// A free brief (no spend): its sheet has quick answers in the footer, so a tap starts an answer at once.
const brief = (headline: string): DecisionBrief => ({
  topic: "Release timing", due: DUE, minutes: 4, headline, recommend: "a",
  ask: { text: "Ship today.", alternative: "Wait for Monday.", uncertainty: "The build is green." },
  whyNow: "- The build is green.",
  options: [{ key: "a", label: "Ship today" }, { key: "b", label: "Wait for Monday" }],
  comparison: { rows: [{ factor: "When it ships", cells: ["today", "Monday"] }], note: "No money in this one." },
  why: { text: "Today keeps the fix in.", assumptions: ["The build stays green."], downside: "If it regresses, revert." },
  changeIf: "If the build goes red, choose B.",
  risk: { risk: "A regression ships.", control: "The build is green." },
  authorizes: { limits: ["None: no spend."], freshApproval: "None.", reviewPoint: "The next standup." },
  ifNoAnswer: "It ships Monday.",
  evidence: [{ label: "Build log", url: "https://example.com/build" }],
  blocking: true, project: "release", task: null, ref: null,
});

const item = (id: string, over: Partial<DecisionItem>): DecisionItem => ({
  id: id as DecisionItem["id"],
  asker: { kind: "worker", name: "alpha", workerId: ALPHA },
  need: "decision",
  title: "Approve option A: ship the release candidate today",
  shortTitle: "Release timing",
  summary: "Approve option A: ship the release candidate today",
  minutes: 4, link: null, details: null, context: null, contextKind: "markdown",
  options: [{ key: "a", label: "Ship today", detail: null }, { key: "b", label: "Wait for Monday", detail: null }],
  answerBy: "tap", recommendation: "Ship today", ifNoAnswer: "It ships Monday.", deadline: DUE,
  blocking: true, project: "release", askedAt: NOW - 3_600_000, messageId: null, tracking: "hub",
  status: "open", source: "open", decision: null, resolution: null, settledAt: null, askedAgain: false,
  answerable: null, version: "v1", inbox: null, brief: brief("Approve option A: ship the release candidate today"),
  briefVersion: 1, draftedBy: null,
  ...over,
});

const release = item("d-2", {});
// The same release, restated while its sheet was closed: a new version, a new headline, the same ask.
const releaseRestated = item("d-2", {
  version: "v2",
  title: "Approve option A: ship the fixed release today",
  summary: "Approve option A: ship the fixed release today",
  brief: brief("Approve option A: ship the fixed release today"),
});
// Two open asks, so one Later doesn't end the run; the first is asked again (a later ask) after he set it aside.
const triage = item("d-1", { title: "Approve option B: extend the triage script", shortTitle: "Triage", summary: "Approve option B: extend the triage script" });
const triageAgain = item("d-1", {
  version: "v2", askedAt: NOW,
  title: "Approve option B: extend the triage script today", shortTitle: "Triage",
  summary: "Approve option B: extend the triage script today",
});
const other = item("ny-700", {
  brief: null, briefVersion: 0, options: [{ key: "tue", label: "Tuesday", detail: null }, { key: "thu", label: "Thursday", detail: null }],
  recommendation: "Tuesday", title: "Pick the weekday for the newsletter", shortTitle: "Newsletter send day", summary: "Pick the weekday for the newsletter",
});
// An ask for his time: never a catch-up card (C1), but its linked sheet still opens from /?decision=.
const timeAsk = item("ny-9", { need: "time" });

// The whole phone layout, as the app mounts it under 900px; the harness's stand-ins serve its SvelteKit imports.
const PHONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Phone from "/src/lib/phone/Phone.svelte";
  mount(Phone, { target: document.body, props: { device: "phone-1", verifiedAt: Date.now(), policy: { stay: "7d", stepUp: "1h" }, onSignedOut: () => {} } });
</script></body></html>`;

let web: Web;
beforeAll(async () => { web = await startWeb(PHONE_PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });

const errorsOf = () => {
  const errors: string[] = [];
  return { errors, track: (tab: Page) => tab.on("pageerror", e => errors.push(e.message)) };
};

async function phone(track: (tab: Page) => void, path = "", withGate = false) {
  const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
  const tab = await context.newPage();
  track(tab);
  if (withGate) await tab.addInitScript(answerGate);
  await tab.addInitScript(fakeFeed, { workers: [{ id: "pc.3fa2c1d0.0", name: "manager" }, { id: ALPHA, name: "alpha" }] });
  await tab.goto(`${web.url}${path}`);
  // A linked load (?decision=) opens catch-up over the chats list, so the list's status line never shows: wait for the
  // feed socket itself, then for the hub's hello answers to have landed (snapshot and reading).
  await tab.waitForFunction(() => typeof (globalThis as unknown as FeedWin).__feedPush === "function", undefined, { timeout: 15_000 });
  await tab.waitForFunction(() => (globalThis as unknown as FeedWin).__feedSent.some(m => (m as { t: string }).t === "hello"), undefined, { timeout: 15_000 });
  await tab.waitForTimeout(200);
  return { context, tab };
}
const push = (tab: Page, items: DecisionItem[]) =>
  tab.evaluate(x => (globalThis as unknown as FeedWin).__feedPush({ t: "decisions", items: x, ledger: { configured: false, ok: true, at: null } }), items);
const queue = (tab: Page, answers: { status: number }[]) =>
  tab.evaluate(x => { (globalThis as unknown as FeedWin).__answers!.push(...x); }, answers);
const calls = (tab: Page) => tab.evaluate(() => (globalThis as unknown as FeedWin).__answerCalls ?? []);
const runDone = (tab: Page) => tab.evaluate(() => (JSON.parse(localStorage.getItem("morndo.catchup.run") ?? "{}") as { run?: { done?: Record<string, string> } }).run?.done ?? {});

describe("the phone around the brief sheet", () => {
  it("closes the sheet on the first Back from a conversation, and lands back in it", { timeout: 30_000 }, async () => {
    const { errors, track } = errorsOf();
    const { context, tab } = await phone(track);
    await push(tab, [release]);
    await tab.locator('button.row[data-chat="alpha"]').click();          // a conversation: its own history entry
    await tab.locator(".waitbar").getByRole("button", { name: "Decide" }).click();
    await tab.locator('[data-open-brief="d-2"]').click();                // the sheet: one more entry
    await tab.getByRole("dialog").waitFor();
    await tab.getByRole("dialog").locator("button.back").click();        // Back pops the sheet's entry…
    await expect.poll(() => tab.getByRole("dialog").count(), { timeout: 3_000 }).toBe(0);
    await tab.locator('button.back[aria-label="Back to Today"]').click(); // …and catch-up's Back returns to the chat
    await tab.locator(".waitbar").waitFor({ timeout: 3_000 });
    expect(errors).toEqual([]);
    await context.close();
  });

  it("returns to Today when the sheet was opened there and its entry is popped", { timeout: 30_000 }, async () => {
    const { errors, track } = errorsOf();
    const { context, tab } = await phone(track);
    await tab.addInitScript(() => localStorage.setItem("morndo.tab", "today"));
    await tab.goto(tab.url());
    await push(tab, [release]);
    await tab.locator('li[data-row="d:d-2"] [data-open-brief="d-2"]').click();
    await tab.getByRole("dialog").waitFor();
    await tab.getByRole("dialog").locator("button.back").click();
    await expect.poll(() => tab.getByRole("dialog").count(), { timeout: 3_000 }).toBe(0);
    await tab.locator('li[data-row="d:d-2"]').waitFor({ timeout: 3_000 });   // Today's row again, not catch-up
    expect(errors).toEqual([]);
    await context.close();
  });

  it("shows a restated brief as it is when reopened, not as 'restated'", { timeout: 30_000 }, async () => {
    const { errors, track } = errorsOf();
    const { context, tab } = await phone(track);
    await push(tab, [release]);
    await tab.locator("button.banner.you").click();
    await tab.locator('[data-open-brief="d-2"]').click();
    const dialog = tab.getByRole("dialog");
    await dialog.waitFor();
    await dialog.locator("button.back").click();                        // close it; the manager restates the brief
    await expect.poll(() => dialog.count(), { timeout: 3_000 }).toBe(0);
    await push(tab, [releaseRestated]);
    await tab.locator('[data-open-brief="d-2"]').click();               // open the same brief again
    await dialog.waitFor();
    expect(await dialog.locator(".restated").count()).toBe(0);
    await dialog.getByRole("heading", { name: "Approve option A: ship the fixed release today" }).waitFor({ timeout: 3_000 });
    expect(errors).toEqual([]);
    await context.close();
  });

  it("answers the run's current entry for the decision, not its first-pass key", { timeout: 40_000 }, async () => {
    const { errors, track } = errorsOf();
    const { context, tab } = await phone(track, "", true);
    await push(tab, [triage, other]);
    await tab.locator("button.banner.you").click();
    await tab.getByRole("button", { name: "Later" }).click();            // d:d-1 is set aside in this run
    await push(tab, [triageAgain, other]);                              // asked again: it comes back as d:d-1~2
    await tab.locator('button.back[aria-label="Back to Today"]').click();
    await tab.getByRole("button", { name: "Today" }).click();
    await tab.locator('li[data-row="d:d-1"] [data-open-brief="d-1"]').click();
    const dialog = tab.getByRole("dialog");
    await dialog.waitFor();
    await queue(tab, [{ status: 200 }]);
    await dialog.locator("footer").getByRole("button", { name: "Ship today" }).click();
    await tab.waitForTimeout(6_500);                                     // the 5-second window, then the POST
    const done = await runDone(tab);
    expect(done["d:d-1~2"]).toBe("answered");
    expect(errors).toEqual([]);
    await context.close();
  });

  it("says why a tap can't start, when the decision has no card in the run", { timeout: 30_000 }, async () => {
    const { errors, track } = errorsOf();
    const { context, tab } = await phone(track, "?decision=ny-9");       // a linked sheet for an ask for his time
    await push(tab, [timeAsk]);
    const dialog = tab.getByRole("dialog");
    await dialog.waitFor({ timeout: 5_000 });
    await dialog.locator("footer").getByRole("button", { name: "Ship today" }).click();
    await dialog.getByText("Not sent: this decision isn't in your catch-up right now.").waitFor({ timeout: 3_000 });
    expect(errors).toEqual([]);
    await context.close();
  });

  it("refuses a quick answer on Today while offline, instead of running its window", { timeout: 30_000 }, async () => {
    const { errors, track } = errorsOf();
    const { context, tab } = await phone(track);
    await tab.addInitScript(() => localStorage.setItem("morndo.tab", "today"));
    await tab.goto(tab.url());
    await push(tab, [release]);
    await context.setOffline(true);
    await tab.locator('li[data-row="d:d-2"]').getByRole("button", { name: "Ship today" }).click();
    await tab.locator('li[data-row="d:d-2"] .err')
      .getByText("You're offline. A decision goes only while Morndo is connected, so nothing was sent; it stays here.")
      .waitFor({ timeout: 2_500 });
    expect(errors).toEqual([]);
    await context.close();
  });

  it("carries an answer from the sheet through an unknown outcome to Try again", { timeout: 60_000 }, async () => {
    const { errors, track } = errorsOf();
    const { context, tab } = await phone(track, "", true);
    await push(tab, [release]);
    await queue(tab, [{ status: 503 }, { status: 200 }]);
    await tab.locator("button.banner.you").click();
    await tab.locator('[data-open-brief="d-2"]').click();
    const dialog = tab.getByRole("dialog");
    await dialog.waitFor();
    await dialog.locator("footer").getByRole("button", { name: "Ship today" }).click();
    await dialog.getByText("Not sure it went: the hub didn't answer.").waitFor({ timeout: 15_000 });
    await dialog.getByRole("button", { name: "Try again" }).click();
    await dialog.getByText("Sent. The manager gets it as your decision and acts on it.").waitFor({ timeout: 15_000 });
    const posts = await calls(tab);
    expect(posts).toHaveLength(2);
    const [first, second] = posts as { body: { requestId?: string } }[];
    expect(second.body.requestId).toBe(first.body.requestId);            // typed at most once
    expect(errors).toEqual([]);
    await context.close();
  });
});
