// Found in the rage QA: a 9,000-character paste was queued, refused too_long by the hub, and offered a Retry that could
// only fail again. Now the composer says it is too long while typing and doesn't send it; and a refusal a retry can't
// change (too_long, empty) offers Edit, which puts the text back in the box, instead of Retry. Real Desktop client in
// headless Chromium, fake feed and a fake send endpoint (harness.ts).
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type Web } from "./harness.ts";

let web: Web;
let tab: Page;
let posts: string[];
beforeAll(async () => { web = await startWeb(); }, 60_000);
afterAll(async () => { await web?.close(); });
afterEach(async () => { await tab.context().close(); });

async function openAlpha(answer: { status: number; error?: string }) {
  tab = await (await web.browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  posts = [];
  await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }] });
  await tab.route(/\/api\/workers\/[^/]+\/send$/, async route => {
    posts.push((route.request().postDataJSON() as { text: string }).text);
    await route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.error ? { error: answer.error } : { ok: true, at: Date.now() }) });
  });
  await tab.goto(web.url);
  await tab.locator("button.row", { hasText: "alpha" }).first().click();
  await tab.getByRole("heading", { level: 1, name: "alpha", exact: true }).waitFor();
}
const box = () => tab.getByRole("textbox", { name: "Message alpha" });

describe("the composer's length", () => {
  it("over 8,000 characters: said while typing, Send off, nothing sent; back under: Send on", { timeout: 30_000 }, async () => {
    await openAlpha({ status: 200 });
    await box().fill("x".repeat(8001));
    await tab.locator("[data-over]").waitFor();
    expect(await tab.locator("[data-over]").innerText()).toContain("8001 of 8000");
    expect(await tab.getByRole("button", { name: "Send" }).isDisabled()).toBe(true);
    await box().press("Enter");
    expect(posts).toEqual([]);
    await box().fill("x".repeat(8000));
    expect(await tab.locator("[data-over]").count()).toBe(0);
    expect(await tab.getByRole("button", { name: "Send" }).isDisabled()).toBe(false);
  });
});

describe("a refusal a retry can't change", () => {
  it("too_long offers Edit, not Retry; Edit puts the text back in the box", { timeout: 30_000 }, async () => {
    await openAlpha({ status: 409, error: "too_long" });
    await box().fill("with its file notes it is too long");
    await box().press("Enter");
    const entry = tab.locator("article.pending", { hasText: "with its file notes it is too long" });
    await entry.getByRole("button", { name: "Edit" }).waitFor({ timeout: 10_000 });
    expect(await entry.getByRole("button", { name: "Retry" }).count()).toBe(0);
    await entry.getByRole("button", { name: "Edit" }).click();
    await expect.poll(() => box().inputValue()).toBe("with its file notes it is too long");
    expect(posts).toHaveLength(1);
  });

  it("another refusal (the machine not answering) still offers Retry (negative control)", { timeout: 30_000 }, async () => {
    await openAlpha({ status: 409, error: "node_offline" });
    await box().fill("try again later");
    await box().press("Enter");
    await tab.locator("article.pending", { hasText: "try again later" }).getByRole("button", { name: "Retry" }).waitFor({ timeout: 10_000 });
  });
});
