// Adding a device in the app (ADR-0008 phase E; AC10–AC13): "Add a device" shows a QR code, the link with the
// pinned hub identity, Copy and the code, and says when a device was added; "Link with a signed-in device" shows the
// address to approve and the code, asks with its own secret until it is answered, then goes to the pairing page,
// or says it was denied or expired. The real components in headless Chromium, the hub faked at fetch. Synthetic data
// only. (Every device hearing that one was added: linked-notice-web.test.ts.)
import { createHmac } from "node:crypto";
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const mountPage = (component: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import C from "/src/lib/${component}.svelte";
  mount(C, { target: document.body, props: {} });
</script></body></html>`;

type HubWin = {
  __calls: { method: string; path: string; secret: string | null; background?: true }[];
  __answers: Record<string, unknown[]>;         // per "METHOD path": the bodies to answer with, in order; the last repeats
};
// Runs in the page before the app: answers the hub's routes from __answers and keeps every call.
function fakeHub(answers: Record<string, unknown[]>) {
  const w = globalThis as unknown as HubWin & { fetch: typeof fetch };
  w.__calls = [];
  w.__answers = answers;
  const inner = w.fetch.bind(w);
  w.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? "GET";
    const key = `${method} ${url.replace(/[0-9a-f-]{36}/, ":id")}`;
    const list = w.__answers[key];
    if (!list) return inner(input, init);
    const headers = new Headers(init?.headers);
    w.__calls.push({ method, path: url, secret: headers.get("x-morndo-link-secret"), ...(headers.get("x-morndo-background") === "1" ? { background: true as const } : {}) });
    const next = (list.length > 1 ? list.shift() : list[0]) as { status?: number; body: unknown };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  };
}

const ID = "3f1c2d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f";
const FP = "ab".repeat(32);
let web: Web;
let pageWeb: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(mountPage("LinkRequest")); pageWeb = await startWeb(mountPage("AddDevice")); }, 90_000);
afterAll(async () => { await web?.close(); await pageWeb?.close(); });
afterEach(async () => { await tab.context().close(); });

async function open(w: Web, answers: Record<string, unknown[]>, before?: () => void) {
  const context = await w.browser.newContext({ viewport: { width: 420, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(w.url).origin });
  tab = await context.newPage();
  if (before) await tab.addInitScript(before);
  await tab.addInitScript(fakeHub, answers);
  await tab.goto(w.url);
}
const calls = () => tab.evaluate(() => (globalThis as unknown as HubWin).__calls);
const future = () => Date.now() + 10 * 60_000;

describe("Link with a signed-in device (AC11)", () => {
  // The approving device's proof, as /link computes it: HMAC-SHA256 of the fingerprint under the QR code's key.
  const proofFor = (key: string, fingerprint: string) => createHmac("sha256", Buffer.from(key, "base64url")).update(fingerprint).digest("base64url");
  const answerWith = (body: unknown) => tab.evaluate(b => { (globalThis as unknown as HubWin).__answers["GET /api/link/:id"] = [{ body: b }]; }, body);
  async function askAndRead() {
    await tab.getByRole("button", { name: "Link with a signed-in device" }).click();
    const box = tab.getByRole("textbox", { name: "Address to approve this device" });
    await box.waitFor();
    return box.inputValue();
  }
  it("shows the address to approve with a key the hub never sees, and the code; goes on to pairing once approved with a matching proof", { timeout: 30_000 }, async () => {
    await open(web, {
      "POST /api/link": [{ body: { requestId: ID, secret: "the-secret", code: "424242", expiresAt: future() } }],
      "GET /api/link/:id": [{ body: { state: "waiting" } }],
    });
    const address = await askAndRead();
    // The drawn code itself: its placeholder while uqr loads has the same name (a race lane-b saw at load ~17).
    await tab.locator("svg.qr").waitFor();
    expect(await tab.locator("svg.qr").count()).toBe(1);
    await tab.getByText("424 242").waitFor();
    const origin = new URL(web.url).origin;
    const m = new RegExp(`^${origin}/link#r=${ID}&k=([A-Za-z0-9_-]{22})$`).exec(address);
    expect(m).not.toBeNull();
    expect((await calls()).some(c => c.path.includes(m?.[1] ?? "?"))).toBe(false);             // the key never went to the hub
    await tab.getByRole("button", { name: "Copy" }).click();
    expect(await tab.evaluate(() => navigator.clipboard.readText())).toBe(address);
    await answerWith({ state: "approved", token: "tok-1", fingerprint: FP, proof: proofFor(m?.[1] ?? "", FP) });
    await tab.waitForURL(/\/pair#/, { timeout: 10_000 });
    expect(tab.url()).toBe(`${origin}/pair#t=tok-1&f=${FP}`);
  });
  it("a fingerprint without the approving device's proof, or with a wrong one, isn't trusted: it stays, and says so (review M1)", { timeout: 30_000 }, async () => {
    await open(web, {
      "POST /api/link": [{ body: { requestId: ID, secret: "s", code: "424242", expiresAt: future() } }],
      "GET /api/link/:id": [{ body: { state: "waiting" } }],
    });
    const key = /&k=([\w-]+)$/.exec(await askAndRead())?.[1] ?? "";
    await answerWith({ state: "approved", token: "tok-1", fingerprint: "cd".repeat(32), proof: proofFor(key, FP) });   // the hub swapped it
    await tab.getByText(/Don't pair here/).waitFor({ timeout: 10_000 });
    expect(tab.url()).not.toMatch(/\/pair/);
    await tab.context().close();
    await open(web, {
      "POST /api/link": [{ body: { requestId: ID, secret: "s", code: "424242", expiresAt: future() } }],
      "GET /api/link/:id": [{ body: { state: "approved", token: "tok-1", fingerprint: FP, proof: null } }],
    });
    await askAndRead();
    await tab.getByText(/Don't pair here/).waitFor({ timeout: 10_000 });
    expect(tab.url()).not.toMatch(/\/pair/);
  });
  it("Cancel ends the request on the hub with its own secret, so its place is free", { timeout: 30_000 }, async () => {
    await open(web, {
      "POST /api/link": [{ body: { requestId: ID, secret: "the-secret", code: "424242", expiresAt: future() } }],
      "GET /api/link/:id": [{ body: { state: "waiting" } }],
      "POST /api/link/:id/cancel": [{ body: { ok: true } }],
    });
    await askAndRead();
    await tab.getByRole("button", { name: "Cancel" }).click();
    await tab.waitForFunction(() => (globalThis as unknown as HubWin).__calls.some(c => c.path.endsWith("/cancel")));
    expect((await calls()).find(c => c.path.endsWith("/cancel"))).toEqual({ method: "POST", path: `/api/link/${ID}/cancel`, secret: "the-secret" });
    await tab.getByRole("button", { name: "Link with a signed-in device" }).waitFor();
  });
  it("every poll carries the secret, and only in a header", { timeout: 30_000 }, async () => {
    await open(web, {
      "POST /api/link": [{ body: { requestId: ID, secret: "the-secret", code: "424242", expiresAt: future() } }],
      "GET /api/link/:id": [{ body: { state: "waiting" } }],
    });
    await tab.getByRole("button", { name: "Link with a signed-in device" }).click();
    await tab.waitForFunction(() => (globalThis as unknown as HubWin).__calls.filter(c => c.method === "GET").length >= 2, undefined, { timeout: 10_000 });
    const polls = (await calls()).filter(c => c.method === "GET");
    expect(polls.every(c => c.secret === "the-secret" && c.path === `/api/link/${ID}`)).toBe(true);
  });
  it("a wrong code typed on the other device: says this request ended, and can ask again (amendment 11)", { timeout: 30_000 }, async () => {
    await open(web, {
      "POST /api/link": [{ body: { requestId: ID, secret: "s", code: "111222", expiresAt: future() } }],
      "GET /api/link/:id": [{ body: { state: "mistyped" } }],
    });
    await tab.getByRole("button", { name: "Link with a signed-in device" }).click();
    await tab.getByText("The code typed on the other device didn't match, so this request ended. Ask again.").waitFor({ timeout: 10_000 });
    await tab.getByRole("button", { name: "Ask again" }).waitFor();
  });
  it("denied: says so, and can ask again", { timeout: 30_000 }, async () => {
    await open(web, {
      "POST /api/link": [{ body: { requestId: ID, secret: "s", code: "111222", expiresAt: future() } }],
      "GET /api/link/:id": [{ body: { state: "denied" } }],
    });
    await tab.getByRole("button", { name: "Link with a signed-in device" }).click();
    await tab.getByText("The other device said no. Nothing was added.").waitFor({ timeout: 10_000 });
    await tab.getByRole("button", { name: "Ask again" }).waitFor();
  });
  it("expired (or no longer known): says so, and can ask again", { timeout: 30_000 }, async () => {
    await open(web, {
      "POST /api/link": [{ body: { requestId: ID, secret: "s", code: "111222", expiresAt: future() } }],
      "GET /api/link/:id": [{ status: 404, body: { error: "unknown" } }],
    });
    await tab.getByRole("button", { name: "Link with a signed-in device" }).click();
    await tab.getByText("That request expired; they last 10 minutes.").waitFor({ timeout: 10_000 });
    await tab.getByRole("button", { name: "Ask again" }).waitFor();
  });
  it("three devices already asking: says to try again later", { timeout: 30_000 }, async () => {
    await open(web, { "POST /api/link": [{ status: 409, body: { error: "too_many" } }] });
    await tab.getByRole("button", { name: "Link with a signed-in device" }).click();
    await tab.getByText("Three devices are already asking to be added. Try again in a few minutes.").waitFor();
  });
});

describe("Add a device (AC10)", () => {
  const pin = () => localStorage.setItem("morndo.pin", JSON.stringify({ fingerprint: "ab".repeat(32), device: "phone", pairedAt: 1 }));
  const TOKEN = "00000000-0000-4000-8000-0000000000a1";              // a synthetic token id
  it("shows the QR code, the link with this device's pinned hub identity, Copy and the code, then which device used it", { timeout: 30_000 }, async () => {
    const expiresAt = future();
    await open(pageWeb, {
      "POST /api/devices/add": [{ body: { tokenId: TOKEN, secret: "tok-2", code: "070707", expiresAt } }],
      "GET /api/devices/add/:id": [{ body: { name: null } }, { body: { name: "laptop" } }],
    }, pin);
    await tab.getByRole("button", { name: "Add a device" }).click();
    await tab.locator("svg.qr").waitFor();                                          // the drawn code, not its placeholder
    expect(await tab.locator("svg.qr").count()).toBe(1);
    expect(await tab.getByRole("img", { name: "Pairing code for a new device" }).count()).toBe(1);
    await tab.getByText("070 707").waitFor();
    const link = `${new URL(pageWeb.url).origin}/pair#t=tok-2&f=${FP}`;
    expect(await tab.getByRole("textbox", { name: "Pairing link" }).inputValue()).toBe(link);
    await tab.getByRole("button", { name: "Copy" }).click();
    expect(await tab.evaluate(() => navigator.clipboard.readText())).toBe(link);
    await tab.getByText(/was added/).waitFor({ timeout: 10_000 });
    expect(await tab.locator(".ok strong").innerText()).toBe("laptop");
    const asks = (await calls()).filter(c => c.method === "GET");
    expect(asks.length).toBeGreaterThan(0);
    expect(asks.every(c => c.path === `/api/devices/add/${TOKEN}` && c.background === true)).toBe(true);   // its own token; not use (M3)
  });
  it("Cancel withdraws the token on the hub", { timeout: 30_000 }, async () => {
    await open(pageWeb, {
      "POST /api/devices/add": [{ body: { tokenId: TOKEN, secret: "tok-4", code: "070707", expiresAt: future() } }],
      "GET /api/devices/add/:id": [{ body: { name: null } }],
      "POST /api/devices/add/:id/cancel": [{ body: {} }],
    }, pin);
    await tab.getByRole("button", { name: "Add a device" }).click();
    await tab.getByRole("button", { name: "Cancel" }).click();
    await tab.waitForFunction(() => (globalThis as unknown as HubWin).__calls.some(c => c.path.endsWith("/cancel")));
    expect((await calls()).find(c => c.path.endsWith("/cancel"))?.path).toBe(`/api/devices/add/${TOKEN}/cancel`);
  });
  it("a device that hasn't kept the hub's identity can't vouch for it: no token is asked for", { timeout: 30_000 }, async () => {
    await open(pageWeb, { "POST /api/devices/add": [{ body: { tokenId: TOKEN, secret: "x", code: "070707", expiresAt: future() } }] });
    await tab.getByRole("button", { name: "Add a device" }).click();
    await tab.getByText(/hasn't kept the hub's identity/).waitFor();
    expect(await calls()).toEqual([]);
  });
  it("counts down by the hub's 10 minutes and, when they run out, says so and offers a new one", { timeout: 30_000 }, async () => {
    // The hub's clock is 5 minutes behind this device's: the countdown still starts at 10:00.
    await open(pageWeb, {
      "POST /api/devices/add": [{ body: { tokenId: TOKEN, secret: "tok-3", code: "070707", expiresAt: Date.now() - 5 * 60_000 + 10 * 60_000 } }],
      "GET /api/devices/add/:id": [{ body: { name: null } }],
    }, pin);
    await tab.clock.install();
    await tab.getByRole("button", { name: "Add a device" }).click();
    await tab.getByText("070 707").waitFor();
    await tab.getByText(/for (10:00|9:5\d) more/).waitFor();                    // never 10:01 (QA screenshot)
    await tab.clock.fastForward("10:01");
    await tab.getByText("That code expired. Make a new one.").waitFor({ timeout: 10_000 });
    await tab.getByRole("button", { name: "Add a device" }).waitFor();
    const asked = (await calls()).filter(c => c.method === "GET").length;
    await tab.clock.fastForward("05:00");
    expect((await calls()).filter(c => c.method === "GET").length).toBe(asked);   // no more asking after it ran out (M3)
  });
});
