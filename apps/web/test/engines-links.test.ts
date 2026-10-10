// Engines links (ADR-0013): the sidebar and the Devices page show them only when the hub has MORNDO_ENGINES.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  const real = window.fetch.bind(window);
  window.__loads = [];
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = url.includes("/api/me") ? "me" : url.includes("/api/devices") ? "devices" : url.includes("/api/policy") ? "policy" : "";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (path) window.__loads.push({ path, phase: "start", t: performance.now() });
    if (path) await new Promise(r => setTimeout(r, 40));
    if (path) window.__loads.push({ path, phase: "end", t: performance.now() });
    if (url.includes("/api/me")) return json({ error: "down" }, 500);
    if (url.includes("/api/devices")) return json([{ id: "phone", name: "Pocket", pairedAt: 1, lastSeenAt: null, revokedAt: null, current: true }]);
    if (url.includes("/api/policy")) return json({ policy: { stay: "7d", stepUp: "1h" } });
    if (url.includes("/api/")) return json({ error: "off" }, 404);
    return real(input, init);
  };
  import { mount } from "svelte";
  import Page from "/test/engines-links-page.svelte";
  mount(Page, { target: document.body });
</script></body></html>`;

describe("Engines links follow MORNDO_ENGINES", () => {
  let web: Awaited<ReturnType<typeof startWeb>>;
  beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
  afterAll(async () => { await web?.close(); });

  it("hides them on the sidebar and on Devices when the hub has no engines CLI", async () => {
    const page = await web.browser.newPage();
    try {
      await page.goto(web.url);
      expect(await page.locator("[data-side=off]").getByRole("link", { name: "Engines" }).count()).toBe(0);
      expect(await page.locator("[data-side=on]").getByRole("link", { name: "Engines" }).count()).toBe(1);
      const devices = page.locator("[data-devices]");
      await devices.getByRole("heading", { name: "Devices" }).waitFor();
      await devices.getByText("Pocket").waitFor({ timeout: 2000 });
      await devices.getByRole("heading", { name: "Security" }).waitFor({ timeout: 2000 });
      expect(await devices.getByRole("link", { name: /Engines/ }).count()).toBe(0);
      const loads = await page.evaluate(() => (window as unknown as { __loads: { path: string; phase: string; t: number }[] }).__loads);
      const firstEnd = loads.find(x => x.phase === "end")?.t ?? 0;
      expect(loads.filter(x => x.phase === "start" && x.t < firstEnd).map(x => x.path).sort()).toEqual(["devices", "me", "policy"]);
    } finally { await page.close(); }
  });
});
