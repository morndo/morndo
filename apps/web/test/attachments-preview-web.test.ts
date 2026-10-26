// A text file in the chat (an HTML page the owner attached, say) is fetched when its Preview is opened, not when the
// message shows, and once. The real Desktop in headless Chromium, the fake feed of harness.ts.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type Web } from "./harness.ts";

const T0 = Date.UTC(2026, 9, 26, 15);
const ID = "b".repeat(32);
const page = { id: ID, name: "report.html", mime: "text/plain; charset=utf-8", kind: "text", caption: null, size: 3_000_000 };
const message = { id: "u1", at: T0, author: { kind: "principal", name: "You" }, kind: "text", text: "Here is the report", attachments: [page] };
const BODY = `<!doctype html><p>start</p><img src=x onerror="window.__ran = 1">${"x".repeat(3_000_000)}`;

let web: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(); }, 60_000);
afterAll(async () => { await web?.close(); });
afterEach(async () => { await tab.context().close(); });

describe("a text file's preview", () => {
  it("is fetched only when opened, once, shows the start as text, and runs nothing", { timeout: 30_000 }, async () => {
    const context = await web.browser.newContext({ viewport: { width: 1600, height: 900 } });
    tab = await context.newPage();
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message));
    let asked = 0;
    await tab.route(`**/api/files/${ID}`, route => { asked++; return route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: BODY }); });
    await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }], history: { "%1": [message] } });
    await tab.goto(web.url);
    await tab.locator("button.row", { hasText: "alpha" }).first().click();
    const card = tab.locator(".att", { hasText: "report.html" });
    await card.waitFor({ timeout: 5000 });
    await new Promise(r => setTimeout(r, 500));
    expect(asked).toBe(0);
    await card.getByRole("button", { name: "Preview" }).click();
    await card.locator(".preview pre", { hasText: "<!doctype html><p>start</p>" }).waitFor({ timeout: 5000 });
    expect(asked).toBe(1);
    await card.getByText("Only the first 200 KB are shown").waitFor();
    expect((await card.locator(".preview pre").innerText()).length).toBeLessThanOrEqual(200_000);
    await card.getByRole("button", { name: "Hide" }).click();
    await card.getByRole("button", { name: "Preview" }).click();
    await card.locator(".preview pre").waitFor();
    expect(asked).toBe(1);
    expect(await tab.evaluate(() => (window as unknown as { __ran?: number }).__ran)).toBeUndefined();
    expect(errors).toEqual([]);
  });
});
