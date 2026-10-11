// A Command goes to the worker it was written for (AC7, ADR-0006 §4): the real Desktop client, built by Vite with the
// Svelte plugin and run in headless Chromium. The hub is faked at the browser's edges only (fetch, the feed WebSocket,
// the passkey prompt); the selection changes through the sidebar, as a principal would change it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";

const WEB = join(import.meta.dirname, "..");
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Desktop from "/src/lib/desktop/Desktop.svelte";
  mount(Desktop, { target: document.body, props: { device: "dev-1", office: "Test office", verifiedAt: null, policy: { stay: "7d", stepUp: "1h" }, desktop: false, onSignedOut: () => {} } });
</script></body></html>`;

const page = (): Plugin => ({
  name: "composer-target-page",
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
  __calls: { url: string; body: string | null }[]; __releaseVerify: () => void; __feedPush: (m: unknown) => void;
  fetch: typeof fetch; WebSocket: Socket; location: { hostname: string };
  navigator: { credentials: { get: () => Promise<unknown> } };
};

// Runs in the page before the app: a fake hub with three workers, and a passkey prompt the principal approves at once.
// The hub's answer to the passkey check is held until the test releases it.
function fakeHub() {
  const w = globalThis as unknown as Win;
  const calls: Win["__calls"] = [];
  w.__calls = calls;
  let release = () => {};
  const held = new Promise<void>(r => (release = r));
  w.__releaseVerify = () => release();
  const realFetch = w.fetch.bind(w);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  w.fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (!url.startsWith("/api/")) return realFetch(input, init);
    calls.push({ url, body: typeof init.body === "string" ? init.body : null });
    if (url === "/api/stepup/options") return json({ flowId: "flow-1", options: { challenge: "AAAA", rpId: w.location.hostname, allowCredentials: [], userVerification: "required", timeout: 60_000 } });
    if (url === "/api/stepup/verify") { await held; return json({ ok: true }); }
    if (url === "/api/uploads") return json({ id: `up-${calls.length}`, name: "shot.png", size: 68, mime: "image/png" });
    if (/^\/api\/workers\/[^/]+\/send$/.test(url)) return json({ ok: true });
    return json({ error: "not_found" }, 404);
  };
  const buf = () => new Uint8Array([1, 2, 3]).buffer;
  w.navigator.credentials.get = async () => ({
    id: "AQID", rawId: buf(), type: "public-key", authenticatorAttachment: "platform", getClientExtensionResults: () => ({}),
    response: { authenticatorData: buf(), clientDataJSON: buf(), signature: buf(), userHandle: null },
  });
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

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let server: ViteDevServer;
let browser: Browser;
let cacheDir: string;
let tab: Page;

beforeAll(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "morndo-composer-vite-"));
  server = await createServer({
    configFile: false, root: WEB, cacheDir, logLevel: "error", clearScreen: false,
    plugins: [svelte({ configFile: false }), page()],
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    // No dependency discovery while the page loads: a re-optimization then answers 504 and, without HMR, the page stays
    // half-loaded. Unbundled ESM from node_modules loads fine.
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(cacheDir, { recursive: true, force: true });
});

beforeEach(async () => {
  tab = await browser.newPage();
  await tab.addInitScript(fakeHub);
  await tab.goto(server.resolvedUrls?.local[0] ?? "");
}, 60_000);                                              // the first page load compiles the app; slow on a busy box
afterEach(async () => { await tab.close(); });

const openConversation = async (name: string) => {
  await tab.locator("button.row", { hasText: name }).first().click();
  await tab.getByRole("heading", { level: 1, name, exact: true }).waitFor();
};
const sends = () => tab.evaluate(() => (globalThis as unknown as Win).__calls.filter(c => c.url.endsWith("/send")));

describe("the composer's target", () => {
  it("sends to the conversation it was written in, even if another one is opened during the passkey check", async () => {
    await openConversation("alpha");
    await tab.getByRole("textbox", { name: "Message alpha" }).fill("ship the alpha release");
    await tab.getByRole("textbox", { name: "Message alpha" }).press("Enter");
    // Face ID approved; the hub's answer to the check is still on its way. The principal opens #beta.
    await tab.waitForFunction(() => (globalThis as unknown as Win).__calls.some(c => c.url === "/api/stepup/verify"));
    await openConversation("beta");
    await tab.evaluate(() => (globalThis as unknown as Win).__releaseVerify());
    await tab.waitForFunction(() => (globalThis as unknown as Win).__calls.some(c => c.url.endsWith("/send")), undefined, { timeout: 10_000 });

    const sent = await sends();
    expect(sent.map(c => c.url)).toEqual([`/api/workers/${encodeURIComponent("%1")}/send`]);
    expect(JSON.parse(sent[0]?.body ?? "{}").text).toBe("ship the alpha release");
    // And #beta's conversation doesn't show it as a message the principal sent there.
    expect(await tab.locator("main").getByText("ship the alpha release").count()).toBe(0);
  }, 30_000);

  it("doesn't hand the message to another agent when its own agent exits during the passkey check", async () => {
    await openConversation("alpha");
    await tab.getByRole("textbox", { name: "Message alpha" }).fill("ship the alpha release");
    await tab.getByRole("textbox", { name: "Message alpha" }).press("Enter");
    await tab.waitForFunction(() => (globalThis as unknown as Win).__calls.some(c => c.url === "/api/stepup/verify"));
    // alpha's pane closes meanwhile; the client opens another conversation by itself (Desktop.svelte's channel pick).
    await tab.evaluate(() => (globalThis as unknown as Win).__feedPush({ t: "events", events: [{ epoch: "e1", seq: 1, at: 1, body: { type: "WorkerGone", workerId: "%1" } }] }));
    await tab.getByRole("heading", { level: 1, name: "Manager", exact: true }).waitFor();
    await tab.evaluate(() => (globalThis as unknown as Win).__releaseVerify());
    await tab.waitForFunction(() => (globalThis as unknown as Win).__calls.some(c => c.url.endsWith("/send")), undefined, { timeout: 5_000 }).catch(() => {});

    // Sent to alpha's pane (where the hub refuses it: no_pane) or not at all, but never to the manager.
    expect((await sends()).map(c => c.url).filter(u => u !== `/api/workers/${encodeURIComponent("%1")}/send`)).toEqual([]);
  }, 30_000);

  it("doesn't carry one conversation's unsent text and images into another", async () => {
    await openConversation("alpha");
    await tab.getByRole("textbox", { name: "Message alpha" }).fill("half a thought for alpha");
    await tab.locator('input[type="file"]').setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
    await tab.locator(".shots .shot.ready").waitFor();
    await openConversation("beta");

    expect(await tab.getByRole("textbox", { name: "Message beta" }).inputValue()).toBe("");
    expect(await tab.locator(".shots .shot").count()).toBe(0);
  }, 30_000);

  it("shows a markdown file as a chip and refuses an executable and an oversized text file", async () => {
    await openConversation("alpha");
    const input = tab.locator('input[type="file"]');
    await input.setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Hi\n") });
    const chip = tab.locator(".filechip");
    await chip.waitFor();
    expect(await chip.innerText()).toContain("notes.md");
    expect(await chip.innerText()).toContain("MD");
    expect(await chip.innerText()).toContain("5 B");
    await input.setInputFiles({ name: "run.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
    await tab.getByText("run.exe can't be attached").waitFor();
    await input.setInputFiles({ name: "big.md", mimeType: "text/markdown", buffer: Buffer.alloc(1024 * 1024 + 1, 0x61) });
    await tab.getByText("big.md is over 1 MB").waitFor();
    expect(await tab.locator(".filechip").count()).toBe(1);
    await tab.locator("#composer").evaluate(el => {
      const dt = new DataTransfer();
      dt.items.add(new File(["a,b\n"], "rows.csv", { type: "text/csv" }));
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await tab.locator(".filechip", { hasText: "rows.csv" }).waitFor();
    expect(await tab.locator(".filechip").count()).toBe(2);
  }, 30_000);
});
