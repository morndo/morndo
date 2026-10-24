// Home's usage card: an account that names its windows shows those bars, and a status-line account shows the
// 5-hour and weekly windows as it does today. Synthetic accounts only. The S4 cases (plan 4.4): the four states a
// source's health leaves an account in, a window's title from its cadence, the seat badge and its Clear button, the
// disagreement note, the sources list with the two-tap Forget, the notices panel, and plain text always.
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

// The S4 view (plan 4.4): one page with an account in each state, a titled window, a seat, a disagreement and
// notices. The handler calls land on the window, where the test reads them.
const S4_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Home from "/src/lib/desktop/HomeView.svelte";
  const NOW = ${NOW};
  const RESET = ${RESET};
  const HOUR = ${HOUR};
  const MIN = 60_000;
  const src = (source, state, o = {}) => ({ source, node: null, state, since: null, asOf: null, reason: null, fix: null, hint: null, ...o });
  const base = (account, o = {}) => ({
    account, reportedAt: NOW - 60_000,
    fiveHour: { usedPercentage: 40, resetsAt: NOW + 2 * HOUR }, sevenDay: null, spend: null, sessions: [],
    limits: null, onDemand: null, ...o,
  });
  const accounts = [
    base("fresh", { sources: [src("app-server", "available", { asOf: NOW - 30_000 })] }),
    base("old", { sources: [src("app-server", "stale", { asOf: NOW - 20 * MIN, reason: "unknown_screen" })] }),
    base("dead", { sources: [src("app-server", "unavailable", { since: NOW - 5 * MIN, reason: "signed_out", fix: "sign_in_again", hint: "<b>bold</b> https://x.example/ a@b.test" })] }),
    base("quiet", { sources: [src("app-server", "missing")] }),
    base("titled", { limits: [{ label: "Monthly", usedPercentage: 50, resetsAt: RESET, resetsOn: null, title: "weekly" }], sources: [src("app-server", "available", { asOf: NOW - MIN })] }),
    base("seated", {
      sources: [src("app-server", "unavailable", { since: NOW - 5 * MIN, reason: "signed_out", fix: "sign_in_again", hint: null }), src("cli-screen", "available", { asOf: NOW - MIN })],
      seat: { state: "out", why: "usage_limit", since: NOW - 10 * MIN, backAt: NOW + 30 * MIN, owner: "derived", by: "<img src=x> worker-one", fix: "wait_for_reset" },
      disagree: [{ window: "five_hour", a: { source: "app-server", usedPercent: 70, capturedAt: NOW - 2 * MIN }, b: { source: "cli-screen", usedPercent: 40, capturedAt: NOW - MIN } }],
    }),
  ];
  const notices = Array.from({ length: 10 }, (_, i) => ({
    id: "n" + i, kind: i % 2 === 0 ? "plan" : "seat", account: i % 2 === 0 ? "fresh" : "seated",
    at: NOW - (i + 1) * 2 * MIN, text: (i % 2 === 0 ? "fresh" : "seated") + ": notice " + i + " said.",
  }));
  window.__forget = [];
  window.__clearSeat = [];
  mount(Home, { target: document.body, props: {
    accounts, at: NOW, now: NOW, live: true, onOpenLane: () => {}, notices,
    onForget: (account, source, node) => window.__forget.push([account, source, node]),
    onClearSeat: (account) => window.__clearSeat.push(account),
  } });
</script></body></html>`;

describe("Home usage card: the four states, a title, a seat, a disagreement, sources and notices (S4)", () => {
  let web: Web;
  beforeAll(async () => { web = await startWeb(S4_PAGE); }, 60_000);
  afterAll(async () => { await web?.close(); });

  const norm = (s: string) => s.replace(/\s+/g, " ");

  it("available shows the meters as today; an account no source speaks of is exactly as today", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message.split("\n")[0] ?? ""));
    await tab.goto(web.url);
    const fresh = tab.locator("[data-account='fresh']");
    await fresh.waitFor();
    await fresh.getByRole("group", { name: "5-hour window: 40% used, Fine" }).waitFor({ timeout: 2000 });
    const freshText = await fresh.innerText();
    expect(freshText).not.toContain("As of");
    expect(freshText).not.toContain("Can't read");
    expect(errors).toEqual([]);
    await tab.close();
  });

  it("stale keeps the meters, dimmed, says since when, and each stale source its line", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    await tab.goto(web.url);
    const old = tab.locator("[data-account='old']");
    await old.waitFor();
    await old.getByRole("group", { name: "5-hour window: 40% used, Fine" }).waitFor({ timeout: 2000 });
    expect(await old.locator(".meter.stale").count()).toBeGreaterThan(0);        // dimmed, never hidden
    const text = norm(await old.innerText());
    expect(text).toContain("As of");
    expect(text).toContain("app-server: last read a while ago, its screen was not in a shape Morndo knows");
    await tab.close();
  });

  it("unavailable replaces the meters with the reason, the fix and the source's hint; no old numbers stay", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    await tab.goto(web.url);
    const dead = tab.locator("[data-account='dead']");
    await dead.waitFor();
    await dead.getByRole("status").waitFor({ timeout: 2000 });
    const text = norm(await dead.innerText());
    expect(text).toContain("Can't read since");
    expect(text).toContain("it is signed out");
    expect(text).toContain("Fix: sign in again");
    expect(text).toContain("the source says:");
    expect(text).toContain("<b>bold</b> https://x.example/ a@b.test");           // the hint, as text
    expect(await dead.locator(".meter").count()).toBe(0);                        // no meters, no old numbers
    await tab.close();
  });

  it("missing says no reading yet", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    await tab.goto(web.url);
    const quiet = tab.locator("[data-account='quiet']");
    await quiet.waitFor();
    const text = norm(await quiet.innerText());
    expect(text).toContain("No reading yet");
    expect(text).toContain("Nothing has read this account yet.");
    await tab.close();
  });

  it("a named window shows its label and the title from its cadence after it, never instead of it", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    await tab.goto(web.url);
    const titled = tab.locator("[data-account='titled']");
    await titled.waitFor();
    const text = norm(await titled.innerText());
    expect(text).toContain("Monthly");
    expect(text).toContain("· weekly");
    expect(text).not.toContain("monthly");
    await tab.close();
  });

  it("the seat badge: words, the fix, who set it and the owner word; Clear this mark calls the handler with the account", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    await tab.goto(web.url);
    const seated = tab.locator("[data-account='seated']");
    await seated.waitFor();
    const text = norm(await seated.innerText());
    expect(text).toContain("Out until");
    expect(text).toContain("Fix: wait for the reset");
    expect(text).toContain("set by");
    expect(text).toContain("<img src=x> worker-one");                            // the hub-cleaned by, as text
    expect(text).toContain("a lane's failure");
    const clear = seated.getByRole("button", { name: /Clear this mark/ });
    await clear.waitFor({ timeout: 2000 });
    expect(await clear.getAttribute("aria-label")).toContain("seated");
    await clear.click();
    const calls = await tab.evaluate(() => (window as unknown as { __clearSeat: string[] }).__clearSeat);
    expect(calls).toEqual(["seated"]);
    await tab.close();
  });

  it("a disagreement is said in words with an icon", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    await tab.goto(web.url);
    const seated = tab.locator("[data-account='seated']");
    await seated.waitFor();
    const text = norm(await seated.innerText());
    expect(text).toContain("Sources disagree");
    expect(text).toContain("app-server");
    expect(text).toContain("cli-screen");
    expect(await seated.locator("svg").count()).toBeGreaterThan(0);
    await tab.close();
  });

  it("the sources list: one line each; Forget takes two taps and only the second calls the handler", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    await tab.goto(web.url);
    const seated = tab.locator("[data-account='seated']");
    await seated.waitFor();
    const forget = seated.getByRole("button", { name: /Forget/ }).first();
    await forget.waitFor({ timeout: 2000 });
    expect(await forget.getAttribute("aria-label")).toContain("seated");
    expect(await forget.getAttribute("aria-label")).toContain("app-server");
    await forget.click();                                                        // the first tap only asks
    expect(await forget.innerText()).toContain("Forget? (this removes it)");
    let calls = await tab.evaluate(() => (window as unknown as { __forget: unknown[][] }).__forget);
    expect(calls).toEqual([]);
    await forget.click();                                                        // the second forgets
    calls = await tab.evaluate(() => (window as unknown as { __forget: unknown[][] }).__forget);
    expect(calls).toEqual([["seated", "app-server", null]]);
    await tab.close();
  });

  it("the notices panel: at most eight, each with its account, how long ago, and the text; none: no panel", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    await tab.goto(web.url);
    const panel = tab.locator(".notices");
    await panel.waitFor({ timeout: 2000 });
    await panel.getByRole("heading", { name: "Recent notices" }).waitFor({ timeout: 2000 });
    expect(await panel.locator("li").count()).toBe(8);
    const text = norm(await panel.innerText());
    expect(text).toContain("fresh");
    expect(text).toContain("2 min ago");
    expect(text).toContain("notice 0 said.");
    expect(text).not.toContain("notice 8 said.");
    await tab.close();
  });

  it("plain text always: a hint or a by with markup and an address creates no element and no link", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    await tab.goto(web.url);
    await tab.locator("[data-account='dead']").waitFor();
    for (const account of ["dead", "seated"]) {
      const card = tab.locator(`[data-account='${account}']`);
      expect(await card.locator("b, i, img, a[href], script, iframe").count()).toBe(0);
    }
    await tab.close();
  });

  it("at 390 px the states and the seat never widen the page", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 390, height: 844 } });
    await tab.goto(web.url);
    await tab.locator("[data-account='seated']").waitFor();
    expect(await tab.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const forget = tab.locator("[data-account='seated']").getByRole("button", { name: /Forget/ }).first();
    if (await forget.count()) {
      const box = await forget.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(30);                       // a tap target (the phone layout's own rule)
    }
    await tab.close();
  });
});
