// The Desktop and Terminal tabs' full screen button is a toggle: one click enters full screen, the next click on the
// same button leaves it (Escape still does too). Before, the button only ever asked for full screen, so a click while
// in full screen did nothing and only Escape got out. Synthetic props only; the hub is absent, so both views just
// keep trying to connect while the button is checked.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="desktop" style="height:400px;display:flex"></div><div id="terminal" style="height:400px;display:flex"></div>
<script type="module">
  import { mount } from "svelte";
  import DesktopView from "/src/lib/desktop/DesktopView.svelte";
  import TerminalView from "/src/lib/desktop/TerminalView.svelte";
  mount(DesktopView, { target: document.getElementById("desktop"), props: { verifiedAt: null, onVerified: () => {} } });
  mount(TerminalView, { target: document.getElementById("terminal"), props: { pane: "%1", name: "builder", verifiedAt: null, onVerified: () => {} } });
</script></body></html>`;

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });

const fullscreenLabel = (tab: Page) => tab.evaluate(() => document.fullscreenElement?.getAttribute("aria-label") ?? null);

async function enterThenLeaveByClick(tab: Page, section: string, view: string) {
  const button = tab.locator(`${section} button.fs:not(.wide)`);
  expect(await button.getAttribute("aria-label")).toBe("Full screen");
  await button.click();
  await tab.waitForFunction(v => document.fullscreenElement?.getAttribute("aria-label") === v, view);
  await button.click();                                   // the same button, again: leaves full screen (the owner's bug)
  await tab.waitForFunction(() => document.fullscreenElement === null, null, { timeout: 3000 }).catch(() => {});
  expect(await fullscreenLabel(tab), "a click on the button while in full screen should leave it").toBeNull();
  expect(await button.getAttribute("aria-label")).toBe("Full screen");
  await button.click();                                   // and while in full screen, the button says what it does
  await tab.waitForFunction(v => document.fullscreenElement?.getAttribute("aria-label") === v, view);
  expect(await button.getAttribute("aria-label")).toBe("Exit full screen");
  await button.click();
  await tab.waitForFunction(() => document.fullscreenElement === null);
}

describe("full screen button on the Desktop and Terminal tabs", () => {
  it("the Desktop tab's button enters full screen, then leaves it on the next click", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    await tab.goto(web.url);
    await tab.locator("#desktop button.fs").waitFor();
    await enterThenLeaveByClick(tab, "#desktop", "Desktop");
    await tab.close();
  });

  it("the Terminal tab's button does the same", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    await tab.goto(web.url);
    await tab.locator("#terminal button.fs").first().waitFor();
    await enterThenLeaveByClick(tab, "#terminal", "Terminal of #builder");
    await tab.close();
  });

  it("leaving with Escape puts the button back to Full screen", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    await tab.goto(web.url);
    const button = tab.locator("#desktop button.fs");
    await button.click();
    await tab.waitForFunction(() => document.fullscreenElement !== null);
    await expect.poll(() => button.getAttribute("aria-label")).toBe("Exit full screen");
    await tab.evaluate(() => document.exitFullscreen());  // what Escape does: the browser leaves full screen itself
    await tab.waitForFunction(() => document.fullscreenElement === null);
    await expect.poll(() => button.getAttribute("aria-label")).toBe("Full screen");
    await tab.close();
  });
});
