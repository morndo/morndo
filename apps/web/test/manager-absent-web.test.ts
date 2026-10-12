// The manager is always on the list (the owner, 2026-10-12): while it has no window (a restart), the desktop and the
// phone list it as not running. With the hub's queue on, a message to it is written as to any lane, without files, and
// goes to POST /api/manager/send (the hub queues it for the manager's sticky lane); with the queue off, the box is shut.
// A hub from before (no `manager` frame) lists it only while it has a window. Real client in headless Chromium, fake
// feed and a fake send endpoint (harness.ts).
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

// The phone, mounted on its own (as fleet-unavailable-web.test.ts does): signed in with a passkey check just now.
const PHONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Phone from "/src/lib/phone/Phone.svelte";
  mount(Phone, { target: document.body, props: { device: "phone-1", verifiedAt: Date.now(), policy: { stay: "7d", stepUp: "1h" }, onSignedOut: () => {} } });
</script></body></html>`;

let web: Web;
let phone: Web;
let tab: Page;
let errors: string[];
let posts: { path: string; body: Record<string, unknown> }[];
beforeAll(async () => { [web, phone] = await Promise.all([startWeb(), startWeb(PHONE_PAGE)]); }, 60_000);
afterAll(async () => { await Promise.all([web?.close(), phone?.close()]); });
afterEach(async () => { await tab.context().close(); });

async function open(width: number) {
  const app = width < 900 ? phone : web;
  const context = await app.browser.newContext({ viewport: { width, height: 860 } });
  tab = await context.newPage();
  errors = [];
  posts = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.addInitScript(fakeFeed, { workers: [{ id: "%1", name: "alpha" }] });
  await tab.route(/\/api\/(manager|workers\/[^/]+)\/send$/, async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    posts.push({ path: new URL(route.request().url()).pathname, body });
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, at: Date.now(), delivery: { requestId: body.requestId, state: "queued", waiting: "no_pane", why: null } }) });
  });
  await tab.goto(app.url);
}
const push = (m: unknown) => tab.evaluate(x => (globalThis as unknown as FeedWin).__feedPush(x), m);

describe("the desktop", () => {
  it("lists the manager as not running; with the queue on, a message to it goes to its role, without files", { timeout: 30_000 }, async () => {
    await open(1400);
    await tab.locator("button.row", { hasText: "alpha" }).first().waitFor();
    expect(await tab.locator("button.row", { hasText: "Manager" }).count()).toBe(0);     // a hub from before: no frame, no row
    await push({ t: "manager", queue: true });
    const row = tab.locator("button.row", { hasText: "Manager" }).first();
    await row.waitFor();
    expect(await row.innerText()).toContain("not running");
    await row.click();
    await tab.locator("[data-absent]").waitFor();
    expect(await tab.locator("[data-absent]").innerText()).toContain("waits for it, up to a day");
    expect(await tab.getByRole("button", { name: "Attach a file" }).count()).toBe(0);
    expect(await tab.getByRole("tab", { name: "Terminal" }).count()).toBe(0);
    const box = tab.getByRole("textbox", { name: "Message Manager" });
    await box.fill("while it restarts");
    await box.press("Enter");
    await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(1);
    expect(posts[0]).toMatchObject({ path: "/api/manager/send", body: { text: "while it restarts", seen: "none" } });
    await tab.locator("article.pending", { hasText: "while it restarts" }).waitFor();   // its entry stays in the manager's chat
    expect(errors).toEqual([]);
  });

  it("with the queue off, the box is shut and says to start the manager (negative control: nothing is sent)", { timeout: 30_000 }, async () => {
    await open(1400);
    await tab.locator("button.row", { hasText: "alpha" }).first().waitFor();
    await push({ t: "manager", queue: false });
    await tab.locator("button.row", { hasText: "Manager" }).first().click();
    await tab.locator("[data-absent]", { hasText: "Start it to message it" }).waitFor();
    expect(await tab.getByRole("textbox", { name: "Message Manager" }).isDisabled()).toBe(true);
    expect(posts).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("when the manager's window is back, the chat moves to it, and what was written meanwhile stays with it", { timeout: 30_000 }, async () => {
    await open(1400);
    await tab.locator("button.row", { hasText: "alpha" }).first().waitFor();
    await push({ t: "manager", queue: true });
    await tab.locator("button.row", { hasText: "Manager" }).first().click();
    const box = tab.getByRole("textbox", { name: "Message Manager" });
    await box.fill("written while it was gone");
    await box.press("Enter");
    await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(1);
    await push({ t: "events", events: [{ epoch: "e1", seq: 1, at: 1, body: { type: "WorkerAppeared", worker: { id: "%7", name: "manager", location: "/work/manager", node: "" }, state: "quiet", changedAt: 1, offline: false } }] });
    await tab.locator("[data-absent]").waitFor({ state: "detached" });
    await tab.locator("article.pending", { hasText: "written while it was gone" }).waitFor();
    expect(errors).toEqual([]);
  });
});

describe("the phone", () => {
  it("lists the manager pinned and not running; its chat says a message waits, and sends to its role", { timeout: 30_000 }, async () => {
    await open(390);
    await tab.locator('[data-chat="alpha"]').waitFor();
    await push({ t: "manager", queue: true });
    const row = tab.locator('[data-chat="manager"]');
    await row.waitFor();
    expect(await tab.locator("[data-chat]").first().getAttribute("data-chat")).toBe("manager");   // pinned first
    expect(await row.innerText()).toContain("Not running");
    await row.click();
    const convo = tab.getByRole("region", { name: "Conversation with Manager" });
    await convo.locator("[data-absent]").waitFor();
    expect(await convo.getByRole("tab", { name: "Screen" }).count()).toBe(0);
    expect(await convo.getByRole("button", { name: "Attach a file" }).count()).toBe(0);
    await convo.getByRole("textbox", { name: "Message Manager" }).fill("from the phone");
    await convo.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(1);
    expect(posts[0]).toMatchObject({ path: "/api/manager/send", body: { text: "from the phone" } });
    expect(errors).toEqual([]);
  });
});
