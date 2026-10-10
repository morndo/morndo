// The Engines role card (ADR-0013): the other-provider switch stays after it is turned off, and a refused typed
// effort goes back to the effort the draft holds. The card itself, in headless Chromium.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Page from "/test/engines-role-page.svelte";
  mount(Page, { target: document.body });
</script></body></html>`;

describe("a role card", () => {
  let web: Awaited<ReturnType<typeof startWeb>>;
  beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
  afterAll(async () => { await web?.close(); });

  it("lets every role turn the other-provider rule on and off from the draft", async () => {
    const page = await web.browser.newPage();
    try {
      await page.goto(web.url);
      const card = page.locator("[data-case=effort]");
      const sw = card.getByRole("switch", { name: "Reviewer from another provider" });
      expect(await card.getByRole("switch").count()).toBe(1);
      expect(await sw.getAttribute("aria-checked")).toBe("false");
      await sw.click();
      expect(await sw.getAttribute("aria-checked")).toBe("true");
      await sw.click();
      expect(await card.getByRole("switch").count()).toBe(1);
      expect(await sw.getAttribute("aria-checked")).toBe("false");
    } finally { await page.close(); }
  });

  it("keeps the other-provider switch after it is switched off, so it can be switched back on", async () => {
    const page = await web.browser.newPage();
    try {
      await page.goto(web.url);
      const card = page.locator("[data-case=rule]");
      const sw = card.getByRole("switch", { name: "Reviewer from another provider" });
      await sw.waitFor();
      await sw.click();
      expect(await card.getByRole("switch").count()).toBe(1);
      expect(await sw.getAttribute("aria-checked")).toBe("false");
    } finally { await page.close(); }
  });

  it("puts a refused typed effort back to the effort the draft holds", async () => {
    const page = await web.browser.newPage();
    try {
      await page.goto(web.url);
      const input = page.locator("[data-case=effort]").getByRole("textbox", { name: "Effort, fallback 1" });
      await input.waitFor();
      expect(await input.inputValue()).toBe("");
      await input.fill("high");
      await input.blur();
      expect(await input.inputValue()).toBe("");
    } finally { await page.close(); }
  });
});
