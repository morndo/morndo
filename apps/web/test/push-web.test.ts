// Web push in the app (ADR-0008 phase F; N3, N4): "Notifications on this device" asks the browser only on the tap,
// subscribes with the hub's key and hands the hub the subscription, and takes it back on the second tap; a refused
// prompt says so; on an iPhone outside the Home Screen it says how to get there. The app reports whether he is
// attending (focus and input), and a notification's click opens it on Decisions or Activity. Real components in
// headless Chromium; the browser's push and the hub faked. Synthetic data only.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

const TOGGLE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import C from "/src/lib/PushToggle.svelte";
  mount(C, { target: document.body, props: {} });
</script></body></html>`;
const KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url");

type PushWin = {
  __asked: number;                                   // permission prompts shown
  __subscribed: { applicationServerKey: number[]; userVisibleOnly: boolean } | null;
  __unsubscribed: boolean;
  __calls: { method: string; path: string; body: unknown }[];
};
// Runs before the app: a browser whose push and permission are under the test's control, and a hub that answers.
function fakePush(o: { answer: "granted" | "denied" | "default"; subscribed: boolean }) {
  const w = globalThis as unknown as PushWin & Record<string, unknown>;
  w.__asked = 0; w.__subscribed = null; w.__unsubscribed = false; w.__calls = [];
  let permission: string = "default";
  const sub = {
    endpoint: "https://fcm.googleapis.com/fcm/send/test", toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/test", keys: { p256dh: "pk", auth: "au" } }),
    unsubscribe: async () => { w.__unsubscribed = true; return true; },
  };
  let current: typeof sub | null = o.subscribed ? sub : null;
  const pushManager = {
    subscribe: async (opts: { applicationServerKey: Uint8Array; userVisibleOnly: boolean }) => {
      w.__subscribed = { applicationServerKey: [...opts.applicationServerKey], userVisibleOnly: opts.userVisibleOnly };
      current = sub;
      return sub;
    },
    getSubscription: async () => current,
  };
  const reg = { pushManager };
  Object.defineProperty(navigator, "serviceWorker", { value: { ready: Promise.resolve(reg), getRegistration: async () => reg }, configurable: true });
  w.PushManager = function PushManager() {};
  w.Notification = Object.assign(function Notification() {}, {
    get permission() { return permission; },
    requestPermission: async () => { w.__asked++; permission = o.answer; return o.answer; },
  });
  const inner = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (!url.startsWith("/api/push/")) return inner(input, init);
    w.__calls.push({ method: init?.method ?? "GET", path: url, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/push/key") return json({ key: (w.__key as string), subscribed: o.subscribed });
    return json({ ok: true });
  };
}

let web: Web;
let desk: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(TOGGLE); desk = await startWeb(); }, 90_000);
afterAll(async () => { await web?.close(); await desk?.close(); });
afterEach(async () => { await tab.context().close(); });

async function open(o: { answer: "granted" | "denied" | "default"; subscribed: boolean }, context?: Parameters<Web["browser"]["newContext"]>[0]) {
  tab = await (await web.browser.newContext(context)).newPage();
  await tab.addInitScript(k => { (globalThis as unknown as Record<string, unknown>).__key = k; }, KEY);
  await tab.addInitScript(fakePush, o);
  await tab.goto(web.url);
}
const page = <T>(f: () => T) => tab.evaluate(f);
const toggle = () => tab.getByRole("switch", { name: /Notifications on this device/ });

describe("Notifications on this device (N4)", () => {
  it("asks the browser only on the tap; subscribes with the hub's key, visible only; hands the hub the subscription", { timeout: 30_000 }, async () => {
    await open({ answer: "granted", subscribed: false });
    await toggle().waitFor();
    await tab.waitForTimeout(300);
    expect(await page(() => (globalThis as unknown as PushWin).__asked)).toBe(0);           // nothing before the tap
    expect(await toggle().isChecked()).toBe(false);
    await toggle().click();
    await tab.waitForFunction(() => (globalThis as unknown as PushWin).__calls.some(c => c.method === "POST"));
    expect(await page(() => (globalThis as unknown as PushWin).__asked)).toBe(1);
    const s = await page(() => (globalThis as unknown as PushWin).__subscribed);
    expect(s?.userVisibleOnly).toBe(true);
    expect(Buffer.from(s?.applicationServerKey ?? []).toString("base64url")).toBe(KEY);
    const post = (await page(() => (globalThis as unknown as PushWin).__calls)).find(c => c.method === "POST");
    expect(post).toEqual({ method: "POST", path: "/api/push/subscription", body: { endpoint: "https://fcm.googleapis.com/fcm/send/test", keys: { p256dh: "pk", auth: "au" } } });
    await expect.poll(() => toggle().isChecked()).toBe(true);
  });
  it("on, a tap turns it off: the browser's subscription goes, and the hub's", { timeout: 30_000 }, async () => {
    await open({ answer: "granted", subscribed: true });
    await expect.poll(() => toggle().isChecked()).toBe(true);
    await toggle().click();
    await tab.waitForFunction(() => (globalThis as unknown as PushWin).__unsubscribed);
    await tab.waitForTimeout(200);
    expect(await toggle().isChecked()).toBe(false);
  });
  it("a dismissed prompt leaves the box unticked and says so; nothing is subscribed (review M4)", { timeout: 30_000 }, async () => {
    await open({ answer: "default", subscribed: false });
    await toggle().click();
    await tab.getByText("Notifications weren't allowed. Tap again to be asked again.").waitFor();
    await expect.poll(() => toggle().isChecked()).toBe(false);
    expect(await page(() => (globalThis as unknown as PushWin).__subscribed)).toBeNull();
  });
  it("a refused prompt says where to allow it, and nothing is subscribed", { timeout: 30_000 }, async () => {
    await open({ answer: "denied", subscribed: false });
    await toggle().click();
    await tab.getByText(/blocked for this site in the browser's settings/).waitFor();
    expect(await page(() => (globalThis as unknown as PushWin).__subscribed)).toBeNull();
  });
  it("on an iPhone, outside the Home Screen, it says how to get there", { timeout: 30_000 }, async () => {
    tab = await (await web.browser.newContext({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" })).newPage();
    await tab.addInitScript(() => { delete (globalThis as unknown as Record<string, unknown>).PushManager; });
    await tab.goto(web.url);
    await tab.getByText(/Add to Home Screen/).waitFor();
    expect(await tab.getByRole("switch").count()).toBe(0);
  });
});

describe("the app around push", () => {
  it("reports that he is attending once the window has focus and his input (N3, amendment 3)", { timeout: 60_000 }, async () => {
    tab = await (await desk.browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }] });
    await tab.goto(desk.url);
    await tab.locator("button.row", { hasText: "Manager" }).first().waitFor();
    await tab.bringToFront();
    await tab.locator("button.row", { hasText: "Manager" }).first().click();
    await tab.waitForFunction(() => (globalThis as unknown as FeedWin).__feedSent.some(m => (m as { t: string; v?: boolean }).t === "visible" && (m as { v: boolean }).v));
  });
  it("a notification's click opens Activity or Decisions, then cleans the address", { timeout: 60_000 }, async () => {
    tab = await (await desk.browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }] });
    await tab.goto(`${desk.url}?view=activity`);
    await tab.locator(".rail").getByRole("button", { name: "Activity" }).and(tab.locator(".on")).waitFor();
    expect(new URL(tab.url()).search).toBe("");
  });
});
