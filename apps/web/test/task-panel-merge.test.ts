// TaskPanel's merge standing (B11), rendered in headless Chromium: the hub's label under the status picker (quiet
// while the merge is live, in the bad colour while it is not), an Accept that says what it does while the merge is not
// live on every node, and the record of a Done accepted that way.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Page from "/test/task-panel-merge-page.svelte";
  mount(Page, { target: document.body });
</script></body></html>`;

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); }, 60_000);

describe("the panel's merge standing (B11)", () => {
  it("the panel shows the merge label and offers Accept anyway while the merge is not live", { timeout: 30_000 }, async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await tab.goto(web.url);
      const cell = tab.locator('[data-cell="not-live"]');
      await cell.locator("[data-merge-label]").waitFor();
      const label = cell.locator("[data-merge-label]");
      expect(await label.innerText()).toBe("merged, not live: pc on abc1234");
      expect(await label.evaluate(el => el.classList.contains("bad"))).toBe(true);
      const accept = cell.getByRole("button", { name: "Accept anyway" });
      await accept.waitFor();
      expect(await accept.getAttribute("title")).toBe("Its merge is not live on every node; this is recorded as accepted by you");
      // A Done accepted while not live says so, with the override's own words.
      expect(await cell.locator("[data-merge-override]").innerText()).toBe("Accepted while not live: accepted by the principal");
    } finally { await tab.close(); }
  });

  it("a live merge shows plain Accept as done", { timeout: 30_000 }, async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await tab.goto(web.url);
      const cell = tab.locator('[data-cell="live"]');
      const label = cell.locator("[data-merge-label]");
      await label.waitFor();
      expect(await label.innerText()).toBe("merged, live");
      expect(await label.evaluate(el => el.classList.contains("bad"))).toBe(false);
      const accept = cell.getByRole("button", { name: "Accept as done" });
      await accept.waitFor();
      expect(await accept.getAttribute("title")).toBeNull();
      expect(await cell.getByRole("button", { name: "Accept anyway" }).count()).toBe(0);
      expect(await cell.locator("[data-merge-override]").count()).toBe(0);
    } finally { await tab.close(); }
  });
});
