// The office desktop on a phone (T-670). Under 900px the app is the phone, which had no Desktop tab. Now an agent's
// conversation offers it as a third view beside Chat and Screen when the office has a desktop, filling the height under
// the conversation's header without the composer; without a desktop it isn't offered. The real Phone client in headless
// Chromium with the fake feed (harness.ts); noVNC's RFB is the recording stand-in (novnc.stub.ts). Synthetic names only.
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeFeed, startWeb, type Web } from "./harness.ts";

const PHONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><script type="module">
  import { mount } from "svelte";
  import Phone from "/src/lib/phone/Phone.svelte";
  const desktop = new URLSearchParams(location.search).get("desktop") === "1";
  mount(Phone, { target: document.body, props: { device: "phone-1", verifiedAt: Date.now(), policy: { stay: "7d", stepUp: "1h" }, desktop, onSignedOut: () => {} } });
</script></body></html>`;

let web: Web;
beforeAll(async () => { web = await startWeb(PHONE_PAGE, { "@novnc/novnc": join(import.meta.dirname, "novnc.stub.ts") }); }, 60_000);
afterAll(async () => { await web?.close(); });

it("an agent's conversation shows the office desktop as a third view, and doesn't offer it without a desktop", { timeout: 60_000 }, async () => {
  for (const [query, offered] of [["?desktop=1", true], ["", false]] as const) {
    const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
    const tab = await context.newPage();
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message));
    await tab.addInitScript(fakeFeed, { workers: [{ id: "%1", name: "alpha" }] });
    await tab.goto(`${web.url}${query}`);
    await tab.locator('[data-chat="alpha"]').click();
    const convo = tab.getByRole("region", { name: "Conversation with alpha" });
    const show = convo.getByRole("tablist", { name: "Show" });
    await show.getByRole("tab", { name: "Chat" }).waitFor({ timeout: 10_000 });
    expect(await show.getByRole("tab", { name: "Desktop" }).count()).toBe(offered ? 1 : 0);
    if (offered) {
      await show.getByRole("tab", { name: "Desktop" }).click();
      const desk = convo.getByRole("region", { name: "Desktop" });
      await desk.locator(".status.live").waitFor({ timeout: 10_000 });
      expect(await convo.getByRole("textbox", { name: "Message alpha" }).count()).toBe(0);
      const s = (await desk.locator(".screen").boundingBox())!;
      expect(Math.abs(s.y + s.height - 844)).toBeLessThanOrEqual(1);
      expect(s.height).toBeGreaterThanOrEqual(600);
      await desk.getByRole("button", { name: "Take control" }).click();
      await desk.getByRole("button", { name: "Release control" }).waitFor({ timeout: 5000 });
      expect(await desk.getByRole("toolbar", { name: "Keys for the desktop" }).count()).toBe(1);
      await show.getByRole("tab", { name: "Chat" }).click();
      await convo.getByRole("textbox", { name: "Message alpha" }).waitFor({ timeout: 5000 });
      expect(await convo.getByRole("region", { name: "Desktop" }).count()).toBe(0);
    }
    expect(errors).toEqual([]);
    await context.close();
  }
});
