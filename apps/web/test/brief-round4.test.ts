// Review round 4 of the desktop brief (PR #47). The real DecisionsPanel, headless Chromium, synthetic data.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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

describe("round 4: a success settled elsewhere is not Sent", () => {
  it("says the decision is no longer open when another device already answered it", async () => {
    await ready();
    await holdAnswer();
    await show([tap("d-else", "v1", "Extend the triage script")]);
    const card = tab.locator('[data-decision="d-else"]');
    await card.getByRole("button", { name: "Ship the weekly notes" }).click();
    const dialog = tab.getByRole("dialog");
    await dialog.getByRole("button", { name: "Extend the triage script" }).click();
    await dialog.getByRole("button", { name: "Send answer" }).click();
    await tab.waitForFunction(() => ((globalThis as { __answers?: unknown[] }).__answers?.length ?? 0) >= 1);
    await show([tap("d-else", "v1", "Extend the triage script", {
      status: "answered",
      decision: { choice: { kind: "option", key: "a", label: "Hold the notes" }, at: NOW, via: "elsewhere", endpointId: null, sessionId: null },
    })]);
    await releaseAnswer();
    await dialog.getByText("no longer open").waitFor();
    expect(await dialog.getByText(/^Sent\./).count()).toBe(0);
  }, 60_000);
});

describe("round 4: a stale card shows the version the pending answer targets", () => {
  it("keeps the old brief under the pick, with the banner, until the new version is shown", async () => {
    await ready();
    await show([tap("d-stale", "v1", "Extend the triage script")]);
    const card = tab.locator('[data-decision="d-stale"]');
    await card.getByRole("button", { name: "Extend the triage script" }).click();
    await card.getByText("Your answer: Extend the triage script").waitFor();
    await show([tap("d-stale", "v2", "Buy a hosted add-on", { summary: "Buy the hosted add-on" })]);
    await card.getByText("restated this brief").waitFor();
    await card.getByRole("button", { name: "Ship the weekly notes" }).waitFor();
    expect(await card.getByRole("button", { name: "Buy the hosted add-on" }).count()).toBe(0);
    expect(await card.getByText("Your answer: Extend the triage script").count()).toBe(1);
    const qa = process.env.QA_DIR;
    if (qa) {
      mkdirSync(qa, { recursive: true });
      await tab.emulateMedia({ colorScheme: "light" });
      await card.screenshot({ path: join(qa, "briefs-card-stale-light.png") });
      await tab.emulateMedia({ colorScheme: "dark" });
      await card.screenshot({ path: join(qa, "briefs-card-stale-dark.png") });
      await tab.emulateMedia({ colorScheme: "light" });
    }
    await card.getByRole("button", { name: "Show the new version" }).click();
    await card.getByRole("button", { name: "Buy the hosted add-on" }).waitFor();
  }, 60_000);
});

describe("round 4: Check again takes focus when Send becomes it", () => {
  it("leaves focus on Check again in the brief", async () => {
    await ready();
    await doubt();
    await show([tap("d-focus", "v1", "Extend the triage script")]);
    const card = tab.locator('[data-decision="d-focus"]');
    await card.getByRole("button", { name: "Ship the weekly notes" }).click();
    const dialog = tab.getByRole("dialog");
    await dialog.getByRole("button", { name: "Extend the triage script" }).click();
    await dialog.getByRole("button", { name: "Send answer" }).click();
    const again = dialog.getByRole("button", { name: "Check again" });
    await again.waitFor();
    expect(await again.evaluate(el => el === document.activeElement)).toBe(true);
  }, 60_000);
});

describe("round 4: a restate during send keeps the sent confirmation", () => {
  it("shows Sent for the version that was posted, not the new answer buttons", async () => {
    await ready();
    await holdAnswer();
    await show([tap("d-race", "v1", "Extend the triage script")]);
    const card = tab.locator('[data-decision="d-race"]');
    await card.getByRole("button", { name: "Extend the triage script" }).click();
    await card.getByRole("button", { name: "Send answer" }).click();
    await tab.waitForFunction(() => ((globalThis as { __answers?: unknown[] }).__answers?.length ?? 0) >= 1);
    await show([tap("d-race", "v2", "Buy a hosted add-on")]);
    await releaseAnswer();
    await show([tap("d-race", "v2", "Buy a hosted add-on")]);
    await card.getByText(/^Sent\./).waitFor();
    expect(await card.getByRole("button", { name: "Buy a hosted add-on", exact: true }).count()).toBe(0);
    await card.getByRole("button", { name: "Show the new version" }).click();
    await card.getByRole("button", { name: "Buy a hosted add-on", exact: true }).waitFor();
    expect(await card.getByText(/^Sent\./).count()).toBe(0);
  }, 60_000);
});

describe("round 5: Sent names whoever asked", () => {
  it("names the lane, not the manager, when a lane asked", async () => {
    await ready();
    await show([tap("d-lane", "v1", "Extend the triage script", {
      asker: { kind: "worker", name: "docs-lane", workerId: "w-docs" },
    })]);
    const card = tab.locator('[data-decision="d-lane"]');
    await card.getByRole("button", { name: "Extend the triage script" }).click();
    await card.getByRole("button", { name: "Send answer" }).click();
    await card.getByText("Sent. Docs-lane gets it as your decision and acts on it.").waitFor();
    expect(await card.getByText("The manager gets it").count()).toBe(0);
  }, 60_000);
});
