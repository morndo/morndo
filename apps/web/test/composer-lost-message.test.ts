// A message is never lost silently (review of the F15 fix, R2): if the passkey check before a send fails or is cancelled
// after the principal opened another conversation, the message must come back in its own conversation, as its draft or
// as a failed message with the reason, and must never reach the other one (F15 stays fixed). The real Desktop client,
// built by Vite with the Svelte plugin and run in headless Chromium, as in composer-target.test.ts; the hub and the
// passkey prompt are faked at the browser's edges only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { chromium, type Browser, type Page } from "playwright";
import { steady } from "./harness.ts";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";

const WEB = join(import.meta.dirname, "..");
const TEXT = "ship the alpha release";
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Desktop from "/src/lib/desktop/Desktop.svelte";
  mount(Desktop, { target: document.body, props: { device: "dev-1", office: "Test office", verifiedAt: null, policy: { stay: "7d", stepUp: "1h" }, desktop: false, onSignedOut: () => {} } });
</script></body></html>`;

const page = (): Plugin => ({
  name: "composer-lost-message-page",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      void server.transformIndexHtml("/", PAGE).then(html => { res.setHeader("content-type", "text/html"); res.end(html); }, next);
    });
  },
});

// The page's globals as the fake hub and the checks use them: this file is type-checked without the DOM lib.
type Socket = new (url: string | URL, protocols?: string | string[]) => unknown;
type Win = {
  __calls: { url: string; body: string | null }[]; __passkeyAsked: boolean; __fail: () => void; __release: () => void;
  fetch: typeof fetch; WebSocket: Socket; location: { hostname: string };
  navigator: { credentials: { get: () => Promise<unknown> } };
  DOMException: new (message: string, name: string) => Error;
};

// Runs in the page before the app: a fake hub with three workers. How the passkey check fails, once `__fail()` is
// called: "refused", the hub turns the passkey's answer down; "cancelled", the principal cancels the passkey prompt.
// "passes": the check passes once `__release()` is called (the same moment).
type How = "refused" | "cancelled" | "passes";
function fakeHub(how: How) {
  const w = globalThis as unknown as Win;
  const calls: Win["__calls"] = [];
  w.__calls = calls;
  w.__passkeyAsked = false;
  let fail = () => {};
  const failed = new Promise<void>(r => (fail = r));
  w.__fail = () => fail();
  w.__release = () => fail();
  const realFetch = w.fetch.bind(w);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  w.fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (!url.startsWith("/api/")) return realFetch(input, init);
    calls.push({ url, body: typeof init.body === "string" ? init.body : null });
    if (url === "/api/stepup/options") return json({ flowId: "flow-1", options: { challenge: "AAAA", rpId: w.location.hostname, allowCredentials: [], userVerification: "required", timeout: 60_000 } });
    if (url === "/api/stepup/verify") { await failed; return how === "passes" ? json({ ok: true }) : json({ error: "not_verified" }, 400); }
    if (/^\/api\/workers\/[^/]+\/send$/.test(url)) return json({ ok: true });
    return json({ error: "not_found" }, 404);
  };
  const buf = () => new Uint8Array([1, 2, 3]).buffer;
  w.navigator.credentials.get = async () => {
    w.__passkeyAsked = true;
    if (how === "cancelled") { await failed; throw new w.DOMException("The operation either timed out or was not allowed.", "NotAllowedError"); }
    return {
      id: "AQID", rawId: buf(), type: "public-key", authenticatorAttachment: "platform", getClientExtensionResults: () => ({}),
      response: { authenticatorData: buf(), clientDataJSON: buf(), signature: buf(), userHandle: null },
    };
  };
  const worker = (id: string, name: string) => ({ id, name, location: `/work/${name}`, title: null, lastMessageAt: null, needsYou: false, state: "quiet", changedAt: 0 });
  class Feed {
    readyState = 0;
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0); }
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
  cacheDir = mkdtempSync(join(tmpdir(), "morndo-composer-lost-vite-"));
  server = await createServer({
    configFile: false, root: WEB, cacheDir, logLevel: "error", clearScreen: false,
    plugins: [svelte({ configFile: false }), page()],
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },             // see composer-target.test.ts
  });
  await server.listen();
  browser = steady(await chromium.launch());               // reloads a page a network change cut (harness.ts)
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(cacheDir, { recursive: true, force: true });
});

const load = async (how: How, clock = false) => {
  if (clock) await tab.clock.install();                          // time still flows; the test may jump it forward
  await tab.addInitScript(fakeHub, how);
  await tab.goto(server.resolvedUrls?.local[0] ?? "");
};
beforeEach(async () => { tab = await browser.newPage(); }, 60_000);
afterEach(async () => { await tab.close(); });

const openConversation = async (name: string) => {
  await tab.locator("button.row", { hasText: name }).first().click();
  await tab.getByRole("heading", { level: 1, name, exact: true }).waitFor();
};
const sends = () => tab.evaluate(() => (globalThis as unknown as Win).__calls.filter(c => c.url.endsWith("/send")).map(c => c.url));

// Writes TEXT in #alpha and presses Enter; while the passkey check runs, opens #beta; after `holdMs` more, the check
// fails.
async function sendThenSwitchThenFail(how: "refused" | "cancelled", holdMs = 0) {
  await load(how, holdMs > 0);
  await openConversation("alpha");
  await tab.getByRole("textbox", { name: "Message alpha" }).fill(TEXT);
  await tab.getByRole("textbox", { name: "Message alpha" }).press("Enter");
  if (how === "refused") await tab.waitForFunction(() => (globalThis as unknown as Win).__calls.some(c => c.url === "/api/stepup/verify"));
  else await tab.waitForFunction(() => (globalThis as unknown as Win).__passkeyAsked);
  await openConversation("beta");
  if (holdMs) await tab.clock.fastForward(holdMs);
  await tab.evaluate(() => (globalThis as unknown as Win).__fail());
  await tab.waitForTimeout(500);                                   // the failed check settles
}

// Where the message is now: #beta must show nothing of it; #alpha must have it back as its draft or as a failed message.
async function whereIsIt() {
  const beta = {
    draft: await tab.getByRole("textbox", { name: "Message beta" }).inputValue(),
    shown: await tab.locator("main").getByText(TEXT).count(),
  };
  await openConversation("alpha");
  const draft = await tab.getByRole("textbox", { name: "Message alpha" }).inputValue();
  const failed = await tab.locator("article.pending.failed", { hasText: TEXT }).count();
  return { beta, alpha: { draft, failed, kept: draft.includes(TEXT) || failed > 0 }, sends: await sends() };
}

describe("a send whose passkey check fails after a conversation switch", () => {
  it("control: without a switch, a refused check gives the message back in its conversation", async () => {
    await load("refused");
    await openConversation("alpha");
    await tab.getByRole("textbox", { name: "Message alpha" }).fill(TEXT);
    await tab.getByRole("textbox", { name: "Message alpha" }).press("Enter");
    await tab.waitForFunction(() => (globalThis as unknown as Win).__calls.some(c => c.url === "/api/stepup/verify"));
    await tab.evaluate(() => (globalThis as unknown as Win).__fail());
    await tab.waitForTimeout(500);
    const draft = await tab.getByRole("textbox", { name: "Message alpha" }).inputValue();
    const failed = await tab.locator("article.pending.failed", { hasText: TEXT }).count();
    expect({ kept: draft.includes(TEXT) || failed > 0, sends: await sends() }).toEqual({ kept: true, sends: [] });
  }, 30_000);
  for (const how of ["refused", "cancelled"] as const) {
    it(`comes back in its own conversation when the check is ${how}, and never reaches the other one`, async () => {
      await sendThenSwitchThenFail(how);
      const r = await whereIsIt();
      expect(r.beta).toEqual({ draft: "", shown: 0 });           // F15 stays fixed
      expect(r.sends).toEqual([]);                               // nothing was sent anywhere
      expect(r.alpha).toMatchObject({ kept: true });             // not lost: its draft again, or "Not sent" with the reason
    }, 30_000);
  }
  it("comes back in its own conversation when the passkey prompt stays open 25 seconds and is then cancelled", async () => {
    await sendThenSwitchThenFail("cancelled", 25_000);           // past Desktop.svelte's 20-second cleanup of pending messages
    const r = await whereIsIt();
    expect(r.beta).toEqual({ draft: "", shown: 0 });
    expect(r.sends).toEqual([]);
    expect(r.alpha).toMatchObject({ kept: true });
  }, 30_000);
});

// Staging QA, 2026-10-12: Enter, then, while the passkey check was still open, a second message typed in the box and
// Enter again (ignored while the check is open). When the check passed, the first message went and the box was
// emptied: the second one was gone, never sent and never shown.
describe("a send whose passkey check is still open", () => {
  const typeDuringCheck = async (then: (box: ReturnType<Page["getByRole"]>) => Promise<void>) => {
    await load("passes");
    await openConversation("alpha");
    const box = tab.getByRole("textbox", { name: "Message alpha" });
    await box.fill(TEXT);
    await box.press("Enter");
    await tab.waitForFunction(() => (globalThis as unknown as Win).__calls.some(c => c.url === "/api/stepup/verify"));
    await then(box);
    await box.press("Enter");                                    // ignored: the check is still open
    await tab.evaluate(() => (globalThis as unknown as Win).__release());
    await expect.poll(sends, { timeout: 10_000 }).toHaveLength(1);
    return box;
  };
  it("keeps a new message typed meanwhile in the box, and sends the first one once", async () => {
    const box = await typeDuringCheck(b => b.fill("and a second thought"));
    await tab.waitForTimeout(300);
    expect(await box.inputValue()).toBe("and a second thought");
    expect(await sends()).toHaveLength(1);
  }, 30_000);
  it("keeps what was added to it meanwhile, without what went", async () => {
    const box = await typeDuringCheck(async b => { await b.press("End"); await b.pressSequentially(" plus tests"); });
    await tab.waitForTimeout(300);
    expect(await box.inputValue()).toBe("plus tests");
  }, 30_000);
});
