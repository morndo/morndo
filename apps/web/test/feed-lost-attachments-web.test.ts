// A file's copy lands while the socket is down: the attachments frame is lost, and the history the reconnect brings
// holds the file. The held message must show it (fleet core §3.1). Real phone Chat in headless Chromium, fake feed.
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import { LiveFeed } from "/src/lib/feed.svelte.ts";
  import Chat from "/src/lib/phone/Chat.svelte";
  const feed = new LiveFeed(); feed.start();
  mount(Chat, { target: document.body, props: { feed, worker: "%1", name: "alpha", focus: null } });
</script></body></html>`;
const T0 = Date.UTC(2026, 9, 7, 10);
const said = (id: string, text: string, at: number) => ({ id, at, author: { kind: "agent", name: "alpha" }, kind: "text", text });
const att = (id: string | null) => ({ name: "report.pdf", mime: "application/pdf", kind: "file", caption: null, id, size: id ? 9 : null, ...(id ? {} : { pending: true }) });
const fileMsg = (a: unknown[]) => ({ id: "toolu_X:files", at: T0 + 5000, author: { kind: "agent", name: "alpha" }, kind: "file", text: "", attachments: a });

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });
const push = (tab: Page, m: unknown) => tab.evaluate(x => (globalThis as unknown as FeedWin).__feedPush(x), m);

describe("a lost attachments frame", () => {
  it("is made good by the history of the reconnect", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 390, height: 844 } });
    await tab.addInitScript(fakeFeed, { workers: [{ id: "%1", name: "alpha" }], history: { "%1": [said("m1", "hello", T0)] } });
    await tab.goto(web.url);
    await tab.getByText("hello").waitFor({ timeout: 15_000 });
    await push(tab, { t: "messages", worker: "%1", messages: [fileMsg([att(null)])] });
    await tab.getByText("report.pdf: copying…").waitFor({ timeout: 5000 });
    await push(tab, { t: "history", worker: "%1", session: null, messages: [said("m1", "hello", T0), fileMsg([att("a".repeat(32))])] });
    await tab.locator('a.file[href="/api/files/' + "a".repeat(32) + '"]').waitFor({ timeout: 5000 });
    expect(await tab.getByText("copying…").count()).toBe(0);
    await tab.close();
  }, 60_000);
});
