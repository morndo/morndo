// A blocked task's card says what the board watches for it (B18, ADR-0040), rendered in headless Chromium: the waits in
// the CLI's own spelling, under the reason, and nothing more for a block of words only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Page from "/test/task-card-waits-page.svelte";
  mount(Page, { target: document.body });
</script></body></html>`;

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); }, 60_000);

describe("a blocked task's card (B18)", () => {
  it("names the waits the board watches, and says nothing of them for a block of words only", { timeout: 30_000 }, async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await tab.goto(web.url);
      const card = tab.locator('[data-cell="waits"]');
      await card.locator("[data-waits]").waitFor();
      expect(await card.locator("[data-waits]").innerText()).toBe("Waits on acme/widgets#7, T-4, ny-530");
      expect(await card.locator(".why").innerText()).toBe("needs the widget fix");
      expect(await tab.locator('[data-cell="words"] [data-waits]').count()).toBe(0);
      expect(await tab.locator('[data-cell="words"] .why').innerText()).toBe("needs the widget fix");
    } finally { await tab.close(); }
  });
});
