// The owner, 2026-11-10: a machine's notice (the hub files it as the system's) is no part of the conversation by
// default; "Everything (verbose)" shows it, whole, not cut to one line. Real clients in headless Chromium, fake feed.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedOptions, type Web } from "./harness.ts";

const PHONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Phone from "/src/lib/phone/Phone.svelte";
  mount(Phone, { target: document.body, props: { device: "phone-1", verifiedAt: Date.now(), policy: { stay: "7d", stepUp: "1h" }, onSignedOut: () => {} } });
</script></body></html>`;

const NOTICE = "[From the owner's Mac session, on the owner's instruction.] Heads-up: creating a new route for the demo host, "
  + "with the same lock as the other demo routes. No change to existing objects. The owner approved it. Reply with [quiet]. END-OF-NOTICE";
const CHAT: FeedOptions = {
  workers: [{ id: "%3", name: "manager" }, { id: "%1", name: "alpha" }],
  history: { "%3": [
    { id: "m1", at: Date.now() - 180_000, author: { kind: "principal", name: "You" }, kind: "text", text: "ship the alpha release" },
    { id: "m2", at: Date.now() - 120_000, author: { kind: "system", name: "Mac session" }, kind: "event", text: NOTICE },
    { id: "m3", at: Date.now() - 60_000, author: { kind: "agent", name: "manager" }, kind: "text", text: "on it, alpha goes out tonight" },
  ] },
};

let web: Web;
let phone: Web;
let tab: Page;
let errors: string[];
beforeAll(async () => { [web, phone] = await Promise.all([startWeb(), startWeb(PHONE_PAGE)]); }, 60_000);
afterAll(async () => { await Promise.all([web?.close(), phone?.close()]); });
afterEach(async () => { await tab.context().close(); });

async function open(width: number, show: "clean" | "verbose" | null = null) {
  const app = width < 900 ? phone : web;
  tab = await (await app.browser.newContext({ viewport: { width, height: 860 } })).newPage();
  errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  if (show) await tab.addInitScript(s => localStorage.setItem("morndo.conversations", JSON.stringify({ manager: { show: s } })), show);
  await tab.addInitScript(fakeFeed, CHAT);
  await tab.goto(app.url);
}

describe("the desktop", () => {
  it("by default the manager's conversation shows no machine notice", { timeout: 30_000 }, async () => {
    await open(1400);
    await tab.locator("button.row", { hasText: "Manager" }).first().click();
    await tab.locator("article.msg", { hasText: "on it, alpha goes out tonight" }).waitFor();
    expect(await tab.locator("article.msg", { hasText: "ship the alpha release" }).count()).toBe(1);
    expect(await tab.getByText("Heads-up: creating a new route", { exact: false }).count()).toBe(0);
    expect(await tab.getByText("Mac session", { exact: false }).count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("in verbose it shows the notice, named by its sender, whole and not cut to one line", { timeout: 30_000 }, async () => {
    await open(1400, "verbose");
    await tab.locator("button.row", { hasText: "Manager" }).first().click();
    const row = tab.locator("[data-msg='m2']");
    await row.waitFor();
    expect(await row.innerText()).toContain("Mac session");
    expect(await row.innerText()).toContain("END-OF-NOTICE");
    const cut = await row.evaluate(r => [...r.querySelectorAll("*")].some(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== "visible"));
    expect(cut).toBe(false);
    expect(await row.evaluate(r => r.getBoundingClientRect().height)).toBeGreaterThan(30);
    expect(errors).toEqual([]);
  });
});

describe("the phone", () => {
  it("the manager's conversation shows no machine notice", { timeout: 30_000 }, async () => {
    await open(390);
    await tab.locator('[data-chat="manager"]').click();
    const convo = tab.getByRole("region", { name: "Conversation with Manager" });
    await convo.getByText("on it, alpha goes out tonight").waitFor();
    expect(await convo.getByText("Heads-up: creating a new route", { exact: false }).count()).toBe(0);
    expect(errors).toEqual([]);
  });
});
