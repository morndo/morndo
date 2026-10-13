// The closed card's "Nothing was answered from here." (review of PR #55): it says the ask was answered by someone
// else, so it belongs under an explicit "elsewhere" only. An answer whose via is absent — the hub can no longer say
// which device's it was — claims neither side and must not say it; "here" never does. The phone's catch-up card, in
// headless Chromium, with the three vias the feed sends. Synthetic data only.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Escalations, endpointId, escalationId, sessionId, type Ask, type Decision } from "@morndo/domain";
import { startWeb, type Web } from "./harness.ts";

const NOW = Date.now();
const ask: Ask = {
  id: escalationId("ny-7"), asker: { kind: "manager", name: "Manager", workerId: "%0" }, need: "decision",
  title: "Ship the demo release tonight?", shortTitle: null, summary: null, minutes: null, link: null, details: null,
  context: null, contextKind: "markdown",
  options: [{ key: "ship", label: "Ship it", detail: null }, { key: "hold", label: "Hold", detail: null }],
  answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null,
  askedAt: NOW - 20 * 60_000, messageId: null, tracking: "ledger",
};
const board = new Escalations();
board.reconcile([{ ask, source: { kind: "open" }, answered: null }], NOW, true);
const answered = board.record("ny-7", { kind: "option", key: "ship" }, { endpointId: endpointId("ep-1"), sessionId: sessionId("s-1") }, NOW);
if (!answered.ok) throw new Error(String(answered.error));
const stored = board.get("ny-7")!;

// The three vias one client can be sent (escalation.ts viaFor): the endpoint that answered reads "here"; another
// endpoint reads "elsewhere"; a record that names no endpoint and wasn't seen elsewhere reads no via at all.
const asViewer = (via: "here" | "elsewhere" | undefined): typeof stored & { answerable: null; version: string } => ({
  ...stored, answerable: null, version: "v1",
  ...(via === undefined ? { decision: { ...stored.decision!, endpointId: null, via: undefined } as Decision } : { decision: { ...stored.decision!, via } as Decision }),
});
const HERE = asViewer("here");
const ELSEWHERE = asViewer("elsewhere");
const ABSENT = asViewer(undefined);                        // JSON.stringify drops a via of undefined, as the feed does

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import DecisionCard from "/src/lib/phone/DecisionCard.svelte";
  const items = { here: ${JSON.stringify(HERE)}, elsewhere: ${JSON.stringify(ELSEWHERE)}, absent: ${JSON.stringify(ABSENT)} };
  const view = new URLSearchParams(location.search).get("via") ?? "absent";
  mount(DecisionCard, { target: document.body, props: { item: items[view], primed: true, index: 1, of: 1, now: Date.now(),
    answering: null, refusal: null, note: null, onPick: async () => true, onUndo() {}, onVerifyAgain() {}, onTryAgain() {}, onScreen() {}, onNext() {} } });
  window.__ready = true;
</script></body></html>`;

let web: Web;
let tab: Page;
let errors: string[];
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });
afterEach(async () => { await tab?.context().close(); });

const NOTE = /Nothing was answered from here/;
async function open(via: string) {
  const context = await web.browser.newContext({ viewport: { width: 390, height: 844 } });
  tab = await context.newPage();
  errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.goto(`${web.url}?via=${via}`);
  await tab.waitForFunction(() => (globalThis as unknown as { __ready?: boolean }).__ready === true);
}

describe("the closed card's note under the three vias", () => {
  it("an answer answered elsewhere says nothing was answered from here", { timeout: 60_000 }, async () => {
    await open("elsewhere");
    await tab.getByRole("status").waitFor({ timeout: 10_000 });
    expect(await tab.getByText(NOTE).count()).toBe(1);
    expect(errors).toEqual([]);
  });

  it("an answer whose via is absent (the hub can no longer say whose it was) says nothing of the kind", { timeout: 60_000 }, async () => {
    await open("absent");
    await tab.getByRole("status").waitFor({ timeout: 10_000 });
    expect(await tab.getByText(NOTE).count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("an answer from this device itself never says it", { timeout: 60_000 }, async () => {
    await open("here");
    await tab.getByRole("status").waitFor({ timeout: 10_000 });
    expect(await tab.getByText(NOTE).count()).toBe(0);
    expect(errors).toEqual([]);
  });
});
