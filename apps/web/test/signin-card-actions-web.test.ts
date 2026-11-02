// signin- asks refuse typed answers: cards offer Sign in (and Details / Read the brief), not own-words actions.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const SIGNIN_ITEM = {
  id: "signin-n3-claude-a4",
  asker: { kind: "worker", name: "sign-in", workerId: null },
  need: "time", title: "Claude a4 on n3 is signed out", shortTitle: null, summary: null, minutes: null, link: null,
  details: null, context: null, contextKind: "markdown",
  options: [{ key: "signin", label: "Sign in", detail: null }],
  answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null,
  askedAt: Date.now() - 60_000, messageId: null, tracking: "hub", status: "open", source: "open",
  decision: null, resolution: null, settledAt: null, askedAgain: false, answerable: null,
  version: "v1", brief: null, briefVersion: 0, draftedBy: null, notice: null,
};

function desktopPage() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import DecisionCard from "/src/lib/desktop/DecisionCard.svelte";
  mount(DecisionCard, { target: document.body, props: {
    item: ${JSON.stringify(SIGNIN_ITEM)}, variant: "inline", now: Date.now(), verifiedFresh: true,
    onAnswer: async () => null, onOpenScreen: () => {},
  } });
</script></body></html>`;
}

function phonePage() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import DecisionCard from "/src/lib/phone/DecisionCard.svelte";
  mount(DecisionCard, { target: document.body, props: {
    item: ${JSON.stringify(SIGNIN_ITEM)}, primed: true, index: 1, of: 1, now: Date.now(),
    answering: null, refusal: null, note: null, onPick: async () => true, onUndo() {}, onVerifyAgain() {}, onTryAgain() {}, onScreen() {}, onNext() {},
  } });
</script></body></html>`;
}

describe("signin- decision cards", () => {
  let desktop: Web;
  let phone: Web;
  beforeAll(async () => {
    desktop = await startWeb(desktopPage());
    phone = await startWeb(phonePage());
  }, 60_000);
  afterAll(async () => { await desktop?.close(); await phone?.close(); });

  it("on desktop inline, Sign in without Something else", async () => {
    const page = await desktop.browser.newPage();
    try {
      await page.goto(desktop.url);
      expect(await page.getByRole("button", { name: "Sign in" }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Something else…" }).count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("on the phone, Sign in without own words", async () => {
    const page = await phone.browser.newPage();
    try {
      await page.goto(phone.url);
      expect(await page.getByRole("button", { name: "Sign in" }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Answer in my own words" }).count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});
