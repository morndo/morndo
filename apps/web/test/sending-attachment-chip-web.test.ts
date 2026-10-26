// A message with attachments shows its chips while it is still being sent, not the "1 file" fallback (T-464): the
// real Desktop in headless Chromium, the fake feed of harness.ts, and the hub's send held until the test lets it go.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type Web } from "./harness.ts";

let web: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(); }, 60_000);
afterAll(async () => { await web?.close(); });
afterEach(async () => { await tab.context().close(); });

describe("a message with an attachment that is still sending", () => {
  it("shows the file chip, never '1 file', and keeps it once sent", { timeout: 30_000 }, async () => {
    const context = await web.browser.newContext({ viewport: { width: 1600, height: 900 } });
    tab = await context.newPage();
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message));
    let release = () => {};
    const held = new Promise<void>(r => (release = r));
    await tab.route("**/api/uploads", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "up-1", name: "notes.md", size: 5, mime: "text/markdown" }) }));
    await tab.route(/\/api\/workers\/[^/]+\/send$/, async route => { await held; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }); });
    await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }] });
    await tab.goto(web.url);
    await tab.locator("button.row", { hasText: "alpha" }).first().click();
    await tab.locator('input[type="file"]').setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Hi\n") });
    await tab.locator(".filechip", { hasText: "notes.md" }).waitFor();
    await tab.getByRole("textbox", { name: "Message alpha" }).fill("see the notes");
    await tab.getByRole("textbox", { name: "Message alpha" }).press("Enter");

    const sending = tab.locator("article[data-outbox]");
    await sending.waitFor({ timeout: 5000 });
    await sending.locator(".sent-files .filechip", { hasText: "notes.md" }).waitFor({ timeout: 5000 });
    expect(await sending.getByText("1 file", { exact: true }).count()).toBe(0);

    release();
    await tab.locator('article[data-outbox][data-state="sent"]').waitFor({ timeout: 5000 });
    expect(await tab.locator("article[data-outbox] .sent-files .filechip", { hasText: "notes.md" }).count()).toBe(1);
    expect(errors).toEqual([]);
  });
});
