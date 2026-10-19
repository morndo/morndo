// The fleet's alerts in the app (the owner, 2026-10-12): the desktop's Activity and the phone's Status list them, newest
// first, the urgent ones marked; their count is on Activity's (and Status's) badge until he opens them, which moves his
// read mark of "@alerts" (synced across his devices). Real clients in headless Chromium, fake feed (harness.ts).
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

const PHONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Phone from "/src/lib/phone/Phone.svelte";
  mount(Phone, { target: document.body, props: { device: "phone-1", verifiedAt: Date.now(), policy: { stay: "7d", stepUp: "1h" }, onSignedOut: () => {} } });
</script></body></html>`;
const ALERTS = [
  { id: 2, at: Date.now() - 1000, node: "pc", kind: "source_changed", detail: { from: "100.64.0.1", to: "100.64.0.9" } },
  { id: 1, at: Date.now() - 5000, node: null, kind: "lane_conflict", detail: { name: "alpha", claims: [] } },
];

let desk: Web;
let phone: Web;
let tab: Page;
let errors: string[];
beforeAll(async () => { [desk, phone] = await Promise.all([startWeb(), startWeb(PHONE_PAGE)]); }, 60_000);
afterAll(async () => { await Promise.all([desk?.close(), phone?.close()]); });
afterEach(async () => { await tab.context().close(); });

async function open(app: Web, width: number) {
  tab = await (await app.browser.newContext({ viewport: { width, height: 860 } })).newPage();
  errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }] });
  await tab.goto(app.url);
}
const push = (m: unknown) => tab.evaluate(x => (globalThis as unknown as FeedWin).__feedPush(x), m);
const reads = () => tab.evaluate(() => (globalThis as unknown as FeedWin).__feedSent.filter(m => (m as { t: string }).t === "read") as { conversation: string; at: number }[]);

describe("the desktop", () => {
  it("Activity lists them, the urgent one marked; the badge counts them until Activity is opened", { timeout: 30_000 }, async () => {
    await open(desk, 1400);
    await tab.locator("button.row", { hasText: "alpha" }).first().waitFor();
    await push({ t: "alerts", items: ALERTS });
    const activity = tab.locator("button.row.static", { hasText: "Activity" });
    await expect.poll(() => activity.locator(".badge").innerText().catch(() => "")).toBe("2");
    await activity.click();
    const list = tab.getByRole("list", { name: "Alerts" });
    await list.waitFor();
    expect(await list.locator("li").allInnerTexts()).toEqual([
      expect.stringContaining("pc connected from a new address"), expect.stringContaining("Two windows are named alpha"),
    ]);
    expect(await list.locator("li.urgent").count()).toBe(1);
    await expect.poll(async () => (await reads()).filter(r => r.conversation === "@alerts").at(-1)?.at).toBe(ALERTS[0]?.at);
    await expect.poll(() => activity.locator(".badge").count()).toBe(0);
    expect(errors).toEqual([]);
  });
});

describe("the phone", () => {
  it("Status lists them, with a badge on its tab until it is opened", { timeout: 30_000 }, async () => {
    await open(phone, 390);
    await tab.locator('[data-chat="alpha"]').waitFor();
    await push({ t: "alerts", items: ALERTS });
    const status = tab.getByRole("button", { name: /^Status/ });
    await expect.poll(() => status.getAttribute("aria-label")).toBe("Status, 2 new alerts");
    await status.click();
    await tab.getByRole("list", { name: "Alerts" }).waitFor();
    await expect.poll(() => status.getAttribute("aria-label")).toBe("Status");
    expect(errors).toEqual([]);
  });
});
