// Add-account start refused with exists: the sheet offers to sign the folder in without create.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const TARGET = { node: "n2", runtime: "claude", account: "a3", create: true };

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
  window.__starts = [];
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://test").pathname;
    const headers = { "content-type": "application/json" };
    if (url === "/api/signins" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      window.__starts.push(body);
      if (body.create) {
        return new Response(JSON.stringify({ error: "exists" }), { status: 409, headers });
      }
      return new Response(JSON.stringify({
        id: "si-exists-1", node: body.node, runtime: body.runtime, account: body.account, create: false,
        phase: "waiting", link: "https://claude.com/cai/oauth/authorize?x=1", userCode: null, needsCode: false,
        recipient: null, startedAt: Date.now(), expiresAt: Date.now() + 600000, identity: null, problem: null,
      }), { status: 200, headers });
    }
    return new Response("{}", { status: 404, headers });
  };
</script><script type="module">
  import { mount } from "svelte";
  import SignInSheet from "/src/lib/signin/SignInSheet.svelte";
  mount(SignInSheet, { target: document.body, props: { target: ${JSON.stringify(TARGET)}, open: true } });
</script></body></html>`;
}

describe("sign-in start when the account folder already exists", () => {
  let web: Web;
  beforeAll(async () => { web = await startWeb(pageHtml()); }, 60_000);
  afterAll(async () => { await web?.close(); });

  it("shows Sign it in and retries with create false", async () => {
    const page = await web.browser.newPage();
    try {
      await page.goto(web.url);
      const sheet = page.getByRole("dialog", { name: /Sign in/ });
      await sheet.getByRole("button", { name: "Start sign-in" }).click();
      await sheet.getByText("This account's folder already exists on the node.").waitFor();
      await sheet.getByRole("button", { name: "Sign it in" }).click();
      await sheet.getByRole("link", { name: "Open sign-in page" }).waitFor({ timeout: 10_000 });
      const starts = await page.evaluate(() => (window as unknown as { __starts: { create: boolean }[] }).__starts);
      expect(starts).toEqual([{ node: "n2", runtime: "claude", account: "a3", create: true }, { node: "n2", runtime: "claude", account: "a3", create: false }]);
    } finally {
      await page.close();
    }
  });
});
