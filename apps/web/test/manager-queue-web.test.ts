// The manager's delivery queue in the app (fleet-clients §9.1, Task 13): a message to the manager reads "Queued, it will
// be delivered" with why it waits, and can be cancelled while it does (ruling 83), then "Delivered", "May have been
// delivered" or "Not delivered" as the hub's `deliveries` frames say; an answer's card reads the same on the desktop and
// on the phone. The real Desktop client and
// the phone's decision card in headless Chromium, the hub faked at the browser's edges (harness.ts). Synthetic data only.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Escalations, escalationId, type Ask, type Decision } from "@morndo/domain";
import { WAITING, queuedLine } from "../src/lib/queue-words.ts";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

const NOW = Date.now();
const ask: Ask = {
  id: escalationId("ny-7"), asker: { kind: "manager", name: "Manager", workerId: "%0" }, need: "decision", title: "Ship the demo release tonight?",
  shortTitle: null, summary: null, minutes: null, link: null, details: null, context: null, contextKind: "markdown",
  options: [{ key: "ship", label: "Ship it", detail: null }, { key: "hold", label: "Hold", detail: null }], answerBy: "tap",
  recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null, askedAt: NOW - 20 * 60_000, messageId: null, tracking: "ledger",
};
const board = new Escalations();
board.reconcile([{ ask, source: { kind: "open" }, answered: null }], NOW, true);
const decision = (delivery: Decision["delivery"]): Decision => ({ choice: { kind: "option", key: "ship", label: "Ship it" }, at: NOW - 60_000, via: "here", endpointId: null, sessionId: null, delivery });
const answered = (delivery: Decision["delivery"], waiting?: string) =>
  ({ ...board.get("ny-7"), status: "answered", decision: decision(delivery), answerable: "already_answered", version: "v-ny-7", ...(waiting ? { waiting } : {}) });

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Desktop from "/src/lib/desktop/Desktop.svelte";
  import DecisionCard from "/src/lib/phone/DecisionCard.svelte";
  const view = new URLSearchParams(location.search).get("view");
  if (view === "desktop") {
    mount(Desktop, { target: document.body, props: { device: "dev-1", office: "Test office", verifiedAt: Date.now(), policy: { stay: "7d", stepUp: "1h" }, desktop: false, onSignedOut: () => {} } });
  } else {
    const item = window.__item;                     // set by the test before the page loads
    mount(DecisionCard, { target: document.body, props: { item, primed: true, index: 1, of: 1, now: Date.now(), answering: null,
      refusal: null, note: null, onPick: async () => true, onUndo() {}, onVerifyAgain() {}, onTryAgain() {}, onScreen() {}, onNext() {} } });
  }
  window.__ready = true;
</script></body></html>`;

type SendWin = FeedWin & { __posts: { requestId: string; text: string }[]; __delivery: unknown; __cancels: string[]; __cancelAnswer: { status: number; body: unknown } | null };
// Runs in the page before the app: POST /api/workers/<id>/send answers as a fleet hub does for the manager (spec §9.1):
// ok, with where the message stands in the queue; never an echo (it isn't in the conversation yet).
function fakeQueueSend() {
  const w = globalThis as unknown as SendWin & { fetch: typeof fetch };
  w.__posts = [];
  w.__cancels = [];
  w.__cancelAnswer = null;
  w.__delivery = { state: "queued", waiting: "menu_open", why: null };
  const inner = w.fetch.bind(w);
  w.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    // The principal's Cancel (ruling 83): the hub withdraws it, given up, cancelled.
    if (url === "/api/manager/cancel") {
      const { requestId } = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { requestId: string };
      w.__cancels.push(requestId);
      const set = w.__cancelAnswer;                 // a test's own answer of the hub (its status and body)
      if (set) return new Response(JSON.stringify(set.body), { status: set.status, headers: { "content-type": "application/json" } });
      const delivery = { requestId, state: "given_up", waiting: null, why: "cancelled" };
      return new Response(JSON.stringify({ ok: true, delivery }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (!/^\/api\/workers\/[^/]+\/send$/.test(url)) return inner(input, init);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { requestId: string; text: string };
    w.__posts.push({ requestId: body.requestId, text: body.text });
    const delivery = { requestId: body.requestId, ...(w.__delivery as object) };
    return new Response(JSON.stringify({ ok: true, at: Date.now(), delivery }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

let web: Web;
let tab: Page;
let errors: string[];
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });
afterEach(async () => { await tab?.context().close(); });

async function open(query: string, size: { width: number; height: number }, init?: () => Promise<void>) {
  const context = await web.browser.newContext({ viewport: size });
  tab = await context.newPage();
  errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  await init?.();
  await tab.goto(`${web.url}?${query}`);
  await tab.waitForFunction(() => (globalThis as unknown as { __ready?: boolean }).__ready === true);
}
async function desktop() {
  await open("view=desktop", { width: 1600, height: 1000 }, async () => {
    await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }] });
    await tab.addInitScript(fakeQueueSend);
  });
  await tab.waitForFunction(() => typeof (globalThis as unknown as FeedWin).__feedPush === "function");
}
const push = (m: unknown) => tab.evaluate(x => (globalThis as unknown as FeedWin).__feedPush(x), m);
async function writeToManager(text: string): Promise<string> {
  await tab.locator("button.row", { hasText: "Manager" }).first().click();
  const box = tab.getByRole("textbox", { name: "Message Manager" });
  await box.fill(text);
  await box.press("Enter");
  await tab.waitForFunction(t => (globalThis as unknown as SendWin).__posts.some(p => p.text === t), text);
  return tab.evaluate(t => (globalThis as unknown as SendWin).__posts.find(p => p.text === t)?.requestId ?? "", text);
}
const entry = (text: string) => tab.locator("article.pending", { hasText: text });

describe("a message to the manager, on the desktop", () => {
  it("queued with why it waits; then Delivered", { timeout: 60_000 }, async () => {
    await desktop();
    const id = await writeToManager("status please");
    await entry("status please").locator("time", { hasText: "Queued, it will be delivered" }).waitFor({ timeout: 10_000 });
    await entry("status please").getByText(queuedLine("menu_open")).waitFor();
    await push({ t: "deliveries", items: [{ requestId: "someone-elses", state: "delivered", waiting: null, why: null }] });
    await tab.waitForTimeout(300);
    expect(await entry("status please").locator("time").textContent()).toBe("Queued, it will be delivered");   // negative control
    await push({ t: "deliveries", items: [{ requestId: id, state: "delivered", waiting: null, why: null }] });
    await entry("status please").locator("time", { hasText: /^Delivered$/ }).waitFor({ timeout: 10_000 });
    expect(await entry("status please").getByText(/Queued, it will be delivered:/).count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("may have been delivered, or not delivered with why", { timeout: 60_000 }, async () => {
    await desktop();
    const maybe = await writeToManager("deploy when green");
    await push({ t: "deliveries", items: [{ requestId: maybe, state: "uncertain", waiting: null, why: null }] });
    await entry("deploy when green").locator("time", { hasText: "May have been delivered" }).waitFor({ timeout: 10_000 });
    const lost = await writeToManager("call me back");
    await push({ t: "deliveries", items: [{ requestId: lost, state: "given_up", waiting: null, why: "expired" }] });
    await entry("call me back").locator("time", { hasText: "Not delivered" }).waitFor({ timeout: 10_000 });
    await entry("call me back").getByText("Nothing reached the manager: it waited a whole day and was never typed.", { exact: false }).waitFor();
    await entry("call me back").getByRole("button", { name: "Dismiss" }).waitFor();
    expect(errors).toEqual([]);
  });
});

describe("a message to the manager, cancelled while it waits (ruling 83)", () => {
  it("Cancel withdraws it: Not delivered, no Retry; once typed there is no Cancel", { timeout: 60_000 }, async () => {
    await desktop();
    const id = await writeToManager("never mind");
    await entry("never mind").getByRole("button", { name: "Cancel" }).click();
    await entry("never mind").locator("time", { hasText: "Not delivered" }).waitFor({ timeout: 10_000 });
    await entry("never mind").getByText("Nothing reached the manager: it was withdrawn before it was typed.", { exact: false }).waitFor();
    expect(await tab.evaluate(() => (globalThis as unknown as SendWin).__cancels)).toEqual([id]);
    expect(await entry("never mind").getByRole("button", { name: /Retry|Cancel/ }).count()).toBe(0);
    const typed = await writeToManager("status please");
    await push({ t: "deliveries", items: [{ requestId: typed, state: "queued", waiting: "typed", why: null }] });
    await entry("status please").getByText(queuedLine("typed")).waitFor({ timeout: 10_000 });
    expect(await entry("status please").getByRole("button", { name: "Cancel" }).count()).toBe(0);   // negative control
    expect(errors).toEqual([]);
  });
});

// Review (fleet-clients branch) #6: the hub's 404 (`unknown`: it, or the fleet, has no such delivery) says nothing was
// typed; the card must not turn into "typed" with Cancel gone, as a 409 (too late) would.
describe("a Cancel the hub answers 404 unknown", () => {
  it("leaves the message as it stood: never shown as typed, and Cancel stays", { timeout: 60_000 }, async () => {
    await desktop();
    await tab.evaluate(() => { (globalThis as unknown as SendWin).__cancelAnswer = { status: 404, body: { error: "unknown" } }; });
    const id = await writeToManager("about the release");
    await entry("about the release").getByText(queuedLine("menu_open")).waitFor({ timeout: 10_000 });
    await entry("about the release").getByRole("button", { name: "Cancel" }).click();
    await tab.waitForFunction(r => (globalThis as unknown as SendWin).__cancels.includes(r), id);
    await tab.waitForTimeout(300);
    expect(await entry("about the release").getByText(queuedLine("typed")).count()).toBe(0);
    await entry("about the release").getByText(queuedLine("menu_open")).waitFor({ timeout: 5_000 });
    expect(await entry("about the release").getByRole("button", { name: "Cancel" }).count()).toBe(1);
    expect(errors).toEqual([]);
  });
});

describe("an answer to the manager, its card", () => {
  it("on the desktop: queued with why it waits, then delivered, then may have been delivered", { timeout: 60_000 }, async () => {
    await desktop();
    const card = tab.locator('[data-decision="ny-7"]').first();
    const ledger = { configured: true, ok: true, at: Date.now() };
    await push({ t: "decisions", items: [answered({ state: "queued", at: null }, "draft_present")], ledger });
    await card.getByText(`Queued, it will be delivered: ${WAITING.draft_present}.`).waitFor({ timeout: 15_000 });
    await push({ t: "decisions", items: [answered({ state: "delivered", at: NOW })], ledger });
    await card.locator('[data-delivery="delivered"]', { hasText: "Delivered" }).waitFor({ timeout: 10_000 });
    await push({ t: "decisions", items: [answered({ state: "uncertain", at: null })], ledger });
    await card.locator('[data-delivery="uncertain"]', { hasText: "May have been delivered" }).waitFor({ timeout: 10_000 });
    await push({ t: "decisions", items: [answered(undefined)], ledger });          // answered directly: as before
    await card.getByText("The manager has it and closes this when it's done.").waitFor({ timeout: 10_000 });
    expect(errors).toEqual([]);
  });

  it("on the phone: the same words", { timeout: 60_000 }, async () => {
    const card = (item: unknown) => open("view=card", { width: 390, height: 844 }, async () => {
      await tab.addInitScript(x => { (globalThis as unknown as { __item: unknown }).__item = x; }, item);
    });
    await card(answered({ state: "queued", at: null }, "no_pane"));
    await tab.getByText(`Answered. Queued, it will be delivered: ${WAITING.no_pane}.`).waitFor({ timeout: 15_000 });
    await tab.context().close();
    await card(answered({ state: "uncertain", at: null }));
    await tab.getByText("Answered. May have been delivered", { exact: false }).waitFor({ timeout: 15_000 });
    expect(errors).toEqual([]);
  });

  it("given up, never typed: the card is open again and says Not delivered, on the desktop and on the phone", { timeout: 60_000 }, async () => {
    const NOT_DELIVERED = "Not delivered: the answer never reached the manager. Answer again.";
    const reopened = { ...board.get("ny-7"), answerable: null, version: "v-ny-7", notice: NOT_DELIVERED };
    await desktop();
    await push({ t: "decisions", items: [reopened], ledger: { configured: true, ok: true, at: Date.now() } });
    await tab.locator('[data-decision="ny-7"]').first().getByText(NOT_DELIVERED).waitFor({ timeout: 15_000 });
    await tab.context().close();
    await open("view=card", { width: 390, height: 844 }, async () => {
      await tab.addInitScript(x => { (globalThis as unknown as { __item: unknown }).__item = x; }, reopened);
    });
    await tab.getByText(NOT_DELIVERED).waitFor({ timeout: 15_000 });
    await tab.getByRole("button", { name: "Ship it" }).waitFor();                // open: it can be answered again
    expect(errors).toEqual([]);
  });
});
