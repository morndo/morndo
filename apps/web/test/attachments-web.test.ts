// A file still being copied (fleet core §3.1): the message shows it as copying, and the hub's attachments frame turns it
// into the file once the copy landed. The real Desktop in headless Chromium, the fake feed of harness.ts.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

const T0 = Date.UTC(2026, 9, 6, 8);
const ID = "a".repeat(32);
const photo = { name: "pasted-1.png", mime: "image/png", kind: "image", caption: null };
const pendingMessage = { id: "u1", at: T0, author: { kind: "principal", name: "You" }, kind: "text", text: "Look at this", attachments: [{ ...photo, id: null, size: null, pending: true }] };

let web: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(); }, 60_000);
afterAll(async () => { await web?.close(); });
afterEach(async () => { await tab.context().close(); });

const push = (m: unknown) => tab.evaluate(x => (globalThis as unknown as FeedWin).__feedPush(x), m);

describe("a file being copied", () => {
  it("shows as copying, then as the file once the attachments frame comes; a frame for another worker changes nothing", { timeout: 30_000 }, async () => {
    const context = await web.browser.newContext({ viewport: { width: 1600, height: 900 } });
    tab = await context.newPage();
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message));
    await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }], history: { "%1": [pendingMessage] } });
    await tab.goto(web.url);
    await tab.locator("button.row", { hasText: "alpha" }).first().click();
    await tab.getByText("Copying from its machine…").waitFor({ timeout: 5000 });
    expect(await tab.locator(`img[src="/api/files/${ID}"]`).count()).toBe(0);
    await push({ t: "attachments", worker: "%0", message: "u1", attachments: [{ ...photo, id: ID, size: 9 }] });   // not the one watched
    await new Promise(r => setTimeout(r, 200));
    expect(await tab.getByText("Copying from its machine…").count()).toBe(1);
    await push({ t: "attachments", worker: "%1", message: "u1", attachments: [{ ...photo, id: ID, size: 9 }] });
    await tab.locator(`img[src="/api/files/${ID}"]`).waitFor({ timeout: 5000 });
    expect(await tab.getByText("Copying from its machine…").count()).toBe(0);
    expect(errors).toEqual([]);
  });
});
