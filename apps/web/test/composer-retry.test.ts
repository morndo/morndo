// A send whose answer never came is retried, not guessed (code review R3, the owner's choice of 2026-10-01). The browser
// can't tell "delivered, but the answer was lost" from "not delivered", and an echo with the same text proves nothing
// (it can come from another device). The hub remembers each session's request ids and answers a repeat with
// 200 {"error":"duplicate","ok":true}. So when POST /send fails without a definite answer from the hub (a network
// error, or a proxy's 502 without the hub's JSON), the composer posts again with the same request id, a few times
// with backoff: "duplicate" or ok means delivered (no "Not sent", no error, the draft stays sent). Since ADR-0008 phase C
// the outbox does this for 2 minutes (S7); when every attempt fails that way, the message shows as "Not sent" with the
// reason (R2) and Retry and Discard, where it used to give its draft back. A definite refusal from the hub (409
// menu_open and the like) is not retried. The real Desktop client, built by Vite with the Svelte
// plugin and run in headless Chromium, as in composer-lost-message.test.ts; the hub is faked at the browser's edges
// only (fetch and the feed WebSocket) and behaves like the real one; the passkey check is fresh, so no step-up runs.
// The page's clock is Playwright's: it runs on its own, and the test jumps it forward through any backoff.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";

const WEB = join(import.meta.dirname, "..");
const TEXT = "ship the alpha release";
const MENU = "alpha is showing a menu. Answer it in the Terminal tab first.";   // MessageList.svelte's PROBLEMS.menu_open
const TIMEOUT = "The hub didn't answer within 2 minutes. Retry checks whether it went in; it is never typed twice.";   // REASONS.timeout
// Signed in with a passkey check just now: with the "1h" step-up policy the composer sends without asking again.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Desktop from "/src/lib/desktop/Desktop.svelte";
  mount(Desktop, { target: document.body, props: { device: "dev-1", office: "Test office", verifiedAt: Date.now(), policy: { stay: "7d", stepUp: "1h" }, desktop: false, onSignedOut: () => {} } });
</script></body></html>`;

const page = (): Plugin => ({
  name: "composer-retry-page",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      void server.transformIndexHtml("/", PAGE).then(html => { res.setHeader("content-type", "text/html"); res.end(html); }, next);
    });
  },
});

// What happens to one POST /send, attempt by attempt (the last step repeats for any further attempt):
// "hub", it reaches the hub, which types it in (or answers a repeat "duplicate") and the answer gets back;
// "lost-network" / "lost-proxy", it reaches the hub and is typed in, but the answer is lost: the browser sees a network
// error, or a proxy's 502 page; "down-network" / "down-proxy", it never reaches the hub, seen the same two ways;
// "menu_open", the hub refuses it (409), as when the agent shows a menu; "rate_limited", the hub refuses it for now
// (429, Retry-After: 20, ADR-0008 A6).
// "rate_limited_zero": a 429 whose Retry-After is 0, as a proxy might send (review L2).
type Step = "hub" | "lost-network" | "lost-proxy" | "down-network" | "down-proxy" | "menu_open" | "rate_limited" | "rate_limited_zero";
type Plan = { steps: Step[]; holdFirst?: boolean };   // holdFirst: the first attempt waits for __release()

// The page's globals as the fake hub and the checks use them: this file is type-checked without the DOM lib.
type Socket = new (url: string | URL, protocols?: string | string[]) => unknown;
type Win = {
  __posts: { requestId: string; text: string; answer: string; at: number }[]; __deliveries: { requestId: string; text: string }[];
  __calls: string[]; __passkeyAsked: boolean; __feedPush: (m: unknown) => void; __release: () => void;
  fetch: typeof fetch; WebSocket: Socket; location: { hostname: string };
  navigator: { credentials: { get: () => Promise<unknown> } };
  DOMException: new (message: string, name: string) => Error;
};

// Runs in the page before the app: a fake hub with three workers that, like the real one, remembers request ids and
// echoes a delivered message over the feed (as the agent's transcript shows it).
function fakeHub(plan: Plan) {
  const w = globalThis as unknown as Win;
  const posts: Win["__posts"] = [];
  const deliveries: Win["__deliveries"] = [];
  const calls: string[] = [];
  Object.assign(w, { __posts: posts, __deliveries: deliveries, __calls: calls, __passkeyAsked: false });
  let release = () => {};
  const held = new Promise<void>(r => (release = r));
  w.__release = () => release();
  const seen = new Set<string>();
  const realFetch = w.fetch.bind(w);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const proxy502 = () => new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", { status: 502, headers: { "content-type": "text/html" } });
  const later = (ms: number) => new Promise(r => setTimeout(r, ms));
  w.fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (!url.startsWith("/api/")) return realFetch(input, init);
    calls.push(url);
    const send = /^\/api\/workers\/([^/]+)\/send$/.exec(url);
    if (!send) return json({ error: "not_found" }, 404);
    const worker = decodeURIComponent(send[1] ?? "");
    const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as { text: string; requestId: string };
    const n = posts.length;
    const post = { requestId: body.requestId, text: body.text, answer: "", at: Date.now() };
    posts.push(post);
    const step = plan.steps[Math.min(n, plan.steps.length - 1)] ?? "hub";
    if (n === 0 && plan.holdFirst) await held;
    // The hub types it in once per request id, and the agent's transcript echoes it back over the feed.
    const deliver = () => {
      if (seen.has(body.requestId)) return false;
      seen.add(body.requestId);
      deliveries.push({ requestId: body.requestId, text: body.text });
      w.__feedPush({ t: "messages", worker, messages: [{ id: `transcript-${body.requestId}`, at: Date.now(), author: { kind: "principal", name: "You" }, kind: "text", text: body.text }] });
      return true;
    };
    post.answer = step;
    switch (step) {
      case "hub":
        if (deliver()) { post.answer = "ok"; return json({ ok: true }); }
        post.answer = "duplicate";
        return json({ error: "duplicate", ok: true });
      case "lost-network": deliver(); await later(150); throw new TypeError("Failed to fetch");
      case "lost-proxy": deliver(); await later(150); return proxy502();
      case "down-network": throw new TypeError("Failed to fetch");
      case "down-proxy": return proxy502();
      case "menu_open": return json({ error: "menu_open" }, 409);
      case "rate_limited": return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "20" } });
      case "rate_limited_zero": return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } });
    }
  };
  w.navigator.credentials.get = async () => {                       // the check is fresh: the prompt must not open
    w.__passkeyAsked = true;
    throw new w.DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
  };
  const worker = (id: string, name: string) => ({ id, name, location: `/work/${name}`, title: null, lastMessageAt: null, needsYou: false, state: "quiet", changedAt: 0 });
  class Feed {
    readyState = 0;
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    constructor() {
      w.__feedPush = (m: unknown) => this.push(m);
      setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0);
    }
    send(raw: string) {
      const m = JSON.parse(raw) as { t: string; worker?: string | null };
      if (m.t === "hello") this.push({ t: "snapshot", epoch: "e1", seq: 0, workers: [worker("%0", "manager"), worker("%1", "alpha"), worker("%2", "beta")] });
      if (m.t === "ping") this.push({ t: "pong", n: (m as unknown as { n: number }).n });   // as the hub answers (phase B)
      if (m.t === "watch" && m.worker) this.push({ t: "history", worker: m.worker, messages: [], session: null });
    }
    push(m: unknown) { setTimeout(() => this.onmessage?.({ data: JSON.stringify(m) }), 0); }
    close() { this.readyState = 3; }
  }
  const RealWebSocket = w.WebSocket;
  const FakeWebSocket = function (url: string | URL, protocols?: string | string[]) {
    return String(url).includes("/api/feed") ? new Feed() : new RealWebSocket(url, protocols);
  } as unknown as Socket;
  Object.assign(FakeWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  w.WebSocket = FakeWebSocket;
}

let server: ViteDevServer;
let browser: Browser;
let cacheDir: string;
let tab: Page;

beforeAll(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "morndo-composer-retry-vite-"));
  server = await createServer({
    configFile: false, root: WEB, cacheDir, logLevel: "error", clearScreen: false,
    plugins: [svelte({ configFile: false }), page()],
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },             // see composer-target.test.ts
  });
  await server.listen();
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(cacheDir, { recursive: true, force: true });
});

beforeEach(async () => { tab = await browser.newPage(); }, 60_000);
afterEach(async () => { await tab.close(); });

const openConversation = async (name: string) => {
  await tab.locator("button.row", { hasText: name }).first().click();
  await tab.getByRole("heading", { level: 1, name, exact: true }).waitFor();
};

// Opens #alpha, writes TEXT and presses Enter; returns once the first POST /send is on its way.
async function send(plan: Plan) {
  await tab.clock.install();                                       // time still flows; the test jumps it forward
  await tab.addInitScript(fakeHub, plan);
  await tab.goto(server.resolvedUrls?.local[0] ?? "");
  await openConversation("alpha");
  const box = tab.getByRole("textbox", { name: "Message alpha" });
  await box.fill(TEXT);
  await box.press("Enter");
  await tab.waitForFunction(() => (globalThis as unknown as Win).__posts.length > 0);
}

// Two and a half minutes of page time, in 2-second jumps: past the outbox's 2-minute budget (ADR-0008 phase C, S7), so
// every retry has happened. Then what #alpha and the fake hub show.
async function settle() {
  for (let t = 0; t < 150_000; t += 2_000) {
    await tab.clock.fastForward(2_000);
    await tab.waitForTimeout(40);
  }
  await tab.waitForTimeout(300);
  const hub = await tab.evaluate(() => {
    const w = globalThis as unknown as Win;
    return { posts: w.__posts, deliveries: w.__deliveries.length, passkeyAsked: w.__passkeyAsked, stepUps: w.__calls.filter(c => c.startsWith("/api/stepup/")).length };
  });
  expect({ passkeyAsked: hub.passkeyAsked, stepUps: hub.stepUps }).toEqual({ passkeyAsked: false, stepUps: 0 });   // no step-up ran
  const failed = tab.locator("article.pending.failed", { hasText: TEXT });
  return {
    shown: await tab.locator("article.msg:not(.pending)", { hasText: TEXT }).count(),       // delivered, from the feed
    sending: await tab.locator("article.pending:not(.failed)", { hasText: TEXT }).count(),
    notSent: await failed.count(),
    reason: (await failed.locator("p.err").allTextContents()).join(" | "),
    note: (await tab.locator("span.err").allTextContents()).join(" | "),                    // the composer's error line
    draft: await tab.getByRole("textbox", { name: "Message alpha" }).inputValue(),
    deliveries: hub.deliveries,
    requestIds: new Set(hub.posts.map(p => p.requestId)).size,
    attempts: hub.posts.length,
    answers: hub.posts.map(p => p.answer),
    gaps: hub.posts.slice(1).map((p, i) => p.at - (hub.posts[i]?.at ?? 0)),
  };
}
// Retried, within the 2-minute budget: after 1.5, 3, 6, 12 s, then every 15 s (S7), so at most 11 attempts in all.
const retried = (n: number) => n >= 2 && n <= 11;

describe("a send whose answer never came is retried with the same request id", () => {
  for (const [how, lost] of [["network error", "lost-network"], ["proxy 502", "lost-proxy"]] as const) {
    it(`delivered, answer lost (${how}): the retry is told duplicate, the message shows once, no "Not sent"`, async () => {
      await send({ steps: [lost, "hub"] });
      const r = await settle();
      expect({ ...r, retried: retried(r.attempts), lastAnswer: r.answers.at(-1) }).toMatchObject({
        shown: 1, sending: 0, notSent: 0, note: "", draft: "",
        deliveries: 1, requestIds: 1, retried: true, lastAnswer: "duplicate",
      });
    }, 120_000);
  }

  // Phase C (ADR-0008): the message stays in the conversation as "Not sent" with Retry and Discard; the box stays free.
  it(`never reaches the hub: retried for 2 minutes, then "Not sent" with the reason, and Retry and Discard`, async () => {
    await send({ steps: ["down-network"] });
    const r = await settle();
    expect({ ...r, retried: retried(r.attempts) }).toMatchObject({
      notSent: 1, reason: TIMEOUT, draft: "", shown: 0, sending: 0, deliveries: 0, requestIds: 1, retried: true,
    });
    await tab.locator("article.pending.failed").getByRole("button", { name: "Retry" }).waitFor();
    await tab.locator("article.pending.failed").getByRole("button", { name: "Discard" }).waitFor();
  }, 120_000);

  it("misses the hub once, then reaches it: delivered once, no error, the composer empty", async () => {
    await send({ steps: ["down-network", "hub"] });
    const r = await settle();
    expect({ ...r, retried: retried(r.attempts), lastAnswer: r.answers.at(-1) }).toMatchObject({
      shown: 1, sending: 0, notSent: 0, note: "", draft: "",
      deliveries: 1, requestIds: 1, retried: true, lastAnswer: "ok",
    });
  }, 120_000);

  it(`the same text arriving from elsewhere proves nothing: this send, never delivered, still shows "Not sent"`, async () => {
    await send({ steps: ["down-network"], holdFirst: true });
    await tab.evaluate(text => (globalThis as unknown as Win).__feedPush({   // another device sends the same words meanwhile
      t: "messages", worker: "%1",
      messages: [{ id: "other-device-1", at: Date.now(), author: { kind: "principal", name: "You" }, kind: "text", text }],
    }), TEXT);
    await tab.locator("article.msg:not(.pending)", { hasText: TEXT }).waitFor();
    await tab.evaluate(() => (globalThis as unknown as Win).__release());
    const r = await settle();
    expect({ ...r, bounded: retried(r.attempts) }).toMatchObject({
      notSent: 1, reason: TIMEOUT, draft: "", shown: 1, deliveries: 0, requestIds: 1, bounded: true,
    });
  }, 120_000);

  it("a 429 is waited out for its Retry-After, then sent again with the same request id: delivered once", async () => {
    await send({ steps: ["rate_limited", "hub"] });
    const r = await settle();
    expect({ ...r, waited: (r.gaps[0] ?? 0) >= 20_000 }).toMatchObject({
      shown: 1, sending: 0, notSent: 0, note: "", draft: "",
      deliveries: 1, requestIds: 1, attempts: 2, answers: ["rate_limited", "ok"], waited: true,
    });
  }, 120_000);

  it("a 429 with Retry-After 0 still waits a second before asking again: no tight loop (review L2)", async () => {
    await send({ steps: ["rate_limited_zero", "rate_limited_zero", "hub"] });
    const r = await settle();
    expect({ ...r, paced: r.gaps.every(g => g >= 1000) }).toMatchObject({ shown: 1, notSent: 0, deliveries: 1, attempts: 3, paced: true });
  }, 120_000);

  it("a definite refusal (409 menu_open) is not retried: Not sent with the reason, on the message", async () => {
    await send({ steps: ["menu_open"] });
    const r = await settle();
    expect(r).toMatchObject({
      attempts: 1, notSent: 1, reason: MENU, note: "", draft: "", shown: 0, sending: 0, deliveries: 0,
    });
  }, 120_000);
});
