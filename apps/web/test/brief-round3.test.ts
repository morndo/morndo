// Review round 3 of the desktop brief (PR #47). The real DecisionsPanel, headless Chromium, synthetic data.
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

async function answers() {
  return tab.evaluate(() => (globalThis as { __answers?: unknown[] }).__answers ?? []);
}

describe("round 3: a sent answer belongs to its version", () => {
  it("follows a re-ask on the card after the answer was sent", async () => {
    await ready();
    await show([tap("d-re", "v1", "Extend the triage script")]);
    const card = tab.locator('[data-decision="d-re"]');
    await card.getByRole("button", { name: "Extend the triage script" }).click();
    await card.getByRole("button", { name: "Send answer" }).click();
    await tab.waitForFunction(() => ((globalThis as { __answers?: unknown[] }).__answers?.length ?? 0) >= 1);
    await show([tap("d-re", "v2", "Buy a hosted add-on")]);
    const next = card.getByRole("button", { name: "Buy a hosted add-on", exact: true });
    await next.waitFor();
    expect(await next.isDisabled()).toBe(false);
    await next.click();
    await card.getByText("Your answer: Buy a hosted add-on").waitFor();
  }, 60_000);

  it("Show the new version after a sent answer offers the re-asked options", async () => {
    await ready();
    await show([tap("d-re", "v1", "Extend the triage script")]);
    const card = tab.locator('[data-decision="d-re"]');
    await card.getByRole("button", { name: "Ship the weekly notes" }).click();
    const dialog = tab.getByRole("dialog");
    await dialog.getByRole("button", { name: "Extend the triage script" }).click();
    await dialog.getByRole("button", { name: "Send answer" }).click();
    await dialog.getByText(/^Sent\./).waitFor();
    await show([tap("d-re", "v2", "Buy a hosted add-on")]);
    await dialog.getByRole("button", { name: "Show the new version" }).click();
    await dialog.getByRole("button", { name: "Buy a hosted add-on" }).waitFor();
    expect(await dialog.getByText(/^Sent\./).count()).toBe(0);
    expect(await answers()).toHaveLength(1);
  }, 60_000);
});
