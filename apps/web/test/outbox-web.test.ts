// The outbox in the app (ADR-0008 phase C; S4–S8): the real Desktop client in headless Chromium with its real
// IndexedDB, a fake feed (harness.ts) and a fake send endpoint that, like the hub, types each request id once and
// echoes it into the conversation. A reload in the middle of a send, a send written offline, two sends in a row, and
// the hub's "stale" and "uncertain" answers, and Check again on an uncertain one (fleet core §3.1, §7).
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

// "maybe": the worker's machine typed it, but the hub lost touch before it could say so (409 uncertain); a repeat of
// the same request id then answers "duplicate", as the hub's op.status path does. "error": the hub threw (500).
type Answer = "ok" | "hang" | "stale" | "uncertain" | "step_up" | "maybe" | "error";
type SendWin = FeedWin & {
  __answers: Answer[];                          // how the next sends are answered, in order; then "ok"
  __posts: { requestId: string; text: string; seen: string; name?: string | undefined }[];
  __typed: string[];                            // request ids typed, each once
};

// Runs in the page before the app. The plan survives a reload through sessionStorage, as a hub's memory would.
function fakeSend() {
  const w = globalThis as unknown as SendWin & { fetch: typeof fetch; sessionStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void } };
  const load = (k: string, d: unknown) => JSON.parse(w.sessionStorage.getItem(k) ?? JSON.stringify(d)) as never;
  const save = () => { w.sessionStorage.setItem("answers", JSON.stringify(w.__answers)); w.sessionStorage.setItem("posts", JSON.stringify(w.__posts)); w.sessionStorage.setItem("typed", JSON.stringify(w.__typed)); };
  w.__answers = load("answers", []);
  w.__posts = load("posts", []);
  w.__typed = load("typed", []);
  const inner = w.fetch.bind(w);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  w.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const m = /^\/api\/workers\/([^/]+)\/send$/.exec(url);
    if (!m) return inner(input, init);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { requestId: string; text: string; seen: string; name?: string };
    w.__posts.push({ requestId: body.requestId, text: body.text, seen: body.seen, name: body.name });
    const answer = w.__answers.shift() ?? "ok";
    save();
    if (answer === "hang") return new Promise<Response>(() => {});
    if (answer === "stale" || answer === "uncertain") return json({ error: answer }, 409);
    if (answer === "step_up") return json({ error: "step_up" }, 403);
    if (answer === "error") return json({ error: "internal error" }, 500);
    if (w.__typed.includes(body.requestId)) return json({ error: "duplicate", ok: true });
    w.__typed.push(body.requestId);
    save();
    w.__feedPush({ t: "messages", worker: decodeURIComponent(m[1] ?? ""), messages: [{ id: `echo-${body.requestId}`, at: Date.now(), author: { kind: "principal", name: "You" }, kind: "text", text: body.text }] });
    if (answer === "maybe") return json({ error: "uncertain" }, 409);
    return json({ ok: true });
  };
}

let web: Web;
let tab: Page;
let errors: string[];
beforeAll(async () => { web = await startWeb(); }, 60_000);
afterAll(async () => { await web?.close(); });
beforeEach(async () => {
  const context = await web.browser.newContext();                   // a fresh IndexedDB per test
  tab = await context.newPage();
  errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }, { id: "%2", name: "beta" }] });
  await tab.addInitScript(fakeSend);
}, 60_000);
afterEach(async () => { await tab.context().close(); });

const page = <T>(f: () => T) => tab.evaluate(f);
const answers = (a: Answer[]) => tab.evaluate(x => { (globalThis as unknown as SendWin).__answers = x; (globalThis as unknown as { sessionStorage: Storage }).sessionStorage.setItem("answers", JSON.stringify(x)); }, a);
async function openAlpha() {
  await tab.goto(web.url);
  await tab.locator("button.row", { hasText: "alpha" }).first().click();
  await tab.getByRole("heading", { level: 1, name: "alpha", exact: true }).waitFor();
}
const box = () => tab.getByRole("textbox", { name: "Message alpha" });
async function write(text: string) { await box().fill(text); await box().press("Enter"); }
const echoed = (text: string) => tab.locator("article.msg:not(.pending)", { hasText: text });
const entry = (text: string) => tab.locator("article.pending", { hasText: text });

describe("the outbox in the app", () => {
  it("a reload in the middle of a send resumes it from IndexedDB, and the hub types it once", { timeout: 30_000 }, async () => {
    await openAlpha();
    await answers(["hang"]);
    await write("survive the reload");
    await tab.waitForFunction(() => (globalThis as unknown as SendWin).__posts.length === 1);
    expect(await box().inputValue()).toBe("");                           // the box was free at once
    await tab.reload();
    // The desktop opens on Home (ADR-0016), not on alpha: the outbox resumes the send from there, with no conversation
    // open, and the hub types it. Opening alpha's chat after that shows the echo from the hub's conversation.
    await tab.waitForFunction(() => (globalThis as unknown as SendWin).__typed.length === 1, undefined, { timeout: 10_000 });
    await tab.locator("button.row", { hasText: "alpha" }).first().click();
    await echoed("survive the reload").waitFor({ timeout: 10_000 });
    const s = await page(() => { const w = globalThis as unknown as SendWin; return { posts: w.__posts.map(p => p.requestId), typed: w.__typed.length }; });
    expect(s.posts).toHaveLength(2);
    expect(new Set(s.posts).size).toBe(1);                               // the same request id after the reload
    expect(s.typed).toBe(1);
    expect(await entry("survive the reload").count()).toBe(0);           // the echo ended it
    expect(errors).toEqual([]);
  });
  it("written offline, it waits as Queued and goes once when the network is back", { timeout: 30_000 }, async () => {
    await openAlpha();
    await tab.context().setOffline(true);
    await tab.locator(".conn", { hasText: "Offline" }).first().waitFor();
    await write("from the train");
    await entry("from the train").locator("time", { hasText: "Queued" }).waitFor();
    await tab.waitForTimeout(1500);
    expect(await page(() => (globalThis as unknown as SendWin).__posts.length)).toBe(0);
    await tab.context().setOffline(false);
    await echoed("from the train").waitFor({ timeout: 10_000 });
    expect(await page(() => (globalThis as unknown as SendWin).__typed.length)).toBe(1);
  });
  it("the box isn't blocked: two messages in a row both go, in order", { timeout: 30_000 }, async () => {
    await openAlpha();
    await write("first");
    await write("second");
    await echoed("second").waitFor();
    const order = await page(() => (globalThis as unknown as SendWin).__posts.map(p => p.text));
    expect(order).toEqual(["first", "second"]);
  });
  it("carries what the worker waited for: none here", { timeout: 30_000 }, async () => {
    await openAlpha();
    await write("carry on");
    await echoed("carry on").waitFor();
    expect(await page(() => (globalThis as unknown as SendWin).__posts[0]?.seen)).toBe("none");
    expect(await page(() => (globalThis as unknown as SendWin).__posts[0]?.name)).toBe("alpha");   // the worker it was written to (review M2)
  });
  it("names the worker by its own name, not the one shown: the manager's DM says Manager, the hub knows manager", { timeout: 30_000 }, async () => {
    await tab.goto(web.url);
    await tab.locator("button.row", { hasText: "Manager" }).first().click();
    await tab.getByRole("textbox", { name: "Message Manager" }).fill("status please");
    await tab.getByRole("textbox", { name: "Message Manager" }).press("Enter");
    await tab.waitForFunction(() => (globalThis as unknown as SendWin).__posts.length === 1);
    expect(await page(() => (globalThis as unknown as SendWin).__posts[0]?.name)).toBe("manager");
  });
  it("carries the question the worker waited for when it was written (S6)", { timeout: 30_000 }, async () => {
    await openAlpha();
    await tab.evaluate(() => (globalThis as unknown as SendWin).__feedPush({ t: "events", events: [
      { epoch: "e1", seq: 1, at: 1, body: { type: "WorkerNeedsYouChanged", workerId: "%1", needsYou: true, waitingOn: "q:toolu_7" } },
    ] }));
    await tab.locator(".state.needs").waitFor();
    await write("Keep it for one more release");
    await echoed("Keep it for one more release").waitFor();
    expect(await page(() => (globalThis as unknown as SendWin).__posts[0]?.seen)).toBe("q:toolu_7");
  });
  it("carries the question that showed when the message was started, not the one at Enter (review H1)", { timeout: 30_000 }, async () => {
    await openAlpha();
    const needs = (seq: number, on: string | null) => tab.evaluate(([n, w]) => (globalThis as unknown as SendWin).__feedPush({ t: "events", events: [
      { epoch: "e1", seq: n, at: 1, body: { type: "WorkerNeedsYouChanged", workerId: "%1", needsYou: w !== null, waitingOn: w } },
    ] }), [seq, on] as const);
    await needs(1, "q:toolu_A");
    await tab.locator(".state.needs").waitFor();
    await box().pressSequentially("Yes, delete them");
    await needs(2, null);                                              // answered elsewhere while he typed
    await tab.locator(".state.needs").waitFor({ state: "detached" });
    await box().press("Enter");
    await tab.waitForFunction(() => (globalThis as unknown as SendWin).__posts.length === 1);
    expect(await page(() => (globalThis as unknown as SendWin).__posts[0]?.seen)).toBe("q:toolu_A");   // so the hub refuses it
  });
  it("a draft left and come back to still carries the question it was written for, so the hub refuses it (review H1)", { timeout: 30_000 }, async () => {
    await openAlpha();
    const needs = (seq: number, on: string | null) => tab.evaluate(([n, w]) => (globalThis as unknown as SendWin).__feedPush({ t: "events", events: [
      { epoch: "e1", seq: n, at: 1, body: { type: "WorkerNeedsYouChanged", workerId: "%1", needsYou: w !== null, waitingOn: w } },
    ] }), [seq, on] as const);
    await needs(1, "q:toolu_A");
    await tab.locator(".state.needs").waitFor();
    await box().pressSequentially("Yes, delete them");
    await tab.waitForTimeout(400);                                     // saved as a draft
    await tab.locator("button.row", { hasText: "beta" }).first().click();
    await needs(2, "q:toolu_B");                                       // another question while he was away
    await tab.locator("button.row", { hasText: "alpha" }).first().click();
    expect(await box().inputValue()).toBe("Yes, delete them");
    await box().press("Enter");
    await tab.waitForFunction(() => (globalThis as unknown as SendWin).__posts.length === 1);
    expect(await page(() => (globalThis as unknown as SendWin).__posts[0]?.seen)).toBe("q:toolu_A");
  });
  it("Edit puts the text back once: switching away and back doesn't bring it again (review M4)", { timeout: 30_000 }, async () => {
    await openAlpha();
    await answers(["stale"]);
    await write("Keep it");
    await entry("Keep it").getByRole("button", { name: "Edit" }).click();
    expect(await box().inputValue()).toBe("Keep it");
    await box().fill("");
    await tab.getByRole("tab", { name: "Terminal" }).click();
    await tab.getByRole("tab", { name: "Messages" }).click();
    expect(await box().inputValue()).toBe("");
  });
  it("stale: the question changed, so it says so, nothing is typed, and Edit puts the text back to review", { timeout: 30_000 }, async () => {
    await openAlpha();
    await answers(["stale"]);
    await write("Keep it");
    await entry("Keep it").getByText("The question changed: review before sending.").waitFor();
    expect(await page(() => (globalThis as unknown as SendWin).__typed.length)).toBe(0);
    await entry("Keep it").getByRole("button", { name: "Edit" }).click();
    expect(await box().inputValue()).toBe("Keep it");
    await entry("Keep it").waitFor({ state: "detached" });                // gone once IndexedDB has let it go
  });
  it("uncertain: may have been sent, Check again or Discard, and nothing is sent again on its own", { timeout: 30_000 }, async () => {
    await openAlpha();
    await answers(["uncertain"]);
    await write("did it go?");
    const e = entry("did it go?");
    await e.getByText(/May have been sent/).first().waitFor();
    expect(await e.getByRole("button", { name: "Retry" }).count()).toBe(0);
    expect(await e.getByRole("button", { name: "Check again" }).count()).toBe(1);
    await tab.waitForTimeout(2000);
    expect(await page(() => (globalThis as unknown as SendWin).__posts.length)).toBe(1);
    await e.getByRole("button", { name: "Discard" }).click();
    await entry("did it go?").waitFor({ state: "detached" });
  });
  // The hub's first answer to a send its worker's machine may have typed (the connection dropped after the paste) is 409
  // uncertain (final review I1). Before, it was a 500 "internal error", which the app showed as Not sent, inviting the
  // owner to write it again by hand and so type it twice.
  it("a first attempt answered 409 uncertain (the machine may have typed it): May have been sent, with Check again, never Not sent", { timeout: 30_000 }, async () => {
    await openAlpha();
    await answers(["maybe"]);
    await write("in doubt at once");
    const e = entry("in doubt at once");
    await e.getByText("May have been sent", { exact: true }).waitFor({ timeout: 10_000 });
    expect(await e.getAttribute("data-state")).toBe("uncertain");
    expect(await e.getByText(/Not sent/).count()).toBe(0);
    expect(await e.getByRole("button", { name: "Check again" }).count()).toBe(1);
    expect(await e.getByRole("button", { name: "Retry" }).count()).toBe(0);
    await tab.waitForTimeout(1000);
    expect(await page(() => (globalThis as unknown as SendWin).__posts.length)).toBe(1);   // nothing sent again on its own
    expect(errors).toEqual([]);
  });
  const sent = () => page(() => { const w = globalThis as unknown as SendWin; return { posts: w.__posts.map(p => p.requestId), typed: w.__typed.length }; });
  it("Check again: the machine had typed it, so the hub says duplicate; Sent and ended by its echo, typed once", { timeout: 30_000 }, async () => {
    await openAlpha();
    await answers(["maybe"]);
    await write("did it land?");
    const e = entry("did it land?");
    await e.getByRole("button", { name: "Check again" }).click({ timeout: 10_000 });
    await e.waitFor({ state: "detached", timeout: 10_000 });             // Sent, then ended by the echo already shown
    await echoed("did it land?").waitFor();
    const s = await sent();
    expect(s.posts).toHaveLength(2);
    expect(new Set(s.posts).size).toBe(1);                               // the same request id
    expect(s.typed).toBe(1);
    expect(errors).toEqual([]);
  });
  it("Check again: the machine never had it, so the hub types it now; Sent and echoed, typed once", { timeout: 30_000 }, async () => {
    await openAlpha();
    await answers(["uncertain"]);
    await write("never arrived");
    await entry("never arrived").getByRole("button", { name: "Check again" }).click({ timeout: 10_000 });
    await echoed("never arrived").waitFor({ timeout: 10_000 });
    await entry("never arrived").waitFor({ state: "detached" });
    const s = await sent();
    expect(s.posts).toHaveLength(2);
    expect(new Set(s.posts).size).toBe(1);
    expect(s.typed).toBe(1);
  });
  it("Check again: still not sure, so it stays May have been sent, with Check again, and nothing is typed", { timeout: 30_000 }, async () => {
    await openAlpha();
    await answers(["uncertain", "uncertain"]);
    await write("still unsure");
    const e = entry("still unsure");
    await e.getByRole("button", { name: "Check again" }).click({ timeout: 10_000 });
    await tab.waitForFunction(() => (globalThis as unknown as SendWin).__posts.length === 2);
    await tab.waitForTimeout(1000);
    expect(await e.getAttribute("data-state")).toBe("uncertain");
    expect(await e.getByRole("button", { name: "Check again" }).count()).toBe(1);
    const s = await sent();
    expect(new Set(s.posts).size).toBe(1);
    expect(s.typed).toBe(0);
  });
  it("Check again: the machine never had it and the hub refused it now (409 stale): Not sent, its words, Edit", { timeout: 30_000 }, async () => {
    await openAlpha();
    await answers(["uncertain", "stale"]);
    await write("never typed");
    const e = entry("never typed");
    await e.getByRole("button", { name: "Check again" }).click({ timeout: 10_000 });
    await e.getByText("The question changed: review before sending.").waitFor({ timeout: 10_000 });
    expect(await e.getAttribute("data-state")).toBe("failed");
    expect(await e.getByText("Not sent", { exact: true }).count()).toBe(1);
    expect(await e.getByRole("button", { name: "Edit" }).count()).toBe(1);   // as any stale refusal: review it first
    const s = await sent();
    expect(s.posts).toHaveLength(2);
    expect(new Set(s.posts).size).toBe(1);
    expect(s.typed).toBe(0);
    expect(errors).toEqual([]);
  });
  it("Check again: the hub threw (500), which says nothing: it stays May have been sent, with Check again", { timeout: 30_000 }, async () => {
    await openAlpha();
    await answers(["uncertain", "error"]);
    await write("hub threw");
    const e = entry("hub threw");
    await e.getByRole("button", { name: "Check again" }).click({ timeout: 10_000 });
    await tab.waitForFunction(() => (globalThis as unknown as SendWin).__posts.length === 2);
    await tab.waitForTimeout(1000);
    expect(await e.getAttribute("data-state")).toBe("uncertain");
    expect(await e.getByRole("button", { name: "Check again" }).count()).toBe(1);
    expect((await sent()).typed).toBe(0);
  });
  it("Not sent: verify, when the passkey check went stale on the way", { timeout: 30_000 }, async () => {
    await openAlpha();
    await answers(["step_up"]);
    await write("needs a fresh check");
    await entry("needs a fresh check").getByRole("button", { name: "Verify and send" }).waitFor();
  });
});
