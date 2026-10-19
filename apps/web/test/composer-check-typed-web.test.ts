// Staging QA, 2026-10-12, on the phone as on the desktop (composer-lost-message.test.ts): Enter, then, while the passkey
// check was still open, a second message typed in the box and Enter again (ignored while the check is open). When the
// check passed, the first message went and the box was emptied: the second one was gone, never sent and never shown.
// Real Phone client in headless Chromium, fake feed (harness.ts); the hub's step-up and send routes and the passkey
// prompt are faked at the browser's edges.
import type { Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeFeed, startWeb, type Web } from "./harness.ts";

const PHONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Phone from "/src/lib/phone/Phone.svelte";
  mount(Phone, { target: document.body, props: { device: "phone-1", verifiedAt: null, policy: { stay: "7d", stepUp: "1h" }, onSignedOut: () => {} } });
</script></body></html>`;

// The passkey prompt answers at once; the hub's check of its answer waits for the test.
function fakePasskey() {
  const buf = () => new Uint8Array([1, 2, 3]).buffer;
  const n = navigator as unknown as { credentials: { get: () => Promise<unknown> } };
  n.credentials.get = async () => ({
    id: "AQID", rawId: buf(), type: "public-key", authenticatorAttachment: "platform", getClientExtensionResults: () => ({}),
    response: { authenticatorData: buf(), clientDataJSON: buf(), signature: buf(), userHandle: null },
  });
}

let web: Web;
beforeAll(async () => { web = await startWeb(PHONE_PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });

it("on the phone, a message typed while the passkey check is open stays in the box, and the first one goes once", { timeout: 30_000 }, async () => {
  const context = await web.browser.newContext({ viewport: { width: 390, height: 860 } });
  const tab: Page = await context.newPage();
  try {
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message));
    const sends: string[] = [];
    let verifyAsked = false;
    let release = () => {};
    const released = new Promise<void>(r => (release = r));
    const json = (b: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(b) });
    await tab.route("**/api/stepup/options", route => route.fulfill(json({ flowId: "flow-1", options: { challenge: "AAAA", rpId: "127.0.0.1", allowCredentials: [], userVerification: "required", timeout: 60_000 } })));
    await tab.route("**/api/stepup/verify", async route => { verifyAsked = true; await released; await route.fulfill(json({ ok: true })); });
    await tab.route(/\/api\/workers\/[^/]+\/send$/, async route => {
      const body = route.request().postDataJSON() as { requestId: string; text: string };
      sends.push(body.text);
      await route.fulfill(json({ ok: true, at: Date.now() }));
    });
    await tab.addInitScript(fakePasskey);
    await tab.addInitScript(fakeFeed, { workers: [{ id: "%1", name: "alpha" }] });
    await tab.goto(web.url);
    await tab.locator('[data-chat="alpha"]').click();
    const box = tab.getByRole("region", { name: "Conversation with alpha" }).getByRole("textbox", { name: "Message alpha" });
    await box.fill("ship the alpha release");
    await box.press("Enter");
    await expect.poll(() => verifyAsked, { timeout: 10_000 }).toBe(true);
    await box.fill("and a second thought");
    await box.press("Enter");                                      // ignored: the check is still open
    release();
    await expect.poll(() => sends, { timeout: 10_000 }).toEqual(["ship the alpha release"]);
    await tab.waitForTimeout(300);
    expect(await box.inputValue()).toBe("and a second thought");
    expect(sends).toEqual(["ship the alpha release"]);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
