// Reading comfort in the app (ADR-0008 phase D): the "New messages" divider at the read mark from when the conversation
// was opened, the jump-to-latest button with what arrived below, older pages that keep the view in place, drafts per
// conversation, read marks and mute from the hub, and the old localStorage marks brought up once. The real Desktop in
// headless Chromium, the fake feed of harness.ts behaving like the hub.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedOptions, type FeedWin, type Web } from "./harness.ts";

const T0 = Date.UTC(2026, 9, 2, 8);
const msg = (worker: string, i: number, kind: "agent" | "principal" = "agent", step = 60_000) =>
  ({ id: `${worker}-m${i}`, at: T0 + i * step, author: { kind, name: kind === "agent" ? worker : "You" }, kind: "text", text: `${worker} message ${i}` });
const range = (worker: string, from: number, to: number) => Array.from({ length: to - from }, (_, k) => msg(worker, from + k));
// A second apart: one run of the same author, so the top message loses its name line when older ones come above it.
const burst = (worker: string, from: number, to: number) => Array.from({ length: to - from }, (_, k) => msg(worker, from + k, "agent", 1000));

let web: Web;
let tab: Page;
let errors: string[];
beforeAll(async () => { web = await startWeb(); }, 60_000);
afterAll(async () => { await web?.close(); });
afterEach(async () => { await tab.context().close(); });

async function open(o: FeedOptions, before?: () => void) {
  const context = await web.browser.newContext({ viewport: { width: 1600, height: 900 } });
  tab = await context.newPage();
  errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  if (before) await tab.addInitScript(before);
  await tab.addInitScript(fakeFeed, o);
  await tab.goto(web.url);
  await tab.locator("button.row", { hasText: "alpha" }).first().waitFor();
}
// Where a message's text sits inside the pane, in px from the pane's top: the text, not its row, which loses its name
// line when older messages of the same author come above it.
const offsetOf = (text: string) => tab.evaluate(t => {
  const pane = document.querySelector(".pane");
  const row = [...document.querySelectorAll<HTMLElement>("[data-msg]")].find(e => e.textContent?.includes(t));
  const el = row?.querySelector(".md") ?? row;
  if (!pane || !el) throw new Error(`no row with ${t}`);
  return el.getBoundingClientRect().top - pane.getBoundingClientRect().top;
}, text);
// Scrolls the pane to its top and, in the same task (before the older page can arrive), says where `text` sits then.
const toTopMeasuring = (text: string) => tab.evaluate(t => {
  const pane = document.querySelector<HTMLElement>(".pane");
  const row = [...document.querySelectorAll<HTMLElement>("[data-msg]")].find(e => e.textContent?.includes(t));
  const el = row?.querySelector(".md") ?? row;
  if (!pane || !el) throw new Error(`no row with ${t}`);
  pane.scrollTop = 0;
  return el.getBoundingClientRect().top - pane.getBoundingClientRect().top;
}, text);
const sent = (t: string) => tab.evaluate(x => (globalThis as unknown as FeedWin).__feedSent.filter(m => (m as { t: string }).t === x), t);
const pane = () => tab.locator(".pane").first();
async function openAlpha() {
  await tab.locator("button.row", { hasText: "alpha" }).first().click();
  await tab.getByRole("heading", { level: 1, name: "alpha", exact: true }).waitFor();
}

describe("reading comfort", () => {
  it("opens at the 'New messages' divider, before the first message after the read mark; reading to the bottom moves the mark", { timeout: 30_000 }, async () => {
    const history = range("alpha", 0, 60);
    // Read up to message 10: 49 unread, more than a screen, so the bottom is out of view at the divider.
    await open({ workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha", lastMessageAt: T0 + 59 * 60_000 }], history: { "%1": history }, reading: { reads: { alpha: T0 + 10 * 60_000 }, muted: [] } });
    await openAlpha();
    const divider = tab.locator(".newdiv");
    await divider.waitFor();
    expect(await tab.locator(".newdiv + article, .newdiv + div").first().innerText()).toContain("alpha message 11");
    expect(await divider.isVisible()).toBe(true);
    expect(await sent("read")).toEqual([]);                            // not at the bottom yet: nothing is read
    await pane().evaluate(el => { el.scrollTop = el.scrollHeight; });
    await tab.waitForFunction(() => (globalThis as unknown as FeedWin).__feedSent.some(m => (m as { t: string }).t === "read"));
    expect((await sent("read")).at(-1)).toEqual({ t: "read", conversation: "alpha", at: T0 + 59 * 60_000 });
    expect(await divider.count()).toBe(1);                             // stays until the conversation is left
    expect(errors).toEqual([]);
  });
  it("shows the jump button above the bottom, counts what arrives below, and jumps", { timeout: 30_000 }, async () => {
    await open({ workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }], history: { "%1": range("alpha", 0, 80) } });
    await openAlpha();
    await tab.getByText("alpha message 79").waitFor();
    await pane().evaluate(el => { el.scrollTop = 0; });
    await tab.locator(".jump").waitFor();
    await tab.evaluate(([a, b]) => (globalThis as unknown as FeedWin).__feedPush({ t: "messages", worker: "%1", messages: [a, b] }), [msg("alpha", 80), msg("alpha", 81)]);
    await tab.locator(".jump", { hasText: "2 new" }).waitFor();
    await tab.locator(".jump").click();
    await tab.waitForFunction(() => { const p = document.querySelector(".pane"); return !!p && p.scrollHeight - p.scrollTop - p.clientHeight < 60; });
    expect(await tab.locator(".jump").count()).toBe(0);
  });
  it("scrolling up loads older messages without moving what is on screen, down to 'Beginning of conversation'", { timeout: 30_000 }, async () => {
    await open({ workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }], history: { "%1": burst("alpha", 150, 200) }, older: { "%1": burst("alpha", 0, 150) } });
    await openAlpha();
    await tab.getByText("alpha message 199").waitFor();
    await tab.waitForTimeout(100);                                     // the opening scroll is done: older pages armed
    expect(await tab.locator("article.msg.head", { hasText: "alpha message 150" }).count()).toBe(1);
    const before = await toTopMeasuring("alpha message 150");
    await tab.waitForFunction(() => (globalThis as unknown as FeedWin).__feedSent.some(m => (m as { t: string }).t === "older"));
    await tab.getByText("alpha message 50", { exact: true }).waitFor();
    expect(await tab.locator("article.msg.head", { hasText: "alpha message 150" }).count()).toBe(0);   // its name line went
    expect(Math.abs((await offsetOf("alpha message 150")) - before)).toBeLessThanOrEqual(2);   // its text exactly in place (L8)
    expect((await sent("older"))[0]).toEqual({ t: "older", worker: "%1", before: "alpha-m150" });
    await pane().evaluate(el => { el.scrollTop = 0; });
    await tab.getByText("Beginning of conversation").waitFor();
    await tab.getByText("alpha message 0", { exact: true }).waitFor();
  });
  it("crossing the 1500 cap: the page goes above without a jump, and nothing counts as new (review M4)", { timeout: 60_000 }, async () => {
    await open({ workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }], history: { "%1": range("alpha", 1400, 2850) }, older: { "%1": range("alpha", 0, 1400) } });
    await openAlpha();
    await tab.getByText("alpha message 2849", { exact: true }).waitFor();
    await tab.waitForTimeout(100);
    const before = await toTopMeasuring("alpha message 1400");
    await tab.getByText("alpha message 1300", { exact: true }).waitFor();          // 1450 + 100 > 1500: the newest 50 went
    expect(Math.abs((await offsetOf("alpha message 1400")) - before)).toBeLessThanOrEqual(2);
    expect(await tab.getByText("alpha message 2849", { exact: true }).count()).toBe(0);
    await tab.locator(".jump").waitFor();                                         // the latest aren't held: the way back
    expect(await tab.locator(".jump").innerText()).not.toMatch(/new/);
  });
  it("past the cap, reading to the bottom of what is held marks nothing: the newest were never shown (review M3)", { timeout: 60_000 }, async () => {
    const last = T0 + 2849 * 60_000;
    await open({ workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha", lastMessageAt: last }], history: { "%1": range("alpha", 1400, 2850) }, older: { "%1": range("alpha", 0, 1400) }, reading: { reads: { alpha: T0 }, muted: [] } });
    await openAlpha();
    await tab.locator(".newdiv").waitFor();                                       // opens at the divider, at the top
    await tab.waitForTimeout(100);
    await pane().evaluate(el => { el.scrollTop = 0; });
    await tab.getByText("alpha message 1300", { exact: true }).waitFor();
    expect(await tab.getByText("alpha message 2849", { exact: true }).count()).toBe(0);   // trimmed: never shown
    const reads = (await sent("read")).length;
    await pane().evaluate(el => { el.scrollTop = el.scrollHeight; });
    await tab.waitForTimeout(500);
    expect((await sent("read")).slice(reads)).toEqual([]);
  });
  it("back from the Activity view with new messages: nothing is read until the list is at its bottom again (review M3)", { timeout: 30_000 }, async () => {
    await open({ workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha", lastMessageAt: T0 + 19 * 60_000 }], history: { "%1": range("alpha", 0, 20) }, reading: { reads: { alpha: T0 + 19 * 60_000 }, muted: [] } });
    await openAlpha();
    await tab.getByText("alpha message 19", { exact: true }).waitFor();
    await tab.locator(".rail").getByRole("button", { name: "Activity" }).click();
    await tab.evaluate(([ms, at]) => {
      const w = globalThis as unknown as FeedWin;
      w.__feedPush({ t: "messages", worker: "%1", messages: ms });
      w.__feedPush({ t: "events", events: [{ epoch: "e1", seq: 1, at: 1, body: { type: "WorkerSpoke", workerId: "%1", at } }] });
    }, [range("alpha", 20, 80), T0 + 79 * 60_000] as const);
    await tab.waitForTimeout(200);
    const reads = (await sent("read")).length;
    await tab.locator(".rail").getByRole("button", { name: "Chats" }).click();          // the chats; Home is the dashboard (ADR-0016)
    await tab.getByText("alpha message 79", { exact: true }).waitFor({ state: "attached" });
    await tab.waitForTimeout(500);
    const after = (await sent("read")).slice(reads) as { at: number }[];
    expect(after.filter(r => r.at >= T0 + 79 * 60_000)).toEqual([]);            // the newest weren't on screen yet
    expect(await tab.locator(".newdiv + article, .newdiv + div").first().innerText()).toContain("alpha message 20");
  });
  it("a reconnect while reading older pages keeps them and the place (review L3)", { timeout: 30_000 }, async () => {
    await open({ workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }], history: { "%1": range("alpha", 150, 200) }, older: { "%1": range("alpha", 0, 150) } });
    await openAlpha();
    await tab.getByText("alpha message 199").waitFor();
    await tab.waitForTimeout(100);
    await pane().evaluate(el => { el.scrollTop = 0; });
    await tab.getByText("alpha message 50", { exact: true }).waitFor();
    const before = await offsetOf("alpha message 120");
    const asked = (await sent("older")).length;
    await tab.evaluate(() => (globalThis as unknown as FeedWin).__feedClose(1006));
    await tab.waitForFunction(() => (globalThis as unknown as FeedWin).__feedOpened >= 2);
    await tab.waitForTimeout(800);                                    // the history again, after the new hello
    expect(await tab.getByText("alpha message 50", { exact: true }).count()).toBe(1);
    expect((await sent("older")).length).toBe(asked);                 // kept, not dropped and asked for again
    expect(Math.abs((await offsetOf("alpha message 120")) - before)).toBeLessThanOrEqual(2);
    expect(await tab.locator(".jump", { hasText: "new" }).count()).toBe(0);
  });
  it("an older page the hub can't read says so, with Try again, instead of 'Beginning of conversation' (review L1)", { timeout: 30_000 }, async () => {
    await open({ workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }], history: { "%1": range("alpha", 150, 200) }, olderMissing: true });
    await openAlpha();
    await tab.getByText("alpha message 199").waitFor();
    await tab.waitForTimeout(100);
    await pane().evaluate(el => { el.scrollTop = 0; });
    await tab.getByText("Couldn't load older messages.").waitFor();
    expect(await tab.getByText("Beginning of conversation").count()).toBe(0);
    const asked = (await sent("older")).length;
    await tab.getByRole("button", { name: "Try again" }).click();
    await tab.waitForFunction(k => (globalThis as unknown as FeedWin).__feedSent.filter(m => (m as { t: string }).t === "older").length > k, asked);
  });
  it("keeps a draft per conversation across a switch and a reload, and clears it on send", { timeout: 30_000 }, async () => {
    await open({ workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }, { id: "%2", name: "beta" }] });
    await openAlpha();
    await tab.getByRole("textbox", { name: "Message alpha" }).fill("half a thought");
    await tab.waitForTimeout(400);
    await tab.locator("button.row", { hasText: "beta" }).first().click();
    await tab.getByRole("heading", { level: 1, name: "beta", exact: true }).waitFor();
    expect(await tab.getByRole("textbox", { name: "Message beta" }).inputValue()).toBe("");
    await openAlpha();
    expect(await tab.getByRole("textbox", { name: "Message alpha" }).inputValue()).toBe("half a thought");
    await tab.reload();
    await tab.locator("button.row", { hasText: "alpha" }).first().waitFor();
    await openAlpha();
    expect(await tab.getByRole("textbox", { name: "Message alpha" }).inputValue()).toBe("half a thought");
    expect(JSON.parse(await tab.evaluate(() => localStorage.getItem("morndo.drafts") ?? "{}"))).toEqual({ "%1": { name: "alpha", text: "half a thought", seen: "none" } });
  });
  it("a draft never shows in another worker's box, even one with the same name (review H2)", { timeout: 30_000 }, async () => {
    await open({ workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }, { id: "%2", name: "alpha" }] });
    const rows = tab.locator("button.row", { hasText: "alpha" });
    await rows.nth(0).click();
    await tab.getByRole("textbox", { name: "Message alpha" }).fill("only for the first alpha");
    await tab.waitForTimeout(400);
    await rows.nth(1).click();
    await tab.waitForTimeout(200);
    expect(await tab.getByRole("textbox", { name: "Message alpha" }).inputValue()).toBe("");
    await rows.nth(0).click();
    await tab.waitForTimeout(200);
    expect(await tab.getByRole("textbox", { name: "Message alpha" }).inputValue()).toBe("only for the first alpha");
  });
  it("takes read marks and mute from the hub: another device's read clears the unread badge, its mute shows here", { timeout: 30_000 }, async () => {
    await open({ workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha", lastMessageAt: T0 + 5000 }, { id: "%2", name: "beta" }] });
    await tab.locator("button.row.unread", { hasText: "alpha" }).first().waitFor();
    await tab.evaluate(at => (globalThis as unknown as FeedWin).__feedPush({ t: "read", conversation: "alpha", at }), T0 + 5000);
    await tab.locator("button.row.unread", { hasText: "alpha" }).first().waitFor({ state: "detached" });
    await tab.evaluate(() => (globalThis as unknown as FeedWin).__feedPush({ t: "mute", conversation: "beta", muted: true }));
    await tab.locator("button.row.muted", { hasText: "beta" }).first().waitFor();
  });
  it("brings this device's old marks and mutes up to the hub once, then stops keeping them", { timeout: 30_000 }, async () => {
    await open({ workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }, { id: "%2", name: "beta" }], reading: { reads: { alpha: 100 }, muted: [] } }, () => {
      localStorage.setItem("morndo.read", JSON.stringify({ alpha: 50, beta: 900 }));
      localStorage.setItem("morndo.conversations", JSON.stringify({ beta: { muted: true, show: "verbose" } }));
    });
    await tab.waitForFunction(() => (globalThis as unknown as FeedWin).__feedSent.some(m => (m as { t: string }).t === "mute"));
    expect(await sent("read")).toEqual([{ t: "read", conversation: "beta", at: 900 }]);   // alpha's 50 is older than the hub's 100
    expect(await sent("mute")).toEqual([{ t: "mute", conversation: "beta", muted: true }]);
    expect(await tab.evaluate(() => localStorage.getItem("morndo.read"))).toBeNull();
    expect(JSON.parse(await tab.evaluate(() => localStorage.getItem("morndo.conversations") ?? "{}"))).toEqual({ beta: { show: "verbose" } });
    // A later settings change here doesn't bring the old mute back (review M2): star alpha, then reload.
    await tab.locator("button.row", { hasText: "alpha" }).first().click({ button: "right" });
    await tab.getByText("Star conversation").click();
    expect(JSON.parse(await tab.evaluate(() => localStorage.getItem("morndo.conversations") ?? "{}"))).toEqual({ beta: { show: "verbose" }, alpha: { starred: true } });
  });
  it("brings up at most the 50 latest old marks, so the hub's frame limit never closes the feed (whole-branch review L6)", { timeout: 30_000 }, async () => {
    await open({ workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }], reading: { reads: {}, muted: [] } }, () => {
      localStorage.setItem("morndo.read", JSON.stringify(Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`old-${i}`, 1000 + i]))));
    });
    await tab.waitForFunction(() => (globalThis as unknown as FeedWin).__feedSent.some(m => (m as { t: string }).t === "read"));
    await tab.waitForTimeout(300);
    const reads = await sent("read") as { conversation: string; at: number }[];
    expect(reads).toHaveLength(50);
    expect(Math.min(...reads.map(r => r.at))).toBe(1070);                 // the 50 latest: 1070 to 1119
    expect(await tab.evaluate(() => localStorage.getItem("morndo.read"))).toBeNull();
  });
});
