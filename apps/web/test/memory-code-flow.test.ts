// The Desktop mints the console's one-time approval code for a pending Memory note under step-up (ADR-0031 round 3,
// AC7): the card's button asks the hub; a 403 step_up runs the passkey check once and asks again — exactly two posts,
// one passkey round — and a decided note's 409 not_pending is said in words, with no code anywhere. The whole Desktop
// client with the feed and fetch faked at the browser's edges (answer-in-doubt-web.test.ts's shape), in headless
// Chromium. Synthetic data only.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Escalations, escalationId, type Ask } from "@morndo/domain";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

const NOW = Date.now();
const CODE = "K7M2-9QPX-4TWB";
const COMMAND = "morndo memory approve N-12";

// The Ask a pending Note files (memory-asks.ts shape): mem-n-12 from the note N-12, asker "memory", tracking "hub".
const ask: Ask = {
  id: escalationId("mem-n-12"), asker: { kind: "worker", name: "memory", workerId: null }, need: "decision",
  title: 'Approve the procedure "Deploy the api" for repo:shop-api?', shortTitle: null, summary: null, minutes: null,
  link: null, details: null, context: "Written by lane:api-fix (tier 3)\n\n1. Tag.", contextKind: "markdown",
  options: [
    { key: "approve", label: "Approve", detail: "It reaches every lane's skills at the next sync" },
    { key: "reject", label: "Reject", detail: "The note is invalidated and reaches no lane" },
  ],
  answerBy: "tap", recommendation: null,
  ifNoAnswer: "The note stays out of every lane's skills until you approve it.",
  deadline: null, blocking: false, project: null, askedAt: NOW - 20 * 60_000, messageId: null, tracking: "hub",
};
const board = new Escalations();
board.reconcile([{ ask, source: { kind: "open" }, answered: null }], NOW, true);
const ITEM = { ...board.get("mem-n-12"), answerable: null, version: "v1" };

type GateWin = FeedWin & {
  fetch: typeof fetch;
  __codePosts: number;                       // every approval-code POST that reached the gate
  __verifyRounds: number;                    // every step-up verify the passkey's answer was sent to
  __codeReplies: { status: number; body: unknown }[];   // the gate's answers, in order; a fresh code when it runs out
};

// Runs in the page before the app: the hub's approval-code route (answered from the queue the test fills, then 200 with
// a ten-minute code) and its step-up pair, as the other step-up tests fake them (composer-check-typed-web.test.ts).
function memoryGate() {
  const w = globalThis as unknown as GateWin;
  w.__codePosts = 0;
  w.__verifyRounds = 0;
  w.__codeReplies = [];
  const inner = w.fetch.bind(w);
  w.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = new URL(url, "http://gate.test").pathname;
    if (path === "/api/memory/notes/N-12/approval-code") {
      w.__codePosts++;
      const r = w.__codeReplies.shift() ?? { status: 200, body: { code: "K7M2-9QPX-4TWB", expiresAt: Date.now() + 600_000 } };
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    }
    if (path === "/api/stepup/options") {
      return new Response(JSON.stringify({ flowId: "f1", options: { challenge: "AAAAAAAAAAAAAAAAAAAAAA", rpId: "127.0.0.1", allowCredentials: [], timeout: 60_000, userVerification: "required" } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path === "/api/stepup/verify") {
      w.__verifyRounds++;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return inner(input, init);
  };
}

// The passkey prompt answers at once, as composer-check-typed-web.test.ts's fake does.
function fakePasskey() {
  const buf = () => new Uint8Array([1, 2, 3]).buffer;
  const n = navigator as unknown as { credentials: { get: () => Promise<unknown> } };
  n.credentials.get = async () => ({
    id: "AQID", rawId: buf(), type: "public-key", authenticatorAttachment: "platform", getClientExtensionResults: () => ({}),
    response: { authenticatorData: buf(), clientDataJSON: buf(), signature: buf(), userHandle: null },
  });
}

let web: Web;
let tab: Page;
let errors: string[];
beforeAll(async () => { web = await startWeb(); }, 60_000);
afterAll(async () => { await web?.close(); });
afterEach(async () => { await tab?.context().close(); });

async function desktop(replies: { status: number; body: unknown }[]) {
  const context = await web.browser.newContext({ viewport: { width: 1600, height: 1000 } });
  tab = await context.newPage();
  errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }] });
  await tab.addInitScript(memoryGate);
  await tab.addInitScript(fakePasskey);
  await tab.goto(web.url);
  await tab.waitForFunction(() => typeof (globalThis as unknown as FeedWin).__feedPush === "function");
  await tab.evaluate(r => { (globalThis as unknown as GateWin).__codeReplies = r; }, replies);
  await tab.evaluate(d => (globalThis as unknown as FeedWin).__feedPush({ t: "decisions", items: [d], ledger: { configured: true, ok: true, at: Date.now() } }), ITEM);
  const card = tab.locator('[data-decision="mem-n-12"]').first();
  await card.getByRole("button", { name: "Console code…" }).click({ timeout: 15_000 });
  return card;
}

const gate = () => tab.evaluate(() => ({
  posts: (globalThis as unknown as GateWin).__codePosts,
  rounds: (globalThis as unknown as GateWin).__verifyRounds,
}));

describe("the Desktop mints the console's code under step-up", () => {
  it("a 403 step_up runs the passkey check once, then asks again: two posts, one round, the code and its command", { timeout: 60_000 }, async () => {
    const card = await desktop([{ status: 403, body: { error: "step_up" } }]);
    await card.locator("[data-memory-code]").waitFor({ timeout: 10_000 });
    expect(await card.locator("[data-memory-code]").textContent()).toBe(CODE);
    expect(await card.locator("[data-memory-command]").textContent()).toBe(COMMAND);
    await card.getByText("Valid for 10 min").waitFor();
    expect(await gate()).toEqual({ posts: 2, rounds: 1 });
    expect(errors).toEqual([]);
  });

  it("a decided note answers not_pending in words and shows no code", { timeout: 60_000 }, async () => {
    const card = await desktop([{ status: 409, body: { error: "not_pending" } }]);
    await card.getByRole("alert").filter({ hasText: "This note is already decided: there is nothing to approve." }).waitFor({ timeout: 10_000 });
    expect(await card.locator("[data-memory-code]").count()).toBe(0);
    expect(await gate()).toEqual({ posts: 1, rounds: 0 });   // no step-up for a note that no longer waits
    expect(errors).toEqual([]);
  });
});
