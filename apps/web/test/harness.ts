// Shared harness for the web component tests: the real Desktop client, built by Vite with the Svelte plugin and run in
// headless Chromium, with the hub faked at the browser's edges only (the feed WebSocket, fetch). As in
// composer-retry.test.ts, but scriptable from the test: frames can be pushed raw, and every frame the app sends is kept.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { chromium, type Browser } from "playwright";
import { afterAll } from "vitest";
import { steady } from "./steady.ts";
import { createServer, type Plugin, type ViteDevServer } from "vite";

const WEB = join(import.meta.dirname, "..");

// Signed in with a passkey check just now, under the "1h" step-up policy.
export const DESKTOP_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Desktop from "/src/lib/desktop/Desktop.svelte";
  mount(Desktop, { target: document.body, props: { device: "dev-1", office: "Test office", verifiedAt: Date.now(), policy: { stay: "7d", stepUp: "1h" }, desktop: false, onSignedOut: () => {} } });
</script></body></html>`;

export { steady };

export type Web = { url: string; browser: Browser; close: () => Promise<void> };

// A hook that times out while startWeb is still running never gets its Web back to close, and startWeb goes on in the
// background. So the file's last hook ends what is still starting (each step checks `over`, then releases what it made)
// and waits for it, then removes the cache dirs of what was never closed.
const live = new Set<string>();
const starting = new Set<Promise<unknown>>();
let over = false;
afterAll(async () => {
  over = true;
  await Promise.allSettled([...starting]);
  for (const dir of live) rmSync(dir, { recursive: true, force: true });
  live.clear();
});

export function startWeb(html = DESKTOP_PAGE): Promise<Web> {
  const started = start(html);
  starting.add(started);
  void started.then(() => starting.delete(started), () => starting.delete(started));
  return started;
}

async function start(html: string): Promise<Web> {
  const cacheDir = mkdtempSync(join(tmpdir(), "morndo-web-test-vite-"));
  live.add(cacheDir);
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  const release = async () => {
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    rmSync(cacheDir, { recursive: true, force: true });
    live.delete(cacheDir);
  };
  const stillWanted = () => { if (over) throw new Error("startWeb: the test file is over, so the server is not started"); };
  try {
    const page: Plugin = {
      name: "test-page",
      configureServer(devServer) {
        devServer.middlewares.use((req, res, next) => {
          if (new URL(req.url ?? "/", "http://test").pathname !== "/") return next();   // "/" with any query
          void devServer.transformIndexHtml("/", html).then(html => { res.setHeader("content-type", "text/html"); res.end(html); }, next);
        });
      },
    };
    server = await createServer({
      configFile: false, root: WEB, cacheDir, logLevel: "error", clearScreen: false,
      plugins: [svelte({ configFile: false }), page],
      // The SvelteKit modules a component here imports (Phone.svelte's goto, pushState, page): stand-ins that record
      // where the app asked to go and keep shallow-routing state the way Kit 2.70.3 does.
      resolve: { alias: {
        "$app/navigation": join(WEB, "test/app-navigation.stub.ts"),
        "$app/state": join(WEB, "test/app-state.stub.svelte.ts"),
        $lib: join(WEB, "src/lib"),
      } },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    stillWanted();
    await server.listen();
    stillWanted();
    browser = steady(await chromium.launch());
    stillWanted();
    const url = server.resolvedUrls?.local[0] ?? "";
    let closing: Promise<void> | undefined;
    return { url, browser, close: () => (closing ??= release()) };
  } catch (e) {
    await release();
    throw e;
  }
}

// The page's globals the fake feed adds. This file is type-checked without the DOM lib.
export type FeedWin = {
  __feedSent: unknown[];                      // every frame the app sent, parsed
  __feedPush: (m: unknown) => void;           // a frame from the hub, as JSON
  __feedRaw: (raw: string) => void;           // a frame from the hub, exactly as given
  __feedOpened: number;                       // how many feed sockets the app opened
  __feedAnswersPings?: boolean;               // false: the hub is half-open, pings go unanswered
  __feedRefuses?: boolean;                    // true: every new feed socket fails before it opens (as a refused upgrade does)
  __signedOut?: boolean;                      // true: GET /api/me answers 401
  __feedClose: (code: number) => void;        // the current feed socket closes with this code
  __answerCalls?: { url: string; body: unknown }[];   // every answer POST that reached the gate, body parsed
  __answerReplies?: { status: number; body?: unknown }[];   // the gate's replies, in order; 200 when it runs out
};

// Runs in the page before the app (addInitScript, ahead of fakeFeed): the hub's answer endpoint. Every POST to
// /api/escalations/<id>/answer is recorded with its parsed body (the request id included) and answered from the
// queue the test fills; anything else falls through to the real fetch — fakeFeed's own wrap included, which is why
// the gate goes in first.
export function answerGate() {
  const w = globalThis as unknown as FeedWin;
  w.__answerCalls = [];
  w.__answerReplies = [];
  const g = globalThis as { fetch: typeof fetch };
  const real = g.fetch.bind(globalThis);
  g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (/^\/api\/escalations\/[^/]+\/answer$/.test(new URL(url, "http://gate.test").pathname)) {
      const raw = typeof init?.body === "string" ? init.body : null;
      w.__answerCalls?.push({ url, body: raw === null ? null : JSON.parse(raw) });
      const next = w.__answerReplies?.shift() ?? { status: 200 };
      return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
    }
    return real(input, init);
  };
}

// `history`: each worker's messages (latest last); `older`: what lies before them in its transcript, for older pages;
// `olderMissing`: the hub can't read older pages (an unreadable transcript); `reading`: the hub's read marks and mutes
// at hello. Read and mute frames are told back, as the hub tells every feed. A worker's `offline` goes into the snapshot.
export type FeedOptions = {
  workers: { id: string; name: string; lastMessageAt?: number; offline?: boolean }[];
  history?: Record<string, unknown[]>;
  older?: Record<string, unknown[]>;
  olderMissing?: boolean;
  reading?: { reads: Record<string, number>; muted: string[] };
};

// Runs in the page before the app (addInitScript): a fake feed that answers hello with a snapshot and watch with the
// worker's conversation, like the hub; everything else comes from the test.
export function fakeFeed(o: FeedOptions) {
  type Socket = new (url: string | URL, protocols?: string | string[]) => unknown;
  const w = globalThis as unknown as FeedWin & { WebSocket: Socket };
  Object.assign(w, { __feedSent: [], __feedOpened: 0 });
  const roster = o.workers.map(x => ({ ...x, location: `/work/${x.name}`, title: null, lastMessageAt: x.lastMessageAt ?? null, needsYou: false, state: "quiet", changedAt: 0 }));
  const reading = { reads: { ...(o.reading?.reads ?? {}) }, muted: [...(o.reading?.muted ?? [])] };
  // Each worker's conversation as the hub keeps it, for this page's life: `history`, then every message pushed since in
  // a `messages` frame (a message with an id already there replaces it). The hub keeps a conversation whether or not a
  // feed watched it when the message came, and a watch answers with its latest (ObservationService.history), so a
  // message that came while the app showed another view is there when the conversation is opened.
  const conversation: Record<string, unknown[]> = Object.fromEntries(Object.entries(o.history ?? {}).map(([k, v]) => [k, [...v]]));
  const keep = (m: unknown) => {
    const f = m as { t?: unknown; worker?: unknown; messages?: unknown };
    if (f.t !== "messages" || typeof f.worker !== "string" || !Array.isArray(f.messages)) return;
    const held = (conversation[f.worker] ??= []) as { id?: unknown }[];
    for (const x of f.messages as { id?: unknown }[]) { const i = held.findIndex(y => y.id === x.id); if (i === -1) held.push(x); else held[i] = x; }
  };
  class Feed {
    readyState = 0;
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    constructor() {
      w.__feedOpened++;
      w.__feedPush = (m: unknown) => { keep(m); this.raw(JSON.stringify(m)); };
      w.__feedRaw = (raw: string) => this.raw(raw);
      w.__feedClose = (code: number) => { this.readyState = 3; this.onclose?.({ code }); };
      if (w.__feedRefuses) { setTimeout(() => { this.readyState = 3; this.onclose?.({ code: 1006 }); }, 0); return; }
      setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0);
    }
    send(raw: string) {
      const m = JSON.parse(raw) as { t: string; worker?: string | null; conversation?: string; at?: number; muted?: boolean; before?: string };
      w.__feedSent.push(m);
      if (m.t === "hello") {
        this.raw(JSON.stringify({ t: "snapshot", epoch: "e1", seq: 0, workers: roster }));
        this.raw(JSON.stringify({ t: "reading", ...reading }));
      }
      if (m.t === "read" && m.conversation && typeof m.at === "number" && m.at > (reading.reads[m.conversation] ?? 0)) {
        reading.reads[m.conversation] = m.at;
        this.raw(JSON.stringify({ t: "read", conversation: m.conversation, at: m.at }));
      }
      if (m.t === "mute" && m.conversation) {
        reading.muted = m.muted ? [...new Set([...reading.muted, m.conversation])] : reading.muted.filter(c => c !== m.conversation);
        this.raw(JSON.stringify({ t: "mute", conversation: m.conversation, muted: !!m.muted }));
      }
      if (m.t === "older" && m.worker && m.before && o.olderMissing) {
        this.raw(JSON.stringify({ t: "older", worker: m.worker, before: m.before, messages: [], done: false, missing: true }));
      } else if (m.t === "older" && m.worker && m.before) {
        const all = [...(o.older?.[m.worker] ?? []), ...(conversation[m.worker] ?? [])] as { id: string }[];
        const at = all.findIndex(x => x.id === m.before);
        const page = at === -1 ? [] : all.slice(Math.max(0, at - 100), at);
        this.raw(JSON.stringify({ t: "older", worker: m.worker, before: m.before, messages: page, done: at <= 100 }));
      }
      if (m.t === "ping" && w.__feedAnswersPings !== false) this.raw(JSON.stringify({ t: "pong", n: (m as unknown as { n: number }).n }));
      if (m.t === "watch" && m.worker) this.raw(JSON.stringify({ t: "history", worker: m.worker, messages: conversation[m.worker] ?? [], session: null }));
    }
    raw(data: string) { setTimeout(() => this.onmessage?.({ data }), 0); }
    close() { this.readyState = 3; }
  }
  const g = globalThis as unknown as { fetch: typeof fetch };
  const realFetch = g.fetch.bind(globalThis);
  g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (url === "/api/me") return new Response(JSON.stringify(w.__signedOut ? { error: "signed_out" } : {}), { status: w.__signedOut ? 401 : 200 });
    return realFetch(input, init);
  };
  const RealWebSocket = w.WebSocket;
  const FakeWebSocket = function (url: string | URL, protocols?: string | string[]) {
    return String(url).includes("/api/feed") ? new Feed() : new RealWebSocket(url, protocols);
  } as unknown as Socket;
  Object.assign(FakeWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  w.WebSocket = FakeWebSocket;
}
