// The offline marker (fleet core §7): a worker whose machine doesn't answer stays listed, with the word "offline", on the
// desktop's sidebar and in its conversation's header (wide) and in the phone's agents list (narrow). From the snapshot,
// then live as WorkerOfflineChanged events come, without a resync. The real Desktop, and the real Agents tab with the
// real LiveFeed, in headless Chromium; the hub faked at the browser's edge (harness.ts). Synthetic workers.
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

// The phone's Agents tab on its own, with its own LiveFeed as Phone.svelte gives it (Phone itself needs SvelteKit).
const PHONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import { LiveFeed } from "/src/lib/feed.svelte.ts";
  import Agents from "/src/lib/phone/Agents.svelte";
  const feed = new LiveFeed();
  feed.start();
  mount(Agents, { target: document.body, props: { feed, device: "phone-1" } });
</script></body></html>`;

const WORKERS = [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha", offline: true }, { id: "%2", name: "beta" }];
const change = (seq: number, workerId: string, offline: boolean) =>
  ({ t: "events", events: [{ epoch: "e1", seq, at: 1, body: { type: "WorkerOfflineChanged", workerId, offline } }] });

let desk: Web;
let phone: Web;
beforeAll(async () => { [desk, phone] = await Promise.all([startWeb(), startWeb(PHONE_PAGE)]); }, 60_000);
afterAll(async () => { await Promise.all([desk?.close(), phone?.close()]); });

async function open(web: Web, viewport: { width: number; height: number }) {
  const tab = await web.browser.newPage({ viewport });
  const errors: string[] = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.addInitScript(fakeFeed, { workers: WORKERS });
  await tab.goto(web.url);
  return { tab, errors };
}
const push = (tab: Page, m: unknown) => tab.evaluate(x => (globalThis as unknown as FeedWin).__feedPush(x), m);
const hellos = (tab: Page) => tab.evaluate(() => (globalThis as unknown as FeedWin).__feedSent.filter(m => (m as { t: string }).t === "hello").length);

describe("the offline marker", () => {
  it("wide: a sidebar row and the conversation's header say offline; live both ways, the manager's row too", { timeout: 30_000 }, async () => {
    const { tab, errors } = await open(desk, { width: 1600, height: 900 });
    const row = (name: string) => tab.locator("aside.side button.row", { hasText: name }).first();
    await row("beta").waitFor();
    expect(await row("alpha").innerText()).toContain("offline");
    expect(await row("beta").innerText()).not.toContain("offline");
    await row("alpha").click();
    await tab.locator(".state", { hasText: "Offline" }).waitFor({ timeout: 5000 });
    await push(tab, change(1, "%2", true));
    await row("beta").getByText("offline", { exact: true }).waitFor({ timeout: 5000 });
    await push(tab, change(2, "%1", false));
    await row("alpha").getByText("offline", { exact: true }).waitFor({ state: "detached", timeout: 5000 });
    await tab.locator(".state", { hasText: "Idle" }).waitFor({ timeout: 5000 });
    await push(tab, change(3, "%0", true));
    await row("Manager").getByText("offline", { exact: true }).waitFor({ timeout: 5000 });
    expect(await hellos(tab)).toBe(1);                                 // applied as events: no resync
    expect(errors).toEqual([]);
    await tab.close();
  });
  it("narrow: the phone's agents list says offline in place of its state; live both ways", { timeout: 30_000 }, async () => {
    const { tab, errors } = await open(phone, { width: 390, height: 844 });
    const when = (name: string) => tab.locator("ul.list button", { hasText: name }).first().locator(".when");
    await when("beta").waitFor();
    expect(await when("alpha").innerText()).toBe("offline");
    expect(await when("beta").innerText()).toMatch(/^quiet /);
    await push(tab, change(1, "%2", true));
    await expect.poll(() => when("beta").innerText(), { timeout: 5000 }).toBe("offline");
    await push(tab, change(2, "%1", false));
    await expect.poll(() => when("alpha").innerText(), { timeout: 5000 }).toMatch(/^quiet /);
    expect(await hellos(tab)).toBe(1);
    expect(errors).toEqual([]);
    await tab.close();
  });
});
