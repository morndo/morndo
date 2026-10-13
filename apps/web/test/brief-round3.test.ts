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

async function doubt() {
  await tab.evaluate(() => { (globalThis as { __problem?: { code: string; text: string } }).__problem = { code: "uncertain", text: "May have been sent." }; });
}

describe("round 3: Check again still asks when the brief was restated", () => {
  it("Check again on the card sends the in-doubt answer after a restate", async () => {
    await ready();
    await doubt();
    await show([tap("d-re", "v1", "Extend the triage script")]);
    const card = tab.locator('[data-decision="d-re"]');
    await card.getByRole("button", { name: "Extend the triage script" }).click();
    await card.getByRole("button", { name: "Send answer" }).click();
    await card.getByRole("button", { name: "Check again" }).waitFor();
    await show([tap("d-re", "v2", "Buy a hosted add-on")]);
    await card.getByRole("button", { name: "Check again" }).click();
    await tab.waitForFunction(() => ((globalThis as { __answers?: { requestId: string }[] }).__answers?.length ?? 0) >= 2);
    const sent = await tab.evaluate(() => (globalThis as { __answers?: { requestId: string }[] }).__answers ?? []);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.requestId).toBe(sent[1]?.requestId);
  }, 60_000);

  it("Check again in the brief sends the in-doubt answer after a restate", async () => {
    await ready();
    await doubt();
    await show([tap("d-re", "v1", "Extend the triage script")]);
    const card = tab.locator('[data-decision="d-re"]');
    await card.getByRole("button", { name: "Ship the weekly notes" }).click();
    const dialog = tab.getByRole("dialog");
    await dialog.getByRole("button", { name: "Extend the triage script" }).click();
    await dialog.getByRole("button", { name: "Send answer" }).click();
    await dialog.getByRole("button", { name: "Check again" }).waitFor();
    await show([tap("d-re", "v2", "Buy a hosted add-on")]);
    await dialog.getByRole("button", { name: "Check again" }).click();
    await tab.waitForFunction(() => ((globalThis as { __answers?: unknown[] }).__answers?.length ?? 0) >= 2);
    expect(await answers()).toHaveLength(2);
  }, 60_000);
});

async function holdAnswer() {
  await tab.evaluate(() => {
    let go: () => void = () => {};
    (globalThis as { __answerGate?: Promise<void>; __releaseAnswer?: () => void }).__answerGate = new Promise<void>(r => { go = r; });
    (globalThis as { __releaseAnswer?: () => void }).__releaseAnswer = () => go();
  });
}

async function releaseAnswer() {
  await tab.evaluate(() => (globalThis as { __releaseAnswer?: () => void }).__releaseAnswer?.());
}

describe("round 3: the card and the brief share one answer footer", () => {
  it("words mode says Back on the card and in the brief", async () => {
    await ready();
    await show([tap("d-re", "v1", "Extend the triage script")]);
    const card = tab.locator('[data-decision="d-re"]');
    await card.getByRole("button", { name: "Something else…" }).click();
    await card.getByRole("button", { name: "Back", exact: true }).waitFor();
    expect(await card.getByRole("button", { name: "Cancel", exact: true }).count()).toBe(0);
    await card.getByRole("textbox", { name: "Your answer for the manager" }).waitFor();
    await card.getByRole("button", { name: "Ship the weekly notes" }).click();
    const dialog = tab.getByRole("dialog");
    await dialog.getByRole("button", { name: "Back", exact: true }).waitFor();
    expect(await dialog.getByRole("button", { name: "Cancel", exact: true }).count()).toBe(0);
    await dialog.getByRole("textbox", { name: "Your answer for the manager" }).waitFor();
  }, 60_000);
});

describe("round 3: a decision that leaves the list drops its session", () => {
  it("keeps Sent across a brief gap, and is fresh once the gap has lasted a minute", async () => {
    const errors = await ready();
    const item = tap("d-gone", "v1", "Extend the triage script");
    await show([item]);
    const card = tab.locator('[data-decision="d-gone"]');
    await card.getByRole("button", { name: "Ship the weekly notes" }).click();
    const dialog = tab.getByRole("dialog");
    await dialog.getByRole("button", { name: "Extend the triage script" }).click();
    await dialog.getByRole("button", { name: "Send answer" }).click();
    await dialog.getByText(/^Sent\./).waitFor();
    await show([]);
    await dialog.waitFor({ state: "hidden" });
    await show([item]);
    await tab.locator('[data-decision="d-gone"]').getByRole("button", { name: "Ship the weekly notes" }).click();
    const again = tab.getByRole("dialog");
    await again.getByText(/^Sent\./).waitFor();
    expect(await again.getByRole("button", { name: "Extend the triage script" }).count()).toBe(0);
    await tab.keyboard.press("Escape");
    await again.waitFor({ state: "hidden" });
    await show([]);
    await tab.evaluate(t => (globalThis as unknown as { __setNow: (n: number) => void }).__setNow(t), NOW + 60_000);
    await show([item]);
    await tab.locator('[data-decision="d-gone"]').getByRole("button", { name: "Ship the weekly notes" }).click();
    const fresh = tab.getByRole("dialog");
    await fresh.getByRole("button", { name: "Extend the triage script" }).waitFor();
    expect(await fresh.getByText(/^Sent\./).count()).toBe(0);
    expect(errors).toEqual([]);
  }, 60_000);
});

describe("round 3: a refusal stays when the item closes in the same tick", () => {
  it("shows the refusal when the feed closes the item before the POST returns", async () => {
    await ready();
    await holdAnswer();
    await tab.evaluate(() => { (globalThis as { __problem?: { code: string; text: string } }).__problem = { code: "already_answered", text: "This was already answered." }; });
    await show([tap("d-re", "v1", "Extend the triage script")]);
    const card = tab.locator('[data-decision="d-re"]');
    await card.getByRole("button", { name: "Ship the weekly notes" }).click();
    const dialog = tab.getByRole("dialog");
    await dialog.getByRole("button", { name: "Extend the triage script" }).click();
    await dialog.getByRole("button", { name: "Send answer" }).click();
    await tab.waitForFunction(() => ((globalThis as { __answers?: unknown[] }).__answers?.length ?? 0) >= 1);
    await show([tap("d-re", "v1", "Extend the triage script", { status: "answered" })]);
    await releaseAnswer();
    await dialog.getByText("This was already answered.").waitFor();
  }, 60_000);

  it("clears an in-doubt answer when the item closes before Check again returns", async () => {
    await ready();
    await holdAnswer();
    await tab.evaluate(() => { (globalThis as { __problem?: { code: string; text: string } }).__problem = { code: "uncertain", text: "May have been sent." }; });
    await show([tap("d-re", "v1", "Extend the triage script")]);
    const card = tab.locator('[data-decision="d-re"]');
    await card.getByRole("button", { name: "Ship the weekly notes" }).click();
    const dialog = tab.getByRole("dialog");
    await dialog.getByRole("button", { name: "Extend the triage script" }).click();
    await dialog.getByRole("button", { name: "Send answer" }).click();
    await tab.waitForFunction(() => ((globalThis as { __answers?: unknown[] }).__answers?.length ?? 0) >= 1);
    await show([tap("d-re", "v1", "Extend the triage script", { status: "expired" })]);
    await releaseAnswer();
    await dialog.getByText("no longer open").waitFor();
    expect(await dialog.getByText("May have been sent.").count()).toBe(0);
    expect(await dialog.getByRole("button", { name: "Check again" }).count()).toBe(0);
  }, 60_000);
});

describe("round 3: a successful answer that the feed already shows is sent", () => {
  it("shows Sent when the answered status arrives before the POST returns", async () => {
    await ready();
    await holdAnswer();
    await show([tap("d-re", "v1", "Extend the triage script")]);
    const card = tab.locator('[data-decision="d-re"]');
    await card.getByRole("button", { name: "Ship the weekly notes" }).click();
    const dialog = tab.getByRole("dialog");
    await dialog.getByRole("button", { name: "Extend the triage script" }).click();
    await dialog.getByRole("button", { name: "Send answer" }).click();
    await tab.waitForFunction(() => ((globalThis as { __answers?: unknown[] }).__answers?.length ?? 0) >= 1);
    await show([tap("d-re", "v1", "Extend the triage script", {
      status: "answered",
      decision: { choice: { kind: "option", key: "b", label: "Extend the triage script" }, at: NOW, via: "here", endpointId: null, sessionId: null },
    })]);
    await releaseAnswer();
    await dialog.getByText(/^Sent\./).waitFor();
    expect(await dialog.getByText("no longer open").count()).toBe(0);
  }, 60_000);
});

describe("round 3: a restated card does not offer a send that does nothing", () => {
  it("confirm mode shows the new version and keeps Send disabled", async () => {
    await ready();
    await show([tap("d-re", "v1", "Extend the triage script")]);
    const card = tab.locator('[data-decision="d-re"]');
    await card.getByRole("button", { name: "Extend the triage script" }).click();
    await card.getByText("Your answer: Extend the triage script").waitFor();
    await show([tap("d-re", "v2", "Buy a hosted add-on")]);
    await card.getByText("restated this brief").waitFor();
    const send = card.getByRole("button", { name: "Send answer" });
    expect(await send.isDisabled()).toBe(true);
    await card.getByRole("button", { name: "Show the new version" }).click();
    const next = card.getByRole("button", { name: "Buy a hosted add-on", exact: true });
    await next.waitFor();
    expect(await next.isDisabled()).toBe(false);
    expect(await card.getByRole("button", { name: "Send answer" }).count()).toBe(0);
  }, 60_000);

  it("words mode shows the new version and keeps Send disabled", async () => {
    await ready();
    await show([tap("d-re", "v1", "Extend the triage script")]);
    const card = tab.locator('[data-decision="d-re"]');
    await card.getByRole("button", { name: "Something else…" }).click();
    await card.getByRole("textbox", { name: "Your answer for the manager" }).fill("Ship on Tuesday");
    await show([tap("d-re", "v2", "Buy a hosted add-on")]);
    await card.getByText("restated this brief").waitFor();
    const send = card.getByRole("button", { name: "Send to the manager" });
    expect(await send.isDisabled()).toBe(true);
    await card.getByRole("button", { name: "Show the new version" }).click();
    expect(await card.getByRole("button", { name: "Something else…" }).isDisabled()).toBe(false);
  }, 60_000);

  it("Back from a restated confirmation still explains why the options are disabled", async () => {
    await ready();
    await show([tap("d-re", "v1", "Extend the triage script")]);
    const card = tab.locator('[data-decision="d-re"]');
    await card.getByRole("button", { name: "Extend the triage script" }).click();
    await show([tap("d-re", "v2", "Buy a hosted add-on")]);
    await card.getByRole("button", { name: "Back" }).click();
    await card.getByText("restated this brief").waitFor();
    expect(await card.getByRole("button", { name: "Buy a hosted add-on", exact: true }).isDisabled()).toBe(true);
    expect(await card.getByRole("button", { name: "Something else…" }).count()).toBe(0);
    await card.getByRole("button", { name: "Show the new version" }).click();
    expect(await card.getByRole("button", { name: "Buy a hosted add-on", exact: true }).isDisabled()).toBe(false);
  }, 60_000);
});

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
