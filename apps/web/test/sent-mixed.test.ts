// A sent message keeps its image thumbnails and its file chips together.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Page from "/test/sent-mixed-page.svelte";
  mount(Page, { target: document.body });
</script></body></html>`;

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); }, 60_000);

describe("a sent message with an image and files", () => {
  it("shows the thumbnail and a chip for each file", async () => {
    const tab = await web.browser.newPage();
    await tab.goto(web.url);
    await tab.locator(".sent-images img").waitFor();
    const chips = tab.locator(".sent-files .filechip");
    expect(await chips.count()).toBe(2);
    expect(await chips.nth(0).innerText()).toContain("notes.md");
    expect(await chips.nth(1).innerText()).toContain("rows.csv");
    await tab.close();
  });
});
