// An answer the hub keeps in doubt (409 "uncertain": the asker's machine may have typed it; fleet core §3.1, §7) reads
// "May have been sent" on the desktop and on the phone, with Check again, which sends the same request id again (the
// hub asks that machine and never types it twice), never a new one. A refusal that says nothing ran (bad_args, the
// fleet's schema check) gets its words and no Check again. The real Desktop client (fake feed and fetch), the phone's
// Today with the real QuickAnswers, and the phone's catch-up card, in headless Chromium. Synthetic data only.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Escalations, escalationId, type Ask } from "@morndo/domain";
import { REFUSALS } from "../src/lib/desktop/decisions.ts";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

const NOW = Date.now();
const ask = (need: "decision" | "time"): Ask => ({
  id: escalationId(need === "decision" ? "ny-7" : "ny-8"), asker: { kind: "manager", name: "Manager", workerId: "%0" }, need,
  title: need === "decision" ? "Ship the demo release tonight?" : "Sign the delivery note", shortTitle: null, summary: null, minutes: null,
  link: null, details: null, context: null, contextKind: "markdown",
  options: need === "decision" ? [{ key: "ship", label: "Ship it", detail: null }, { key: "hold", label: "Hold", detail: null }] : [],
  answerBy: need === "decision" ? "tap" : "words", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null,
  askedAt: NOW - 20 * 60_000, messageId: null, tracking: "ledger",
});
const board = new Escalations();
board.reconcile([ask("decision"), ask("time")].map(a => ({ ask: a, source: { kind: "open" as const }, answered: null })), NOW, true);
const item = (id: string) => ({ ...board.get(id), answerable: null, version: `v-${id}` });
const DECISION = item("ny-7");
const TASK = item("ny-8");
const UNCERTAIN = REFUSALS.uncertain ?? "";

// One page, three views by ?view=: the whole desktop, the phone's Today, the phone's catch-up card.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Desktop from "/src/lib/desktop/Desktop.svelte";
  import Today from "/src/lib/phone/Today.svelte";
  import DecisionCard from "/src/lib/phone/DecisionCard.svelte";
  import { QuickAnswers } from "/src/lib/phone/quick.svelte.ts";
  import { REFUSALS } from "/src/lib/desktop/decisions.ts";
  const view = new URLSearchParams(location.search).get("view");
  window.__answers = [];
  if (view === "desktop") {
    mount(Desktop, { target: document.body, props: { device: "dev-1", office: "Test office", verifiedAt: Date.now(), policy: { stay: "7d", stepUp: "1h" }, desktop: false, onSignedOut: () => {} } });
  } else if (view === "today") {
    // As postAnswer gives the hub's answers (catchup/answer.ts): first 409 uncertain, then taken.
    const replies = [{ ok: false, code: "uncertain", text: REFUSALS.uncertain }, { ok: true }];
    const quick = new QuickAnswers(async (id, body, seen, requestId) => { window.__answers.push({ id, body, requestId }); return replies.shift() ?? { ok: true }; });
    quick.start();
    window.__quick = quick;
    const feed = { decisions: [${JSON.stringify(TASK)}], workers: [], status: "live", primed: true, caughtUpAt: null };
    mount(Today, { target: document.body, props: { feed, session: { later: {}, cards: [], count: 0 }, quick, verifiedFresh: true, verify: async () => true, onCatchUp: () => {}, onDecide: () => {} } });
  } else {
    const code = new URLSearchParams(location.search).get("code");
    window.__tried = 0;
    mount(DecisionCard, { target: document.body, props: { item: ${JSON.stringify(DECISION)}, primed: true, index: 1, of: 1, now: Date.now(), answering: null,
      refusal: { code, text: REFUSALS[code] }, note: null, onPick: async () => true, onUndo() {}, onVerifyAgain() {}, onTryAgain() { window.__tried++; }, onScreen() {}, onNext() {} } });
  }
  window.__ready = true;
</script></body></html>`;

type AnswerWin = FeedWin & { __answers: { id?: string; body?: unknown; requestId: string }[]; __replies: { status: number; body: unknown }[]; __tried: number; __quick: { flush(): void } };

// Runs in the page before the app: POST /api/escalations/<id>/answer answered from __replies, in order, then 200.
function fakeAnswers() {
  const w = globalThis as unknown as AnswerWin & { fetch: typeof fetch };
  w.__answers = [];
  w.__replies = [];
  const inner = w.fetch.bind(w);
  w.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (!/^\/api\/escalations\/[^/]+\/answer$/.test(url)) return inner(input, init);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { requestId: string };
    w.__answers.push({ requestId: body.requestId, body });
    const r = w.__replies.shift() ?? { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
}

let web: Web;
let tab: Page;
let errors: string[];
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });
afterEach(async () => { await tab?.context().close(); });

async function open(view: string, size: { width: number; height: number }, init?: () => Promise<void>) {
  const context = await web.browser.newContext({ viewport: size });
  tab = await context.newPage();
  errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  await init?.();
  await tab.goto(`${web.url}?view=${view}`);
  await tab.waitForFunction(() => (globalThis as unknown as { __ready?: boolean }).__ready === true);
}
const posted = () => tab.evaluate(() => (globalThis as unknown as AnswerWin).__answers.map(a => a.requestId));

describe("the desktop: an answer in doubt", () => {
  async function desktop(replies: { status: number; body: unknown }[]) {
    await open("desktop", { width: 1600, height: 1000 }, async () => {
      await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }] });
      await tab.addInitScript(fakeAnswers);
    });
    await tab.evaluate(r => { (globalThis as unknown as AnswerWin).__replies = r; }, replies);
    await tab.waitForFunction(() => typeof (globalThis as unknown as FeedWin).__feedPush === "function");
    await tab.evaluate(d => (globalThis as unknown as FeedWin).__feedPush({ t: "decisions", items: [d], ledger: { configured: true, ok: true, at: Date.now() } }), DECISION);
    const card = tab.locator('[data-decision="ny-7"]').first();
    await card.getByRole("button", { name: "Ship it" }).click({ timeout: 15_000 });
    await card.getByRole("button", { name: "Send answer" }).click();
    return card;
  }

  it("says it may have been sent and offers Check again, which sends the same request id; once taken, nothing is left to check", { timeout: 60_000 }, async () => {
    const card = await desktop([{ status: 409, body: { error: "uncertain" } }]);
    await card.getByRole("alert").filter({ hasText: UNCERTAIN }).waitFor({ timeout: 10_000 });
    expect(await card.getByRole("button", { name: "Send answer" }).count()).toBe(0);   // not a new answer: the same one, checked
    await card.getByRole("button", { name: "Check again" }).click();
    await card.getByRole("alert").waitFor({ state: "detached", timeout: 10_000 });
    const ids = await posted();
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    expect(errors).toEqual([]);
  });

  it("a refusal from the fleet's schema check (bad_args) says why in words, and offers no Check again", { timeout: 60_000 }, async () => {
    const card = await desktop([{ status: 409, body: { error: "bad_args" } }]);
    await card.getByRole("alert").filter({ hasText: REFUSALS.bad_args ?? "?" }).waitFor({ timeout: 10_000 });
    expect(await card.getByText(/The hub answered/).count()).toBe(0);
    expect(await card.getByRole("button", { name: "Check again" }).count()).toBe(0);
    expect(await card.getByRole("button", { name: "Send answer" }).count()).toBe(1);
    expect(errors).toEqual([]);
  });
});

describe("the phone: an answer in doubt", () => {
  it("Today: a task's answer in doubt says so and offers Check again, which sends it again with the same request id", { timeout: 60_000 }, async () => {
    await open("today", { width: 390, height: 844 });
    const row = tab.locator('li[data-row="d:ny-8"]');
    await row.getByRole("button", { name: "Done", exact: true }).click({ timeout: 15_000 });
    await tab.evaluate(() => (globalThis as unknown as AnswerWin).__quick.flush());   // its 5-second window, now
    await row.getByText(UNCERTAIN).waitFor({ timeout: 10_000 });
    await row.getByRole("button", { name: "Check again" }).click();
    await tab.evaluate(() => (globalThis as unknown as AnswerWin).__quick.flush());
    await row.getByText(UNCERTAIN).waitFor({ state: "detached", timeout: 10_000 });
    const ids = await posted();
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    expect(errors).toEqual([]);
  });

  it("catch-up's card: an answer in doubt says so and offers Check again (the same request id, catchup/session.svelte.ts)", { timeout: 60_000 }, async () => {
    await open("card&code=uncertain", { width: 390, height: 844 });
    await tab.getByRole("alert").filter({ hasText: UNCERTAIN }).waitFor({ timeout: 10_000 });
    expect(await tab.getByRole("button", { name: "Try again" }).count()).toBe(0);
    await tab.getByRole("button", { name: "Check again" }).click();
    expect(await tab.evaluate(() => (globalThis as unknown as AnswerWin).__tried)).toBe(1);
    expect(errors).toEqual([]);
  });

  it("catch-up's card: a refusal that says nothing ran (bad_args) says why, with nothing to try again", { timeout: 60_000 }, async () => {
    await open("card&code=bad_args", { width: 390, height: 844 });
    await tab.getByRole("alert").filter({ hasText: REFUSALS.bad_args ?? "?" }).waitFor({ timeout: 10_000 });
    expect(await tab.getByRole("button", { name: /Check again|Try again/ }).count()).toBe(0);
    expect(errors).toEqual([]);
  });
});

// The owner dismisses the passkey prompt the hub's step_up opens (Chromium's WebAuthn rejects a cancelled prompt with
// NotAllowedError): the options come from a fake /api/stepup/options.
function dismissPasskey() {
  const w = globalThis as unknown as { fetch: typeof fetch };
  const inner = w.fetch.bind(w);
  w.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (url !== "/api/stepup/options") return inner(input, init);
    return new Response(JSON.stringify({ flowId: "f1", options: { challenge: "AAAAAAAAAAAAAAAAAAAAAA", allowCredentials: [], timeout: 1000, userVerification: "required" } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  navigator.credentials.get = async () => { throw new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"); };
}

// B1 V7 (S7 for an answer, E8): Check again on an answer in doubt keeps the doubt until it is settled. A dismissed passkey
// prompt, a 429 or a 500 leaves Check again on the same request id; Back and Enter in the words box never start another
// answer.
describe("the desktop: an answer in doubt stays in doubt until it is settled", () => {
  async function inDoubt(replies: { status: number; body: unknown }[], answer: "option" | "words" = "option") {
    await open("desktop", { width: 1600, height: 1000 }, async () => {
      await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }] });
      await tab.addInitScript(fakeAnswers);
      await tab.addInitScript(dismissPasskey);
    });
    await tab.evaluate(r => { (globalThis as unknown as AnswerWin).__replies = r; }, [{ status: 409, body: { error: "uncertain" } }, ...replies]);
    await tab.waitForFunction(() => typeof (globalThis as unknown as FeedWin).__feedPush === "function");
    await tab.evaluate(d => (globalThis as unknown as FeedWin).__feedPush({ t: "decisions", items: [d], ledger: { configured: true, ok: true, at: Date.now() } }), DECISION);
    const card = tab.locator('[data-decision="ny-7"]').first();
    if (answer === "option") {
      await card.getByRole("button", { name: "Ship it" }).click({ timeout: 15_000 });
      await card.getByRole("button", { name: "Send answer" }).click();
    } else {
      await card.getByRole("button", { name: "Something else…" }).click({ timeout: 15_000 });
      await card.getByRole("textbox").fill("Ship to staging only");
      await card.getByRole("textbox").press("Enter");
    }
    await card.getByRole("alert").filter({ hasText: UNCERTAIN }).waitFor({ timeout: 10_000 });
    return card;
  }

  for (const [name, reply] of [
    ["403 step_up, its passkey prompt dismissed", { status: 403, body: { error: "step_up" } }],
    ["429 rate_limited", { status: 429, body: { error: "rate_limited" } }],
    ["500 internal error", { status: 500, body: { error: "internal error" } }],
  ] as const) {
    it(`Check again answered ${name}: still Check again on the same request id, never Send answer`, { timeout: 60_000 }, async () => {
      const card = await inDoubt([reply]);
      await card.getByRole("button", { name: "Check again" }).click();
      await tab.waitForFunction(() => (globalThis as unknown as AnswerWin).__answers.length === 2);
      await card.getByRole("button", { name: "Check again" }).waitFor({ timeout: 10_000 });
      expect(await card.getByRole("button", { name: "Send answer" }).count()).toBe(0);
      await card.getByRole("button", { name: "Check again" }).click();
      await tab.waitForFunction(() => (globalThis as unknown as AnswerWin).__answers.length === 3);
      const ids = await posted();
      expect(new Set(ids).size).toBe(1);
      expect(errors).toEqual([]);
    });
  }

  it("Back keeps the doubt: the card offers Check again, not the options", { timeout: 60_000 }, async () => {
    const card = await inDoubt([]);
    await card.getByRole("button", { name: "Back" }).click();
    await card.getByRole("button", { name: "Check again" }).waitFor({ timeout: 10_000 });
    expect(await card.getByRole("button", { name: "Hold" }).count()).toBe(0);
    expect(await card.getByText(UNCERTAIN).count()).toBe(1);
  });

  it("words in doubt: Enter in the words box is Check again (the same request id), and the words can't be edited", { timeout: 60_000 }, async () => {
    const card = await inDoubt([], "words");
    const box = card.getByRole("textbox");
    expect(await box.getAttribute("readonly")).not.toBeNull();
    await box.press("Enter");
    await tab.waitForFunction(() => (globalThis as unknown as AnswerWin).__answers.length === 2);
    const ids = await posted();
    expect(ids[1]).toBe(ids[0]);
  });
});

// B1 V11: the hub's 404 "unknown" (no such decision on its list) is its refusal, never the app's "nobody heard back".
describe("the desktop: the hub's 404 unknown on an answer", () => {
  it("the hub's 404 unknown is its refusal: its words, no Try again, nothing in doubt", { timeout: 60_000 }, async () => {
    await open("desktop", { width: 1600, height: 1000 }, async () => {
      await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }] });
      await tab.addInitScript(fakeAnswers);
    });
    await tab.evaluate(() => { (globalThis as unknown as AnswerWin).__replies = [{ status: 404, body: { error: "unknown", item: null } }]; });
    await tab.waitForFunction(() => typeof (globalThis as unknown as FeedWin).__feedPush === "function");
    await tab.evaluate(d => (globalThis as unknown as FeedWin).__feedPush({ t: "decisions", items: [d], ledger: { configured: true, ok: true, at: Date.now() } }), DECISION);
    const card = tab.locator('[data-decision="ny-7"]').first();
    await card.getByRole("button", { name: "Ship it" }).click({ timeout: 15_000 });
    await card.getByRole("button", { name: "Send answer" }).click();
    await card.getByRole("alert").filter({ hasText: REFUSALS.unknown ?? "?" }).waitFor({ timeout: 10_000 });
    expect(await card.getByRole("button", { name: /Try again|Check again/ }).count()).toBe(0);
    expect(await card.getByRole("button", { name: "Send answer" }).count()).toBe(1);
    expect(errors).toEqual([]);
  });
});
