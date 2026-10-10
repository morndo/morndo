// AC13 in the app (ADR-0008 phase E): when a device is added from a signed-in one or a Link request, every device
// shows a notice with its name, which opens the Devices tab or can be dismissed. The real Desktop in headless
// Chromium, the feed faked (harness.ts). Synthetic data only.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

let desk: Web;
let tab: Page;
beforeAll(async () => { desk = await startWeb(); }, 60_000);
afterAll(async () => { await desk?.close(); });
afterEach(async () => { await tab.context().close(); });

describe("every device hears that one was added (AC13)", () => {
  it("a notice with the device's name; Review devices opens the Devices tab; a later one can be dismissed", { timeout: 60_000 }, async () => {
    const context = await desk.browser.newContext({ viewport: { width: 1600, height: 900 } });
    tab = await context.newPage();
    await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }] });
    await tab.goto(desk.url);
    await tab.locator("button.row", { hasText: "Manager" }).first().waitFor();
    const at = Date.now();
    await tab.evaluate(t => (globalThis as unknown as FeedWin).__feedPush({ t: "linked", name: "laptop", at: t, by: "phone" }), at);
    const notice = tab.getByRole("status").filter({ hasText: "A device was added: laptop, from phone" });
    await notice.waitFor();
    await notice.getByRole("button", { name: "Review devices" }).click();
    // Seen here: the hub stops telling this device (review M2).
    expect(await tab.evaluate(() => (globalThis as unknown as FeedWin).__feedSent.filter(m => (m as { t: string }).t === "linked_seen"))).toEqual([{ t: "linked_seen", at }]);
    await tab.getByRole("tab", { name: "Devices", selected: true }).waitFor();
    await notice.waitFor({ state: "detached" });
    await tab.keyboard.press("Escape");                                // the dialog closes; the page is live again
    await tab.getByRole("tab", { name: "Devices" }).waitFor({ state: "detached" });
    await tab.evaluate(() => (globalThis as unknown as FeedWin).__feedPush({ t: "linked", name: "tablet", at: Date.now() + 1 }));
    const second = tab.getByRole("status").filter({ hasText: "tablet" });
    await second.getByRole("button", { name: "Dismiss" }).click();
    await second.waitFor({ state: "detached" });
  });
});

describe("a device added from another, not verified yet (AC12; review L3)", () => {
  let fresh: Web;
  beforeAll(async () => {
    fresh = await startWeb(`<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
      import { mount } from "svelte";
      import Desktop from "/src/lib/desktop/Desktop.svelte";
      mount(Desktop, { target: document.body, props: { device: "laptop", office: "Test office", verifiedAt: 0, policy: { stay: "7d", stepUp: "signin" }, desktop: false, onSignedOut: () => {} } });
    </script></body></html>`);
  }, 60_000);
  afterAll(async () => { await fresh?.close(); });
  it("under 'only when I sign in', the composer still asks for the passkey on send: it never verified here", { timeout: 60_000 }, async () => {
    const context = await fresh.browser.newContext({ viewport: { width: 1600, height: 900 } });
    tab = await context.newPage();
    await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }] });
    await tab.goto(fresh.url);
    await tab.locator("button.row", { hasText: "Manager" }).first().click();
    await tab.getByText("Face ID or Touch ID on send").waitFor();
    expect(await tab.getByText("Signed in with your passkey").count()).toBe(0);
  });
});
