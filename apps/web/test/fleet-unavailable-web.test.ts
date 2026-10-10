// "Fleet unavailable" (fleet core §7): when the hub can't reach the fleet service it says so in the feed's `fleet` frame,
// and the app shows a banner in both layouts until the hub says it is back: the real Desktop (wide) and the real Phone
// (narrow), in headless Chromium, the hub faked at the browser's edge (harness.ts). A hub that never sends the frame (one
// from before the fleet) shows no banner. Applied live, without a resync. Synthetic workers.
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

// The whole phone layout, as the app mounts it under 900px (its one SvelteKit import, goto, is the harness's stand-in).
const PHONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Phone from "/src/lib/phone/Phone.svelte";
  mount(Phone, { target: document.body, props: { device: "phone-1", verifiedAt: Date.now(), policy: { stay: "7d", stepUp: "1h" }, onSignedOut: () => {} } });
</script></body></html>`;

let desk: Web;
let phone: Web;
beforeAll(async () => { [desk, phone] = await Promise.all([startWeb(), startWeb(PHONE_PAGE)]); }, 60_000);
afterAll(async () => { await Promise.all([desk?.close(), phone?.close()]); });

async function open(web: Web, viewport: { width: number; height: number }) {
  const tab = await web.browser.newPage({ viewport });
  const errors: string[] = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.addInitScript(fakeFeed, { workers: [{ id: "pc.3fa2c1d0.0", name: "manager" }, { id: "pc.3fa2c1d0.1", name: "alpha" }] });
  await tab.goto(web.url);
  return { tab, errors };
}
const push = (tab: Page, m: unknown) => tab.evaluate(x => (globalThis as unknown as FeedWin).__feedPush(x), m);
const hellos = (tab: Page) => tab.evaluate(() => (globalThis as unknown as FeedWin).__feedSent.filter(m => (m as { t: string }).t === "hello").length);
const banner = (tab: Page) => tab.getByRole("status").filter({ hasText: "Fleet unavailable" });

describe("Fleet unavailable", () => {
  for (const [layout, web, viewport, ready] of [
    ["wide (the desktop)", () => desk, { width: 1600, height: 900 }, (tab: Page) => tab.locator("aside.side button.row", { hasText: "alpha" }).first()],
    ["narrow (the phone)", () => phone, { width: 390, height: 844 }, (tab: Page) => tab.locator(".conn.live").first()],
  ] as const) {
    it(`${layout}: none from a hub that doesn't say; shown while the hub says unavailable, gone when it is back`, { timeout: 30_000 }, async () => {
      const { tab, errors } = await open(web(), viewport);
      await ready(tab).waitFor({ timeout: 15_000 });
      await tab.waitForTimeout(500);
      expect(await banner(tab).count()).toBe(0);                       // the fake never sent a fleet frame
      await push(tab, { t: "fleet", available: false });
      await banner(tab).waitFor({ timeout: 5000 });
      expect(await banner(tab).innerText()).toContain("may still be running");
      await push(tab, { t: "fleet", available: true });
      await banner(tab).waitFor({ state: "detached", timeout: 5000 });
      expect(await hellos(tab)).toBe(1);                                // applied as it came: no resync
      expect(errors).toEqual([]);
      await tab.close();
    });
  }
});
