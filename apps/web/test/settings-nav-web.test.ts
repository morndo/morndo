// Settings nav: section links and aria-current follow the route (ADR-0039 §9).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Page from "/test/settings-nav-page.svelte";
  mount(Page, { target: document.body });
</script></body></html>`;

describe("settings navigation", () => {
  let web: Awaited<ReturnType<typeof startWeb>>;
  beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
  afterAll(async () => { await web?.close(); });

  it("lists the sections and marks the current one", async () => {
    const page = await web.browser.newPage();
    try {
      await page.goto(web.url);
      const nav = page.getByRole("navigation", { name: "Settings sections" });
      for (const label of ["Accounts", "LLM connections", "Devices", "Updates"]) {
        await nav.getByRole("link", { name: label, exact: true }).waitFor();
      }
      await expect(nav.getByRole("link", { name: "Accounts", exact: true }).getAttribute("aria-current")).resolves.toBe("page");
      await expect(nav.getByRole("link", { name: "Devices", exact: true }).getAttribute("aria-current")).resolves.toBeNull();
      await page.getByRole("button", { name: "go devices" }).click();
      await expect(nav.getByRole("link", { name: "Devices", exact: true }).getAttribute("aria-current")).resolves.toBe("page");
      await expect(nav.getByRole("link", { name: "Accounts", exact: true }).getAttribute("aria-current")).resolves.toBeNull();
    } finally {
      await page.close();
    }
  });
});
