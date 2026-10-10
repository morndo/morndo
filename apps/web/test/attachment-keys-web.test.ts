// Two attachments of one message may share a name (index.html from two folders; the same file sent twice): the phone
// chat and the catch-up card must show both, not throw Svelte's each_key_duplicate. Real components in headless Chromium.
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import { LiveFeed } from "/src/lib/feed.svelte.ts";
  import Chat from "/src/lib/phone/Chat.svelte";
  import UpdateCard from "/src/lib/phone/UpdateCard.svelte";
  if (new URL(location.href).searchParams.get("v") === "card") {
    const noop = () => {};
    try {
      mount(UpdateCard, { target: document.body, props: { worker: null, name: "alpha", view: globalThis.__view, mark: null, now: Date.now(), outgoing: [], loading: false, note: null,
        onReply: async () => true, onOpen: noop, onRetry: noop, onDiscard: noop, onVerify: noop } });
      globalThis.__mounted = "ok";
    } catch (e) { globalThis.__mounted = "threw: " + e.message; }
  } else {
    const feed = new LiveFeed(); feed.start();
    mount(Chat, { target: document.body, props: { feed, worker: "%1", name: "alpha", focus: null } });
  }
</script></body></html>`;
const T0 = Date.UTC(2026, 9, 7, 10);
const said = (id: string, text: string, at: number) => ({ id, at, author: { kind: "agent", name: "alpha" }, kind: "text", text });
const att = (id: string | null) => ({ name: "page.png", mime: "image/png", kind: "image", caption: null, id, size: id ? 9 : null, ...(id ? {} : { pending: true }) });
const fileMsg = (a: unknown[]) => ({ id: "toolu_X:files", at: T0 + 5000, author: { kind: "agent", name: "alpha" }, kind: "file", text: "", attachments: a });

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });
const push = (tab: Page, m: unknown) => tab.evaluate(x => (globalThis as unknown as FeedWin).__feedPush(x), m);
const settle = (ms = 400) => new Promise(r => setTimeout(r, ms));

describe("attachments named alike", () => {
  it("phone chat: two pending page.png show, the next message shows, and both links appear once they land", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message.split("\n")[0] ?? ""));
    await tab.addInitScript(fakeFeed, { workers: [{ id: "%1", name: "alpha" }], history: { "%1": [said("m1", "hello there", T0)] } });
    await tab.goto(web.url);
    await tab.getByText("hello there").waitFor({ timeout: 15_000 });
    await push(tab, { t: "messages", worker: "%1", messages: [fileMsg([att(null), att(null)])] });
    await push(tab, { t: "messages", worker: "%1", messages: [said("m3", "a later message", T0 + 9000)] });
    await tab.getByText("a later message").waitFor({ timeout: 5000 });
    expect(await tab.getByText("page.png: copying…").count()).toBe(2);
    await push(tab, { t: "attachments", worker: "%1", message: "toolu_X:files", attachments: [att("1".repeat(32)), att("1".repeat(32))] });   // the same file twice: one id
    await settle();
    expect(await tab.locator("a.file").count()).toBe(2);
    expect(errors).toEqual([]);
    await tab.close();
  }, 60_000);

  it("catch-up card: two pending page.png mount", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 390, height: 844 } });
    const view = { worker: "%1", name: "alpha", mark: null, messages: [fileMsg([att(null), att(null)])], count: 1, firstAt: T0, lastAt: T0 + 5000, tools: 0, toolNames: [], files: 2, claim: null };
    await tab.addInitScript(fakeFeed, { workers: [{ id: "%1", name: "alpha" }], history: {} });
    await tab.addInitScript(v => { (globalThis as unknown as { __view: unknown }).__view = v; }, view);
    await tab.goto(`${web.url}?v=card`);
    await settle(1000);
    expect(await tab.evaluate(() => (globalThis as unknown as { __mounted?: string }).__mounted)).toBe("ok");
    await tab.close();
  }, 60_000);
});
