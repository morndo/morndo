// Sign-in sheet: the one-time code is sealed before POST; a signin- card opens the sheet instead of answering.
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const TARGET = { node: "n1", runtime: "claude", account: "a8", create: true };
const LINK = "https://claude.com/cai/oauth/authorize?state=fake";
const PLAIN = "secret-code-xy";

function pageHtml(recipient: string) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
  window.__posts = [];
  window.__view = null;
  window.__recipient = ${JSON.stringify(recipient)};
  window.fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input.url;
    const url = new URL(raw, "http://test").pathname;
    const headers = { "content-type": "application/json" };
    if (url === "/api/signins" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      window.__posts.push({ url, body });
      window.__view = {
        id: "si-test-1", node: body.node, runtime: body.runtime, account: body.account, create: body.create,
        phase: "waiting", link: ${JSON.stringify(LINK)}, userCode: null, needsCode: true,
        recipient: window.__recipient, startedAt: Date.now(), expiresAt: Date.now() + 600000,
        identity: null, problem: null,
      };
      return new Response(JSON.stringify(window.__view), { status: 200, headers });
    }
    if (/^\\/api\\/signins\\/[^/]+\\/code$/.test(url) && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      window.__posts.push({ url, body });
      window.__view = { ...window.__view, phase: "done", identity: { email: "person@example.com", plan: "Pro" } };
      return new Response(JSON.stringify(window.__view), { status: 200, headers });
    }
    if (url === "/api/signins/si-test-1" && (!init || init.method === "GET")) {
      return new Response(JSON.stringify(window.__view), { status: 200, headers });
    }
    return new Response(JSON.stringify({ error: "missing" }), { status: 404, headers });
  };
</script><script type="module">
  import { mount } from "svelte";
  import SignInSheet from "/src/lib/signin/SignInSheet.svelte";
  mount(SignInSheet, { target: document.body, props: { target: ${JSON.stringify(TARGET)}, open: true } });
</script></body></html>`;
}

const CARD_ITEM = {
  id: "signin-n1-claude-a1",
  asker: { kind: "worker", name: "sign-in", workerId: null },
  need: "time",
  title: "Claude a1 on n1 is signed out",
  shortTitle: null, summary: null, minutes: null, link: null, details: null, context: null, contextKind: "markdown",
  options: [{ key: "signin", label: "Sign in", detail: null }],
  answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null,
  askedAt: Date.now() - 60_000, messageId: null, tracking: "hub", status: "open", source: "open",
  decision: null, resolution: null, settledAt: null, askedAgain: false, answerable: null,
  version: "v1", brief: null, briefVersion: 0, draftedBy: null, notice: null,
};

function cardPageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
  window.fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input.url;
    const url = new URL(raw, "http://test").pathname;
    const headers = { "content-type": "application/json" };
    if (url === "/api/signins/cards") {
      return new Response(JSON.stringify({ cards: [{ id: "signin-n1-claude-a1", node: "n1", runtime: "claude", account: "a1", create: false }] }), { status: 200, headers });
    }
    if (url === "/api/signins" && init?.method === "POST") {
      return new Response(JSON.stringify({
        id: "si-card-1", node: "n1", runtime: "claude", account: "a1", create: false,
        phase: "waiting", link: "", userCode: null, needsCode: false, recipient: null,
        startedAt: Date.now(), expiresAt: Date.now() + 600000, identity: null, problem: null,
      }), { status: 200, headers });
    }
    return new Response("{}", { status: 404, headers });
  };
</script><script type="module">
  import { mount } from "svelte";
  import DecisionCard from "/src/lib/desktop/DecisionCard.svelte";
  mount(DecisionCard, { target: document.body, props: {
    item: ${JSON.stringify(CARD_ITEM)}, variant: "panel", now: Date.now(), verifiedFresh: true,
    onAnswer: async () => null, onOpenScreen: () => {},
  } });
</script></body></html>`;
}

describe("the sign-in sheet", () => {
  let web: Web;
  beforeAll(async () => {
    const recipient = await identityToRecipient(await generateX25519Identity());
    web = await startWeb(pageHtml(recipient));
  }, 60_000);
  afterAll(async () => { await web?.close(); });

  it("never puts the plain code in a request body", async () => {
    const page = await web.browser.newPage();
    try {
      await page.goto(web.url);
      const sheet = page.getByRole("dialog", { name: /Sign in/ });
      await sheet.getByRole("button", { name: "Start sign-in" }).click();
      await sheet.getByRole("link", { name: "Open sign-in page" }).waitFor();
      await sheet.getByLabel("Code from the sign-in page").fill(PLAIN);
      await sheet.getByRole("button", { name: "Send code" }).click();
      await sheet.getByText("Works again").waitFor({ timeout: 10_000 });
      const posts = await page.evaluate(() => (window as unknown as { __posts: { body: unknown }[] }).__posts);
      const bodies = posts.map(p => JSON.stringify(p.body));
      for (const raw of bodies) expect(raw.includes(PLAIN), raw).toBe(false);
      expect(bodies.some(b => b.includes("sealed"))).toBe(true);
    } finally {
      await page.close();
    }
  });
});

describe("a signin- decision card", () => {
  let web: Web;
  beforeAll(async () => { web = await startWeb(cardPageHtml()); }, 60_000);
  afterAll(async () => { await web?.close(); });

  it("opens the sign-in sheet when Sign in is chosen", async () => {
    const page = await web.browser.newPage();
    try {
      await page.goto(web.url);
      await page.locator('[data-decision="signin-n1-claude-a1"]').getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("dialog", { name: /Sign in/ }).waitFor();
      expect(await page.getByRole("button", { name: "Start sign-in" }).count()).toBe(1);
    } finally {
      await page.close();
    }
  });
});
