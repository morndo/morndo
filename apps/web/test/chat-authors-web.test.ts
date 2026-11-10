// The owner, 2026-11-10: in the chat it was hard to tell when he wrote a message and when the manager did. Every
// avatar was a dark tile, and "You" an ink tile like the rest. The manager now wears the Morndo mark, on the desktop and
// on the phone, and "You" is no longer the mark's colour. Real clients in headless Chromium, fake feed (harness.ts).
import type { Locator, Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MARK_PATH } from "../src/lib/avatar-look.ts";
import { fakeFeed, startWeb, type FeedOptions, type Web } from "./harness.ts";

const PHONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Phone from "/src/lib/phone/Phone.svelte";
  mount(Phone, { target: document.body, props: { device: "phone-1", verifiedAt: Date.now(), policy: { stay: "7d", stepUp: "1h" }, onSignedOut: () => {} } });
</script></body></html>`;

const MANAGER_CHAT: FeedOptions = {
  workers: [{ id: "%3", name: "manager" }, { id: "%1", name: "alpha" }],
  history: { "%3": [
    { id: "m1", at: Date.now() - 120_000, author: { kind: "principal", name: "You" }, kind: "text", text: "ship the alpha release" },
    { id: "m2", at: Date.now() - 60_000, author: { kind: "agent", name: "manager" }, kind: "text", text: "on it, alpha goes out tonight" },
  ] },
};
const MARK = `svg path[d="${MARK_PATH}"]`;

let web: Web;
let phone: Web;
let tab: Page;
let errors: string[];
beforeAll(async () => { [web, phone] = await Promise.all([startWeb(), startWeb(PHONE_PAGE)]); }, 60_000);
afterAll(async () => { await Promise.all([web?.close(), phone?.close()]); });
afterEach(async () => { await tab.context().close(); });

async function open(width: number) {
  const app = width < 900 ? phone : web;
  tab = await (await app.browser.newContext({ viewport: { width, height: 860 } })).newPage();
  errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.addInitScript(fakeFeed, MANAGER_CHAT);
  await tab.goto(app.url);
}
const look = (l: Locator) => l.evaluate(e => ({ bg: getComputedStyle(e).backgroundColor, color: getComputedStyle(e).color }));

describe("the desktop", () => {
  it("the manager wears the Morndo mark in the sidebar and on its messages; your messages do not, and are not its colour", { timeout: 30_000 }, async () => {
    await open(1400);
    const row = tab.locator("button.row", { hasText: "Manager" }).first();
    await row.waitFor();
    expect(await row.locator(MARK).count()).toBe(1);
    await row.click();
    const theirs = tab.locator("article.msg", { hasText: "on it, alpha goes out tonight" });
    const mine = tab.locator("article.msg", { hasText: "ship the alpha release" });
    await theirs.waitFor();
    expect(await theirs.locator(".gutter").locator(MARK).count()).toBe(1);
    expect(await mine.locator(".gutter").locator(MARK).count()).toBe(0);
    const manager = await look(theirs.locator(".gutter .av"));
    const markFill = await theirs.locator(".gutter").locator(MARK).evaluate(e => getComputedStyle(e).fill);
    const you = await look(mine.locator(".gutter .av"));
    expect(you.bg).not.toBe(markFill);
    expect(you.bg).not.toBe(manager.bg);
    expect(errors).toEqual([]);
  });
});

describe("the phone", () => {
  it("the manager wears the Morndo mark in the chat list and at the top of its conversation", { timeout: 30_000 }, async () => {
    await open(390);
    const row = tab.locator('[data-chat="manager"]');
    await row.waitFor();
    expect(await row.locator(MARK).count()).toBe(1);
    expect(await tab.locator('[data-chat="alpha"]').locator(MARK).count()).toBe(0);
    await row.click();
    const convo = tab.getByRole("region", { name: "Conversation with Manager" });
    await convo.getByText("on it, alpha goes out tonight").waitFor();
    expect(await convo.locator("header").locator(MARK).count()).toBe(1);
    expect(errors).toEqual([]);
  });
});
