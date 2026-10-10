// Validation of review finding #11 (phone/DecisionCard.svelte): actions(item, "card") gives a task (need "time") Done and
// Later, but the card renders only option, default and words, while its "or" divider counts every action. Reachability
// is shown with the real code: the hub's Escalations (an open Ask whose list kind turns to "time" keeps its id and stays
// open), catchUpCards (a task is no card, C1) and the run's refresh (the card on top stays). Then the real
// DecisionCard.svelte, compiled by Vite's Svelte plugin, in headless Chromium, gets that item. Synthetic data only.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Escalations, catchUpCards, escalationId, type Ask, type Escalation } from "@morndo/domain";
import { current, newRun, refresh } from "../src/lib/catchup/run.ts";
import { startWeb, type Web } from "./harness.ts";

const NOW = Date.now();
const ask = (need: "decision" | "time"): Ask => ({
  id: escalationId("ny-11"), asker: { kind: "manager", name: "Manager", workerId: "%0" }, need,
  title: "Water the office plants before the weekend", shortTitle: null, summary: null, minutes: 5, link: null, details: null,
  context: null, contextKind: "markdown", options: [], answerBy: "words", recommendation: null, ifNoAnswer: null,
  deadline: null, blocking: false, project: null, askedAt: NOW - 20 * 60_000, messageId: null, tracking: "ledger",
});
const sight = (need: "decision" | "time") => ({ ask: ask(need), source: { kind: "open" as const }, answered: null });
const look = (e: Escalation[]) => catchUpCards({ decisions: e, conversations: [], reads: {}, muted: [] });

// The board item after the flip (the hub's EscalationView: answerable and version added).
const x = new Escalations();
x.reconcile([sight("decision")], NOW, true);
const before = look(x.list());
x.reconcile([sight("time")], NOW + 1000, true);
const flipped = x.get("ny-11") as Escalation;
const item = { ...flipped, answerable: null, version: "v1" };
const asDecision = { ...item, need: "decision" };                         // the same item before the flip (control)

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="flipped"></div><div id="before"></div><script type="module">
  import { mount } from "svelte";
  import DecisionCard from "/src/lib/phone/DecisionCard.svelte";
  const card = (id, item) => mount(DecisionCard, { target: document.getElementById(id), props: { item, primed: true, index: 1, of: 1, now: Date.now(), answering: null, refusal: null, note: null,
    onPick: async () => true, onUndo() {}, onVerifyAgain() {}, onTryAgain() {}, onScreen() {}, onNext() {} } });
  card("flipped", ${JSON.stringify(item)});
  card("before", ${JSON.stringify(asDecision)});
  window.__ready = true;
</script></body></html>`;

let web: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });
afterEach(async () => { await tab?.context().close(); });

describe("a decision card whose Ask turned into a task while on top (finding #11)", () => {
  it("is reachable: same id, still open, need time; no card any more, yet the run keeps it on top", () => {
    expect(before.map(c => c.key)).toEqual(["d:ny-11"]);
    expect(flipped.status).toBe("open");
    expect(flipped.need).toBe("time");
    expect(look(x.list())).toEqual([]);                                   // C1: a task is no card
    const run = refresh(newRun(before, NOW), look(x.list()));
    expect(current(run)?.key).toBe("d:ny-11");                            // "the card on top stays"
  });

  it("never shows an 'or' with no answer button before it", async () => {
    tab = await (await web.browser.newContext()).newPage();
    await tab.goto(web.url);
    await tab.waitForFunction(() => (globalThis as unknown as { __ready?: boolean }).__ready === true);
    // What a card's answer area holds, in order: "or" for the divider, else each button's words.
    const area = (id: string) => tab.locator(`#${id} .opts`).evaluate(el => [...el.children].map(c => (c.classList.contains("or") ? "or" : (c.textContent ?? "").trim())));
    await tab.locator("#flipped .opts").waitFor();
    // Control: the same item as a decision (before the flip) shows its words button alone, no divider.
    expect(await area("before")).toEqual(["Answer in my own words"]);
    const shown = await area("flipped");
    expect(shown).toContain("Answer in my own words");
    const at = shown.indexOf("or");
    expect(at === -1 || at > 0, `the card's answer area: ${JSON.stringify(shown)}`).toBe(true);
  }, 60_000);
});
