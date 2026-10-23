// Home's usage card: an account that names its windows shows those bars, and a status-line account shows the
// 5-hour and weekly windows as it does today. Synthetic accounts only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const NOW = Date.UTC(2026, 9, 11, 21, 0, 0);
const RESET = Date.UTC(2026, 10, 8, 0, 0, 0);
const HOUR = 3_600_000;
const DEMAND = `on-demand ${"x".repeat(61)}`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Home from "/src/lib/desktop/HomeView.svelte";
  const NOW = ${NOW};
  const RESET = ${RESET};
  const HOUR = ${HOUR};
  const cursor = {
    account: "cursor", reportedAt: NOW - 60_000,
    fiveHour: { usedPercentage: 40, resetsAt: NOW + 2 * HOUR }, sevenDay: null,
    spend: { usedPercentage: 85, resetsAt: RESET, usedUsd: null, limitUsd: null, period: "included usage, monthly" },
    sessions: [{ sessionId: "cursor-plan", lane: "usage-collector", model: "Cursor Ultra · Auto 88% · API 45% · on-demand off", contextUsed: null, at: NOW }],
    limits: [
      { label: "Cursor models", usedPercentage: 88, resetsAt: RESET, resetsOn: "2026-11-07" },
      { label: "Other models", usedPercentage: 45, resetsAt: RESET, resetsOn: "2026-11-07" },
    ],
    onDemand: "off",
  };
  const near = {
    account: "near", reportedAt: NOW - 30_000,
    fiveHour: null, sevenDay: null, spend: null, sessions: [],
    limits: [{ label: "Cursor models", usedPercentage: 92, resetsAt: RESET, resetsOn: "2026-11-07" }],
    onDemand: null,
  };
  const blank = {
    account: "blank", reportedAt: NOW - 30_000,
    fiveHour: { usedPercentage: 12, resetsAt: NOW + 4 * HOUR }, sevenDay: null, spend: null, sessions: [],
    limits: [], onDemand: "off",
  };
  const metered = {
    account: "metered", reportedAt: NOW - 30_000,
    fiveHour: null, sevenDay: null, spend: null, sessions: [],
    limits: [{ label: "Included", usedPercentage: 10, resetsAt: RESET, resetsOn: "2026-11-07" }],
    onDemand: ${JSON.stringify(DEMAND)},
  };
  const claude = {
    account: "max-1", reportedAt: NOW - 120_000,
    fiveHour: { usedPercentage: 23.5, resetsAt: NOW + 2 * HOUR },
    sevenDay: { usedPercentage: 41.2, resetsAt: NOW + 3 * 24 * HOUR },
    spend: null,
    sessions: [{ sessionId: "s1", lane: "builder", model: "Opus", contextUsed: 8, at: NOW }],
    limits: null, onDemand: null,
  };
  const zai = {
    account: "zai", reportedAt: NOW - 180_000,
    fiveHour: { usedPercentage: 12, resetsAt: NOW + 4 * HOUR },
    sevenDay: { usedPercentage: 30, resetsAt: NOW + 5 * 24 * HOUR },
    spend: null,
    sessions: [{ sessionId: "z1", lane: "worker-01", model: "GLM", contextUsed: 4, at: NOW }],
    limits: null, onDemand: null,
  };
  mount(Home, { target: document.body, props: { accounts: [claude, zai, cursor, near, blank, metered], at: NOW, now: NOW, live: true, onOpenLane: () => {} } });
</script></body></html>`;

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });
describe("Home usage card", () => {
  it("shows Cursor's own bars and leaves a status-line account on the 5-hour and weekly windows", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message.split("\n")[0] ?? ""));
    await tab.goto(web.url);
    const cursor = tab.locator("[data-account='cursor']");
    await cursor.waitFor();
    const cursorText = await cursor.innerText();
    expect(cursorText).toContain("Cursor models");
    expect(cursorText).toContain("88%");
    expect(cursorText).toContain("Other models");
    expect(cursorText).toContain("45%");
    expect(cursorText).toContain("resets 7 Nov");
    expect(cursorText).toContain("on-demand off");
    expect(cursorText).toContain("Spend limit");
    expect(cursorText).toContain("85%");
    expect(cursorText).toContain("#usage-collector");
    expect(cursorText).not.toContain("not reported");
    expect(cursorText).not.toContain("5-hour window");
    expect(cursorText).not.toContain("Weekly window");
    const sessionsTile = tab.locator(".tile", { hasText: "Sessions reporting" });
    expect(Number((await sessionsTile.locator("b").innerText()).trim())).toBe(await tab.locator(".sess").count());
    const fiveTile = tab.locator(".tile", { hasText: "Tightest 5-hour window" });
    expect(await fiveTile.innerText()).toContain("24%");
    expect(await fiveTile.innerText()).not.toContain("cursor");
    expect(await tab.locator("p.note").innerText()).toContain("nearly out");
    expect(await tab.locator("[data-account='blank']").innerText()).toContain("5-hour window");
    expect(await tab.locator("[data-account='metered']").innerText()).toContain(DEMAND);
    const claude = await tab.locator("[data-account='max-1']").innerText();
    expect(claude).toContain("5-hour window");
    expect(claude).toContain("Weekly window");
    expect(claude).toContain("24%");
    expect(claude).toContain("#builder");
    expect(claude).not.toContain("not reported");
    const zai = await tab.locator("[data-account='zai']").innerText();
    expect(zai).toContain("5-hour window");
    expect(zai).toContain("Weekly window");
    expect(zai).toContain("#worker-01");
    expect(errors).toEqual([]);
    await tab.close();
  });
});

const LABELS_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Home from "/src/lib/desktop/HomeView.svelte";
  const NOW = ${NOW};
  const HOUR = ${HOUR};
  const acc = (account, five, profile) => ({
    account, reportedAt: NOW - 60_000,
    fiveHour: { usedPercentage: five, resetsAt: NOW + 2 * HOUR }, sevenDay: null, spend: null,
    sessions: [{ sessionId: account + "-s", lane: "builder", model: "Opus", contextUsed: null, at: NOW }],
    limits: null, onDemand: null, profile,
  });
  mount(Home, { target: document.body, props: { accounts: [
    acc("a3", 44, { email: "ada@example.test", org: "team", plan: "Max 5x" }),
    acc("b2", 12, { email: "lin@example.test", org: "personal", plan: "Max 20x" }),
    acc("c4", 5, { email: null, org: null, plan: "pro" }),
    acc("d5", 3, null),
  ], at: NOW, now: NOW, live: true, onOpenLane: () => {} } });
</script></body></html>`;

describe("Home usage card: the account's label (ADR-0034)", () => {
  let web: Web;
  beforeAll(async () => { web = await startWeb(LABELS_PAGE); }, 60_000);
  afterAll(async () => { await web?.close(); });

  it("shows the email, organization and plan beside the name, on the card and in the tile; a missing part is not shown", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message.split("\n")[0] ?? ""));
    await tab.goto(web.url);
    const norm = (s: string) => s.replace(/\s+/g, " ");                     // the ident is its own line in innerText
    const a3 = tab.locator("[data-account='a3']");
    await a3.waitFor();
    const header = norm(await a3.locator("header").innerText());
    expect(header).toContain("a3");
    expect(header).toContain("ada@example.test");
    expect(header).toContain("Team");
    expect(header).toContain("Max 5x");
    expect(await a3.getAttribute("aria-label")).toBe("Account a3 · ada@example.test · Team · Max 5x");
    const fiveTile = tab.locator(".tile", { hasText: "Tightest 5-hour window" });
    expect(norm(await fiveTile.innerText())).toContain("a3 · ada@example.test · Team · Max 5x");   // the tightest account, named by its label
    expect(norm(await tab.locator("[data-account='b2']").innerText())).toContain("lin@example.test · personal · Max 20x");
    expect(norm(await tab.locator("[data-account='c4']").innerText())).toContain("c4 · pro");
    const bare = await tab.locator("[data-account='d5']").locator("header").innerText();
    expect(bare).toContain("d5");
    expect(bare).not.toContain("·");                                                        // no profile: the name alone
    expect(errors).toEqual([]);
    await tab.close();
  });

  it("a long email wraps on a phone: no horizontal scroll at 390 px", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 390, height: 844 } });
    await tab.goto(web.url);
    await tab.locator("[data-account='a3']").waitFor();
    expect(await tab.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await tab.close();
  });
});
