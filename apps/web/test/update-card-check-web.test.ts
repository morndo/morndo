// The phone's update card offers Check again on an Uncertain reply, as the desktop does (fleet core §7; outbox/words.ts):
// it says what Check again does, has no Retry, and hands the entry's own id to the outbox's retry (Phone.svelte wires
// onRetry to outbox.retry). The real UpdateCard in headless Chromium at a phone's size; synthetic data only.
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import UpdateCard from "/src/lib/phone/UpdateCard.svelte";
  const now = Date.now();
  const view = { worker: "%1", name: "alpha", mark: null, messages: [], count: 1, firstAt: now - 60_000, lastAt: now - 60_000, tools: 0, toolNames: [], files: 0, claim: null };
  const reply = { id: "00000000-0000-4000-8000-000000000001", worker: "%1", workerName: "alpha", text: "did it go?", uploads: [], createdAt: now - 30_000,
    budgetFrom: now - 30_000, state: "uncertain", error: "uncertain", attempts: 1, seen: "none", sentAt: null, typedAt: null };
  globalThis.__retried = [];
  const noop = () => {};
  mount(UpdateCard, { target: document.body, props: { worker: null, name: "alpha", view, mark: null, now, outgoing: [reply], loading: false, note: null,
    onReply: async () => true, onOpen: noop, onRetry: id => globalThis.__retried.push(id), onDiscard: noop, onVerify: noop } });
</script></body></html>`;

let web: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });

describe("an Uncertain reply on the phone's update card", () => {
  it("says what Check again does, offers it and not Retry, and Check again retries that entry's id", { timeout: 30_000 }, async () => {
    tab = await web.browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message));
    await tab.goto(web.url);
    const row = tab.locator('[data-outgoing="uncertain"]', { hasText: "did it go?" });
    await row.getByText("Check again asks whether it was typed").waitFor({ timeout: 10_000 });
    expect(await row.getByRole("button", { name: "Retry" }).count()).toBe(0);
    await row.getByRole("button", { name: "Check again" }).click({ timeout: 10_000 });
    expect(await tab.evaluate(() => (globalThis as unknown as { __retried: string[] }).__retried)).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(errors).toEqual([]);
    await tab.close();
  });
});
