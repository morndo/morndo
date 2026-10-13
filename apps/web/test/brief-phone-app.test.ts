// The phone app around the brief sheet, mounted whole (review round 1): the sheet is a history entry over whatever he
// was doing — a conversation, catch-up or Today — and the answer it starts belongs to the run's card on top. The hub
// is faked at the browser's edge and its answer endpoint gated (harness.ts); the navigation stand-ins keep shallow-
// routing state the way Kit 2.70.3 does, raw entries included. Synthetic data only.
import type { Page } from "playwright";
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
// A second free brief, so its card has "Read the brief" and a passkey confirm of its own.
const patch = item("d-3", {
  title: "Approve option A: ship the patch today", shortTitle: "Patch window", summary: "Approve option A: ship the patch today",
  brief: brief("Approve option A: ship the patch today"),
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

// The hub's step-up ceremony, faked at the browser edge: options and verify answer, and the authenticator
// prompt resolves, so "Confirm with passkey and send" gets past the check and the test can see what it retries.
function passkeyOk() {
  const g = globalThis as unknown as { fetch: typeof fetch; navigator: { credentials: { get: (o: unknown) => Promise<unknown> } } };
  const real = g.fetch.bind(globalThis);
  g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/stepup/options")) {
      return new Response(JSON.stringify({
        flowId: "flow-1",
        options: { challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", timeout: 60000, rpId: "127.0.0.1", userVerification: "preferred" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/stepup/verify")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    return real(input, init);
  };
  const bytes = (n: number) => new Uint8Array(n);
  g.navigator.credentials.get = async () => ({
    id: "cred", rawId: bytes(8), type: "public-key", authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({}),
    response: { authenticatorData: bytes(37), clientDataJSON: bytes(8), signature: bytes(8), userHandle: null },
  });
}

async function phone(track: (tab: Page) => void, path = "", withGate = false, prelude?: () => void) {
  const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
  const tab = await context.newPage();
  track(tab);
  if (prelude) await tab.addInitScript(prelude);
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
const queue = (tab: Page, answers: { status: number; body?: unknown }[]) =>
  tab.evaluate(x => { (globalThis as unknown as FeedWin).__answerReplies!.push(...x); }, answers);
const STEP_UP = { status: 403, body: { error: "step_up" } };
const calls = (tab: Page) => tab.evaluate(() => (globalThis as unknown as FeedWin).__answerCalls ?? []);
const runDone = (tab: Page) => tab.evaluate(() => (JSON.parse(localStorage.getItem("morndo.catchup.run") ?? "{}") as { run?: { done?: Record<string, string> } }).run?.done ?? {});

describe("the phone around the brief sheet", () => {
  it("pops the chat's history entry when Back is used after a reload", { timeout: 30_000 }, async () => {
    const { errors, track } = errorsOf();
    const { context, tab } = await phone(track);
    await push(tab, [release]);
    await tab.locator('button.row[data-chat="alpha"]').click();
    await tab.locator('button.back[aria-label="Back to chats"]').waitFor({ timeout: 5_000 });
    await tab.reload();
    await tab.locator('button.back[aria-label="Back to chats"]').waitFor({ timeout: 5_000 });
    const state = await tab.evaluate(() => (history.state as { "sveltekit:states"?: { chat?: string } } | null)?.["sveltekit:states"]);
    expect(state?.chat).toBe(ALPHA);                                         // the entry survived; page.state did not
    await tab.locator('button.back[aria-label="Back to chats"]').click();
    await tab.locator('button.row[data-chat="alpha"]').waitFor({ timeout: 3_000 });
    const after = await tab.evaluate(() => (history.state as { "sveltekit:states"?: { chat?: string } } | null)?.["sveltekit:states"]?.chat ?? null);
    expect(after).toBeNull();                                                 // Back popped the entry, it did not only hide the chat
    expect(errors).toEqual([]);
    await context.close();
  });

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

  it("keeps an in-window answer on the card when Back closes a sheet opened from Today", { timeout: 40_000 }, async () => {
    const { errors, track } = errorsOf();
    const { context, tab } = await phone(track, "", true);
    await tab.addInitScript(() => localStorage.setItem("morndo.tab", "today"));
    await tab.goto(tab.url());
    await push(tab, [release]);
    await tab.locator('li[data-row="d:d-2"] [data-open-brief="d-2"]').click();
    const dialog = tab.getByRole("dialog");
    await dialog.waitFor();
    await dialog.locator("footer").getByRole("button", { name: "Ship today" }).click();
    await dialog.getByText(/Goes in \d+ s\./).waitFor({ timeout: 3_000 });
    await dialog.locator("button.back").click();
    await expect.poll(() => dialog.count(), { timeout: 3_000 }).toBe(0);
    await tab.waitForTimeout(500);
    expect(await calls(tab)).toEqual([]);                                          // Back closes the sheet; it does not send
    const card = tab.getByRole("article");
    await card.getByRole("button", { name: "Undo" }).waitFor({ timeout: 2_000 });  // the card keeps the window
    await card.getByText(/Goes in \d+ s\./).waitFor({ timeout: 2_000 });
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

  it("names the asker when a brief is restated while the sheet is open", { timeout: 30_000 }, async () => {
    const { errors, track } = errorsOf();
    const { context, tab } = await phone(track);
    await push(tab, [release]);
    await tab.locator("button.banner.you").click();
    await tab.locator('[data-open-brief="d-2"]').click();
    const dialog = tab.getByRole("dialog");
    await dialog.waitFor();
    await push(tab, [releaseRestated]);
    await dialog.getByText("Alpha restated this brief.").waitFor({ timeout: 3_000 });
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

  it("does not carry an earlier ask's refusal onto a decision that was asked again", { timeout: 45_000 }, async () => {
    const { errors, track } = errorsOf();
    const { context, tab } = await phone(track, "", true);
    await queue(tab, [{ status: 503 }]);
    await push(tab, [triage, other]);
    await tab.locator("button.banner.you").click();
    await tab.getByRole("button", { name: "Ship today" }).click();
    await tab.getByRole("button", { name: "Try again" }).waitFor({ timeout: 15_000 });
    await tab.getByRole("button", { name: "Later" }).click();
    await push(tab, [triageAgain, other]);
    await tab.locator('button.back[aria-label="Back to Today"]').click();
    await tab.getByRole("button", { name: "Today" }).click();
    await tab.locator('li[data-row="d:d-1"] [data-open-brief="d-1"]').click();
    const dialog = tab.getByRole("dialog");
    await dialog.waitFor();
    expect(await dialog.getByRole("button", { name: "Try again" }).count()).toBe(0);
    await dialog.locator("footer").getByRole("button", { name: "Ship today" }).waitFor({ timeout: 3_000 });
    expect(errors).toEqual([]);
    await context.close();
  });

  it("offers a re-asked decision, and does not treat an earlier answer in this run as this ask", { timeout: 45_000 }, async () => {
    const { errors, track } = errorsOf();
    const { context, tab } = await phone(track, "", true);
    await queue(tab, [{ status: 200 }]);
    await push(tab, [triage, other]);
    await tab.locator("button.banner.you").click();
    await tab.getByRole("button", { name: "Ship today" }).click();
    await tab.waitForTimeout(6_500);
    expect((await runDone(tab))["d:d-1"]).toBe("answered");
    await push(tab, [triageAgain, other]);
    await tab.locator('button.back[aria-label="Back to Today"]').click();
    await tab.getByRole("button", { name: "Today" }).click();
    await tab.locator('li[data-row="d:d-1"] [data-open-brief="d-1"]').click();
    const dialog = tab.getByRole("dialog");
    await dialog.waitFor();
    await dialog.locator("footer").getByRole("button", { name: "Ship today" }).waitFor({ timeout: 3_000 });
    expect(await dialog.getByText("Delivered. You chose Ship today.").count()).toBe(0);
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

  it("retries a passkey confirm only for the decision and card the sheet is showing", { timeout: 60_000 }, async () => {
    const { errors, track } = errorsOf();
    const { context, tab } = await phone(track, "", true, passkeyOk);
    await push(tab, [release, patch]);
    await queue(tab, [STEP_UP, STEP_UP, { status: 200 }]);
    await tab.locator("button.banner.you").click();
    await tab.locator('[data-open-brief="d-2"]').click();
    const dialog = tab.getByRole("dialog");
    await dialog.waitFor();
    await dialog.locator("footer").getByRole("button", { name: "Ship today" }).click();
    await dialog.getByRole("button", { name: "Confirm with passkey and send" }).waitFor({ timeout: 15_000 });
    await dialog.locator("button.back").click();
    await expect.poll(() => dialog.count(), { timeout: 3_000 }).toBe(0);
    await tab.getByRole("button", { name: "Later" }).click();                 // d-2 is set aside; the patch is on top
    await tab.getByRole("button", { name: "Ship today" }).click();
    await tab.getByRole("button", { name: "Confirm with passkey and send" }).waitFor({ timeout: 15_000 });
    await tab.locator('[data-open-brief="d-3"]').click();
    await dialog.waitFor();
    const before = (await calls(tab)).length;
    await dialog.getByRole("button", { name: "Confirm with passkey and send" }).click();
    await expect.poll(async () => (await calls(tab)).length, { timeout: 5_000 }).toBe(before + 1);
    const posts = await calls(tab) as { url: string; body: { key?: string } }[];
    expect(posts.at(-1)?.url).toContain("/d-3/");
    expect(posts.at(-1)?.body.key).toBe("a");
    expect(posts.filter(p => p.url.includes("/d-2/"))).toHaveLength(1);
    expect(errors).toEqual([]);
    await context.close();
  });

  it("says when a passkey confirm can't be sent, offline or when the check doesn't finish", { timeout: 45_000 }, async () => {
    const { errors, track } = errorsOf();
    const { context, tab } = await phone(track, "", true);
    await queue(tab, [STEP_UP]);
    await push(tab, [release]);
    await tab.locator("button.banner.you").click();
    await tab.locator('[data-open-brief="d-2"]').click();
    const dialog = tab.getByRole("dialog");
    await dialog.waitFor();
    await dialog.locator("footer").getByRole("button", { name: "Ship today" }).click();
    await dialog.getByRole("button", { name: "Confirm with passkey and send" }).waitFor({ timeout: 15_000 });
    const before = (await calls(tab)).length;
    await context.setOffline(true);
    await dialog.getByRole("button", { name: "Confirm with passkey and send" }).click();
    await dialog.getByText("Still offline. It goes when you try again online.").waitFor({ timeout: 3_000 });
    expect(await calls(tab)).toHaveLength(before);
    await context.setOffline(false);
    await dialog.getByRole("button", { name: "Confirm with passkey and send" }).click();
    await dialog.getByText("Not answered: the passkey check didn't finish.").waitFor({ timeout: 3_000 });
    expect(await calls(tab)).toHaveLength(before);
    expect(errors).toEqual([]);
    await context.close();
  });

  it("resends the card's refused answer when the sheet confirms it", { timeout: 45_000 }, async () => {
    const { errors, track } = errorsOf();
    const { context, tab } = await phone(track, "", true, passkeyOk);
    await push(tab, [release]);
    await queue(tab, [STEP_UP, { status: 200 }]);
    await tab.locator("button.banner.you").click();
    await tab.getByRole("button", { name: "Ship today" }).click();
    await tab.getByRole("button", { name: "Confirm with passkey and send" }).waitFor({ timeout: 15_000 });
    await tab.locator('[data-open-brief="d-2"]').click();
    const dialog = tab.getByRole("dialog");
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Confirm with passkey and send" }).click();
    await expect.poll(async () => (await calls(tab) as { body: { key?: string } }[]).length, { timeout: 5_000 }).toBe(2);
    const posts = await calls(tab) as { url: string; body: { key?: string } }[];
    expect(posts[1]?.url).toContain("/d-2/");
    expect(posts[1]?.body.key).toBe("a");
    expect(errors).toEqual([]);
    await context.close();
  });

  it("resends the latest refused answer, not an earlier pick the sheet started", { timeout: 60_000 }, async () => {
    const { errors, track } = errorsOf();
    const { context, tab } = await phone(track, "", true, passkeyOk);
    await push(tab, [release]);
    await queue(tab, [STEP_UP, STEP_UP, { status: 200 }]);
    await tab.locator("button.banner.you").click();
    await tab.locator('[data-open-brief="d-2"]').click();
    const dialog = tab.getByRole("dialog");
    await dialog.waitFor();
    await dialog.locator("footer").getByRole("button", { name: "Ship today" }).click();
    await dialog.getByRole("button", { name: "Confirm with passkey and send" }).waitFor({ timeout: 15_000 });
    await dialog.locator("button.back").click();
    await expect.poll(() => dialog.count(), { timeout: 3_000 }).toBe(0);
    await tab.getByRole("button", { name: "Wait for Monday" }).click();
    await tab.getByRole("button", { name: "Confirm with passkey and send" }).waitFor({ timeout: 15_000 });
    await tab.locator('[data-open-brief="d-2"]').click();
    await dialog.waitFor();
    const before = (await calls(tab)).length;
    await dialog.getByRole("button", { name: "Confirm with passkey and send" }).click();
    await expect.poll(async () => (await calls(tab)).length, { timeout: 5_000 }).toBe(before + 1);
    const posts = await calls(tab) as { body: { key?: string } }[];
    expect(posts.at(-1)?.body.key).toBe("b");
    expect(posts.filter(p => p.body.key === "a")).toHaveLength(1);
    expect(errors).toEqual([]);
    await context.close();
  });

  it("does not resend a passkey confirm after the brief was restated", { timeout: 45_000 }, async () => {
    const { errors, track } = errorsOf();
    const { context, tab } = await phone(track, "", true, passkeyOk);
    await push(tab, [release]);
    await queue(tab, [STEP_UP]);
    await tab.locator("button.banner.you").click();
    await tab.locator('[data-open-brief="d-2"]').click();
    const dialog = tab.getByRole("dialog");
    await dialog.waitFor();
    await dialog.locator("footer").getByRole("button", { name: "Ship today" }).click();
    await dialog.getByRole("button", { name: "Confirm with passkey and send" }).waitFor({ timeout: 15_000 });
    await push(tab, [releaseRestated]);
    await dialog.getByText("Alpha restated this brief.").waitFor({ timeout: 3_000 });
    const before = (await calls(tab)).length;
    await dialog.getByRole("button", { name: "Confirm with passkey and send" }).click();
    await tab.waitForTimeout(500);
    expect(await calls(tab)).toHaveLength(before);
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
    const ids = (posts as { body: { requestId?: string } }[]).map(p => p.body.requestId);
    expect(ids[1]).toBeDefined();                                        // typed at most once
    expect(ids[1]).toBe(ids[0]);
    expect(errors).toEqual([]);
    await context.close();
  });
});
