// The app against a fleet hub (spec §4; ADR-0012), in headless Chromium with its real IndexedDB:
// - workers are named `<node>.<server>.<pane>`;
// - an outbox an older app left may still hold a Command for a legacy `%N`. That entry fails as no_pane (the fleet hub
//   has no such worker), with no error on the page;
// - a conversation with a new id works end to end: its frames decode, and a message is posted to its id and ended by its
//   echo.
// The real Desktop client, a fake feed (harness.ts), and a fake send endpoint that answers as a fleet hub does.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

const PC = "pc.3fa2c1d0.1";
type FleetWin = FeedWin & { __sends: string[] };
type Row = { worker: string; state: string; error: string | null };

// Runs in the page before the app: POST /api/workers/<id>/send as a fleet hub answers it.
function fleetHub() {
  const w = globalThis as unknown as FleetWin & { fetch: typeof fetch };
  w.__sends = [];
  const inner = w.fetch.bind(w);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  w.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const m = /^\/api\/workers\/([^/]+)\/send$/.exec(url);
    if (!m) return inner(input, init);
    const worker = decodeURIComponent(m[1] ?? "");
    w.__sends.push(worker);
    if (/^%\d+$/.test(worker)) return json({ error: "no_pane" }, 404);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { requestId: string; text: string };
    w.__feedPush({ t: "messages", worker, messages: [{ id: `echo-${body.requestId}`, at: Date.now(), author: { kind: "principal", name: "You" }, kind: "text", text: body.text }] });
    return json({ ok: true, at: Date.now() });
  };
}

// Runs in the page: one record put into the outbox's IndexedDB store, as an older app left it.
async function seed(r: Record<string, unknown>) {
  const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open("morndo", 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains("outbox")) req.result.createObjectStore("outbox", { keyPath: "id" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("open failed"));
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("outbox", "readwrite");
    tx.objectStore("outbox").put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("write failed"));
  });
  db.close();
}
// Runs in the page: every record in the outbox's store.
async function rows(): Promise<Row[]> {
  const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open("morndo", 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("open failed"));
  });
  const all = await new Promise<unknown[]>((resolve, reject) => {
    const req = db.transaction("outbox", "readonly").objectStore("outbox").getAll();
    req.onsuccess = () => resolve(req.result as unknown[]);
    req.onerror = () => reject(req.error ?? new Error("read failed"));
  });
  db.close();
  return all as Row[];
}

let web: Web;
let tab: Page;
let errors: string[];
beforeAll(async () => { web = await startWeb(); }, 60_000);
afterAll(async () => { await web?.close(); });
beforeEach(async () => {
  const context = await web.browser.newContext();                     // a fresh IndexedDB per test
  tab = await context.newPage();
  errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.addInitScript(fakeFeed, { workers: [{ id: "pc.3fa2c1d0.0", name: "manager" }, { id: PC, name: "alpha" }] });
  await tab.addInitScript(fleetHub);
}, 60_000);
afterEach(async () => { await tab.context().close(); });

describe("the app against a fleet hub", () => {
  it("an older app's %N entry fails as no_pane; a worker id conversation sends and is echoed; no page errors", { timeout: 30_000 }, async () => {
    await tab.goto(web.url);
    await tab.locator("button.row", { hasText: "alpha" }).first().waitFor();
    const now = await tab.evaluate(() => Date.now());
    await tab.evaluate(seed, {
      id: "00000000-0000-4000-8000-0000000000aa", worker: "%1", workerName: "alpha", text: "from an older app", uploads: [],
      createdAt: now, budgetFrom: now, state: "queued", error: null, attempts: 0, seen: "none", sentAt: null, hubAt: null,
    });
    await tab.reload();                                                 // the outbox resumes what IndexedDB holds
    await tab.waitForFunction(() => (globalThis as unknown as FleetWin).__sends.includes("%1"));
    await expect.poll(async () => (await tab.evaluate(rows)).find(r => r.worker === "%1"), { timeout: 10_000 }).toMatchObject({ state: "failed", error: "no_pane" });
    await tab.locator("button.row", { hasText: "alpha" }).first().click();
    await tab.getByRole("heading", { level: 1, name: "alpha", exact: true }).waitFor();
    const box = tab.getByRole("textbox", { name: "Message alpha" });
    await box.fill("hello from the fleet");
    await box.press("Enter");
    await tab.locator("article.msg:not(.pending)", { hasText: "hello from the fleet" }).waitFor({ timeout: 10_000 });
    expect(await tab.evaluate(() => (globalThis as unknown as FleetWin).__sends)).toEqual(["%1", PC]);
    expect(errors).toEqual([]);
  });
});
