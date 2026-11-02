// Phone DecisionCard: the own-words box closes once the answer has started (PR #7 finding 13).
import { afterAll, beforeAll, describe, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const ITEM = {
  id: "ny-words-1",
  asker: { kind: "manager", name: "Manager", workerId: "%0" },
  need: "decision", title: "Ship the demo?", shortTitle: null, summary: null, minutes: null, link: null, details: null,
  context: null, contextKind: "markdown", options: [], answerBy: "words", recommendation: null, ifNoAnswer: null,
  deadline: null, blocking: false, project: null, askedAt: Date.now() - 60_000, messageId: null, tracking: "ledger",
  status: "open", source: "open", decision: null, resolution: null, settledAt: null, askedAgain: false,
  answerable: null, version: "v1", brief: null, briefVersion: 0, draftedBy: null, notice: null,
};

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import DecisionCard from "/src/lib/phone/DecisionCard.svelte";
  mount(DecisionCard, { target: document.body, props: {
    item: ${JSON.stringify(ITEM)}, primed: true, index: 1, of: 1, now: Date.now(), answering: null, refusal: null, note: null,
    onPick: async () => true, onUndo() {}, onVerifyAgain() {}, onTryAgain() {}, onScreen() {}, onNext() {},
  } });
</script></body></html>`;
}

describe("phone own words after send", () => {
  let web: Web;
  beforeAll(async () => { web = await startWeb(pageHtml()); }, 60_000);
  afterAll(async () => { await web?.close(); });

  it("closes the textarea once onPick accepts the answer", async () => {
    const page = await web.browser.newPage();
    try {
      await page.goto(web.url);
      await page.getByRole("button", { name: "Answer in my own words" }).click();
      await page.locator("#words").fill("We ship Friday.");
      await page.getByRole("button", { name: "Send to Manager" }).click();
      await page.locator("#words").waitFor({ state: "detached", timeout: 5000 });
      await page.getByRole("button", { name: "Answer in my own words" }).waitFor();
    } finally {
      await page.close();
    }
  });
});
