// Review round 4 of the desktop brief (PR #47). The real DecisionsPanel, headless Chromium, synthetic data.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { startWeb, type Web } from "./harness.ts";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const DUE = Date.parse("2026-10-16T21:59:59Z");

type Item = Record<string, unknown>;

function tap(id: string, version: string, label: string, over: Item = {}): Item {
  return {
    id, asker: { kind: "manager", name: "Manager", workerId: "w-manager" }, need: "decision",
    title: "Ship the weekly notes", shortTitle: "Weekly notes", summary: "Ship the weekly notes",
    minutes: null, link: null, details: null, context: null, contextKind: "markdown",
    options: [
      { key: "b", label, detail: null },
      { key: "a", label: "Hold the notes", detail: null },
    ],
    answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: DUE, blocking: false, project: null,
    askedAt: NOW - 3_600_000, messageId: null, tracking: "hub", status: "open", source: "open",
    decision: null, resolution: null, settledAt: null, askedAgain: false, answerable: null,
    version, inbox: null, brief: null, briefVersion: 0, draftedBy: null, notice: null,
    ...over,
  };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script type="module">
  import "@morndo/brand/tokens.css";
  import "/src/lib/desktop/desk-tokens.css";
  import { mount } from "svelte";
  import Harness from "/test/BriefHarness.svelte";
  mount(Harness, { target: document.body, props: { initial: [], now: ${NOW} } });
</script></body></html>`;

let web: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });

async function ready() {
  tab = await (await web.browser.newContext()).newPage();
  const errors: string[] = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.goto(web.url);
  await tab.waitForFunction(() => (globalThis as { __ready?: boolean }).__ready === true);
  return errors;
}

async function show(items: Item[]) {
  await tab.evaluate(next => (globalThis as unknown as { __setItems: (n: unknown) => void }).__setItems(next), items);
}

async function setNow(n: number) {
  await tab.evaluate(t => (globalThis as unknown as { __setNow: (n: number) => void }).__setNow(t), n);
}

async function doubt() {
  await tab.evaluate(() => { (globalThis as { __problem?: { code: string; text: string } }).__problem = { code: "uncertain", text: "May have been sent." }; });
}

describe("round 4: a brief gap keeps an answer that must not be sent twice", () => {
  it("an answer in doubt keeps its request id when the decision returns", async () => {
    await ready();
    await doubt();
    const item = tap("d-gap", "v1", "Extend the triage script");
    await show([item]);
    const card = tab.locator('[data-decision="d-gap"]');
    await card.getByRole("button", { name: "Extend the triage script" }).click();
    await card.getByRole("button", { name: "Send answer" }).click();
    await card.getByRole("button", { name: "Check again" }).waitFor();
    await show([]);
    await show([item]);
    const back = tab.locator('[data-decision="d-gap"]');
    await back.getByRole("button", { name: "Check again" }).click();
    await tab.waitForFunction(() => ((globalThis as { __answers?: { requestId: string }[] }).__answers?.length ?? 0) >= 2);
    const sent = await tab.evaluate(() => (globalThis as { __answers?: { requestId: string }[] }).__answers ?? []);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.requestId).toBe(sent[1]?.requestId);
    expect(await back.getByRole("button", { name: "Hold the notes" }).count()).toBe(0);
  }, 60_000);

  it("a sent answer is still sent when the decision returns at once", async () => {
    await ready();
    const item = tap("d-gap", "v1", "Extend the triage script");
    await show([item]);
    const card = tab.locator('[data-decision="d-gap"]');
    await card.getByRole("button", { name: "Ship the weekly notes" }).click();
    const dialog = tab.getByRole("dialog");
    await dialog.getByRole("button", { name: "Extend the triage script" }).click();
    await dialog.getByRole("button", { name: "Send answer" }).click();
    await dialog.getByText(/^Sent\./).waitFor();
    await show([]);
    await dialog.waitFor({ state: "hidden" });
    await show([item]);
    await tab.locator('[data-decision="d-gap"]').getByRole("button", { name: "Ship the weekly notes" }).click();
    const again = tab.getByRole("dialog");
    await again.getByText(/^Sent\./).waitFor();
    expect(await again.getByRole("button", { name: "Extend the triage script" }).count()).toBe(0);
  }, 60_000);

  it("typed words are still there when the decision returns at once", async () => {
    await ready();
    const item = tap("d-gap", "v1", "Extend the triage script");
    await show([item]);
    const card = tab.locator('[data-decision="d-gap"]');
    await card.getByRole("button", { name: "Something else…" }).click();
    await card.getByRole("textbox", { name: "Your answer for the manager" }).fill("Ship on Tuesday");
    await show([]);
    await show([item]);
    const box = tab.locator('[data-decision="d-gap"]').getByRole("textbox", { name: "Your answer for the manager" });
    await box.waitFor();
    expect(await box.inputValue()).toBe("Ship on Tuesday");
  }, 60_000);

  it("drops the held answer once the decision has been gone for a minute", async () => {
    await ready();
    const item = tap("d-gap", "v1", "Extend the triage script");
    await show([item]);
    const card = tab.locator('[data-decision="d-gap"]');
    await card.getByRole("button", { name: "Something else…" }).click();
    await card.getByRole("textbox", { name: "Your answer for the manager" }).fill("Ship on Tuesday");
    await show([]);
    await setNow(NOW + 60_000);
    await show([item]);
    const back = tab.locator('[data-decision="d-gap"]');
    await back.getByRole("button", { name: "Something else…" }).waitFor();
    expect(await back.getByRole("textbox", { name: "Your answer for the manager" }).count()).toBe(0);
  }, 60_000);

  it("drops the held answer at once when the decision left closed", async () => {
    await ready();
    const item = tap("d-gap", "v1", "Extend the triage script");
    await show([item]);
    const card = tab.locator('[data-decision="d-gap"]');
    await card.getByRole("button", { name: "Something else…" }).click();
    await card.getByRole("textbox", { name: "Your answer for the manager" }).fill("Ship on Tuesday");
    await show([tap("d-gap", "v1", "Extend the triage script", { status: "expired" })]);
    await show([]);
    await show([item]);
    const back = tab.locator('[data-decision="d-gap"]');
    await back.getByRole("button", { name: "Something else…" }).waitFor();
    expect(await back.getByRole("textbox", { name: "Your answer for the manager" }).count()).toBe(0);
  }, 60_000);
});
