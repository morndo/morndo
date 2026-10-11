// The task key in a conversation header stays on one line. The title is what truncates.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Page from "/test/task-chip-page.svelte";
  mount(Page, { target: document.body });
</script></body></html>`;

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); }, 60_000);

describe("the working-on chip", () => {
  it("keeps the task key on one line and truncates the title", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 800 } });
    await tab.goto(web.url);
    const key = tab.locator(".task .tk");
    await key.waitFor();
    const lines = await key.evaluate(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getClientRects().length;
    });
    const text = await key.innerText();
    const title = tab.locator(".task .tt");
    const truncated = await title.evaluate(el => el.scrollWidth > el.clientWidth + 1);
    expect(text.replace(/\s+/g, "")).toBe("T-18");
    expect(lines).toBe(1);
    expect(truncated).toBe(true);
    await tab.close();
  });
});
