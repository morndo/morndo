// ADR-0032 (design §7) in the real Desktop client, headless Chromium, fake feed (harness.ts): the Runs of a `board`
// frame show on the board in today's look, and one this build can't read is dropped while the rest show. The assignee's
// avatar gets its ring and its card a live line; the header counts the lanes working now and those waiting on their own
// work; a row names the lanes working without a task, and a chip opens that lane's channel. A card that changes column
// crossfades there with its avatar, the card leaving can't be clicked or found, and under reduced motion nothing animates.
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

const MIN = 60_000;
const NOW = Date.now();
const task = (n: number, status: string, assignee: string | null) => ({
  key: `T-${n}`, n, title: `Task ${n}`, description: "", status, assignee, priority: "normal", blockedReason: null,
  createdAt: NOW - 90 * MIN, updatedAt: NOW - 60 * MIN, stateChangedAt: NOW - 60 * MIN, createdBy: { kind: "manager", name: "manager", token: "m" }, rev: 1, doneAt: null, comments: 0,
});
const run = (lane: string, o: Record<string, unknown> = {}) => ({ lane, node: "pc", phase: "working", deadline: null, overdue: false, since: NOW - 3 * MIN, source: "session", ...o });
const LANES = ["manager", "builder", "reviewer", "alpha", "old"];
const TASKS = [task(1, "doing", "builder"), task(2, "todo", "reviewer"), task(3, "done", "alpha"), task(4, "doing", "old")];
const RUNS = [
  run("builder"),
  run("reviewer", { phase: "waiting", wait: { on: "background", tasks: [{ type: "shell", label: "npm test" }] }, since: NOW - 6 * MIN, source: "hook" }),
  run("alpha", { phase: "waiting", wait: { on: "wakeup", next: null }, source: "hook" }),   // only a done task: a lane without a task
  run("old", { phase: "gone", source: "session" }),                                           // its window closed; the hub still lists it
  run("broken", { phase: "sleeping" }),                                                       // a phase this build can't read
];
const board = (tasks: unknown[], runs?: unknown[]) => ({ t: "board", tasks, lanes: LANES, at: NOW, ...(runs ? { runs } : {}) });

// The Desktop as the app mounts it, with the brand's tokens loaded as the root layout does (+layout.svelte), so the ring's
// colours resolve: without them every status colour is undefined and an outline using one is dropped.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import "@morndo/brand/tokens.css";
  import { mount } from "svelte";
  import Desktop from "/src/lib/desktop/Desktop.svelte";
  mount(Desktop, { target: document.body, props: { device: "dev-1", office: "Test office", verifiedAt: Date.now(), policy: { stay: "7d", stepUp: "1h" }, desktop: false, onSignedOut: () => {} } });
</script></body></html>`;

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });

async function boardTab(reducedMotion: "reduce" | "no-preference"): Promise<{ tab: Page; errors: string[]; push: (m: unknown) => Promise<void> }> {
  const tab = await web.browser.newPage({ viewport: { width: 1920, height: 1000 }, reducedMotion });
  const errors: string[] = [];
  tab.on("pageerror", e => errors.push(e.message.split("\n")[0] ?? ""));
  await tab.addInitScript(fakeFeed, { workers: LANES.map((name, i) => ({ id: `%${i}`, name })) });
  await tab.goto(web.url);
  await tab.locator("button.row", { hasText: "builder" }).first().waitFor();
  const push = (m: unknown) => tab.evaluate(x => (globalThis as unknown as FeedWin).__feedPush(x), m);
  await push(board(TASKS, RUNS));
  await tab.locator(".rail").getByRole("button", { name: "Board" }).click();
  await tab.locator('[data-column="doing"] [data-task="T-1"]').waitFor();
  return { tab, errors, push };
}
// The next `ms` of the board, sampled each frame: the most Web Animations on a card's slot at once (the crossfade and the
// close-up), the most cards leaving at once (inert, still in their old column), the most cards carrying T-2's key, and
// whether a card leaving ever still carried a key.
type Sample = { animations: number; leaving: number; keyed: number; leavingKeyed: boolean };
const sample = (tab: Page, ms: number) => tab.evaluate(ms => new Promise<Sample>(done => {
  const s = { animations: 0, leaving: 0, keyed: 0, leavingKeyed: false };
  const end = performance.now() + ms;
  const tick = () => {
    s.animations = Math.max(s.animations, document.getAnimations().filter(a => ((a.effect as KeyframeEffect | null)?.target as Element | null)?.closest?.(".slot")).length);
    const leaving = [...document.querySelectorAll(".slot[inert]")];
    s.leaving = Math.max(s.leaving, leaving.length);
    s.leavingKeyed ||= leaving.some(x => x.querySelector("[data-task]"));
    s.keyed = Math.max(s.keyed, document.querySelectorAll('[data-task="T-2"]').length);
    if (performance.now() < end) requestAnimationFrame(tick); else done(s);
  };
  requestAnimationFrame(tick);
}), ms);
const MOVED = () => board([task(1, "doing", "builder"), { ...task(2, "doing", "reviewer"), rev: 2, updatedAt: NOW, stateChangedAt: NOW }, task(3, "done", "alpha"), task(4, "doing", "old")], RUNS);

describe("the board follows the Runs of its frame", () => {
  it("shows the ring, the live line, the counts and the lanes without a task, dropping the Run it can't read", { timeout: 30_000 }, async () => {
    const { tab, errors } = await boardTab("no-preference");
    try {
      const ring = (sel: string) => tab.locator(`${sel} [data-ring]`).getAttribute("data-ring");
      const outline = (sel: string) => tab.locator(`${sel} .av`).evaluate(e => getComputedStyle(e).outlineStyle);
      expect(await ring('[data-task="T-1"]')).toBe("ring-solid ring-working ring-pulse");
      expect(await outline('[data-task="T-1"]')).toBe("solid");
      expect(await tab.locator('[data-task="T-1"] .live').innerText()).toBe("Working · 3m");
      expect(await ring('[data-task="T-2"]')).toBe("ring-dashed ring-working");
      expect(await outline('[data-task="T-2"]')).toBe("dashed");
      expect(await tab.locator('[data-task="T-2"] .live').innerText()).toBe("In the background: npm test · 6m");
      // The ring is the status colour, from the tokens: the working ring is --working, as the In progress glyph is.
      const colours = await tab.evaluate(() => {
        const av = document.querySelector('[data-task="T-1"] .av') as HTMLElement, glyph = document.querySelector('[data-column="doing"] h2 .si') as SVGElement;
        return [getComputedStyle(av).outlineColor, getComputedStyle(glyph).color];
      });
      expect(colours[0]).toBe(colours[1]);
      // A lane that is gone (R5) is not running, whatever the hub's list says: the chip, and no ring or line.
      expect(await tab.locator('[data-task="T-4"] .chip.off').count(), "T-4's not running chip").toBe(1);   // negative control: ab-web-gone-not-running
      expect(await tab.locator('[data-task="T-4"] .chip.off').textContent()).toContain("not running");
      expect(await tab.locator('[data-task="T-4"] [data-ring]').count()).toBe(0);
      expect(await tab.locator('[data-task="T-4"] .live').count()).toBe(0);
      // A done card carries no Run (its lane's work is not that task): a plain avatar, no line.
      expect(await tab.locator('[data-task="T-3"] [data-ring]').count()).toBe(0);
      expect(await tab.locator('[data-task="T-3"] .live').count()).toBe(0);
      const words = async (sel: string) => (await tab.locator(sel).textContent())?.replace(/\s+/g, " ").trim();
      expect(await words('[data-sum="working"]')).toBe("1 working now");
      expect(await words('[data-sum="own-work"]')).toBe("2 waiting on their own work");
      // The lanes without a task: alpha (only a done task), never "broken", whose Run was dropped.
      const row = tab.getByRole("group", { name: "Lanes working without a task" });
      expect(await row.locator("[data-lane]").evaluateAll(b => b.map(x => x.getAttribute("data-lane")))).toEqual(["alpha"]);
      expect(await row.locator('[data-lane="alpha"]').innerText()).toContain("waiting");
      expect(await outline('[data-lane="alpha"]')).toBe("dotted");
      await row.locator('[data-lane="alpha"]').click();
      await tab.locator("header.vh h1", { hasText: "alpha" }).waitFor({ timeout: 5000 });
      expect(errors).toEqual([]);
    } finally { await tab.close(); }
  });

  it("shows no run counts, rings or lines from a hub that sends no Runs (negative control for the pills)", { timeout: 30_000 }, async () => {
    const { tab, push } = await boardTab("no-preference");
    try {
      await push(board([...TASKS, task(5, "backlog", null)]));
      await tab.locator('[data-task="T-5"]').waitFor();
      expect(await tab.locator("[data-sum]").count()).toBe(0);
      expect(await tab.locator("[data-ring]").count()).toBe(0);
      expect(await tab.locator(".tc .live").count()).toBe(0);
      expect(await tab.getByRole("group", { name: "Lanes working without a task" }).count()).toBe(0);
    } finally { await tab.close(); }
  });

  it("crossfades a card that changes column, and the card leaving can't be found or clicked", { timeout: 30_000 }, async () => {
    const { tab, push } = await boardTab("no-preference");
    try {
      const seen = sample(tab, 700);
      await push(MOVED());
      const s = await seen;
      expect(s.animations).toBeGreaterThan(0);
      expect(s.leaving).toBe(1);                                      // the card leaving To do, while it fades
      expect(s.leavingKeyed).toBe(false);                              // negative control: without leave()'s strip, true
      expect(s.keyed).toBe(1);
      await tab.locator('[data-column="doing"] [data-task="T-2"]').waitFor();
      await tab.waitForFunction(() => !document.querySelector(".slot[inert]"));
      expect(await tab.locator('[data-column="todo"] .slot').count()).toBe(0);
    } finally { await tab.close(); }
  });

  it("animates nothing under reduced motion: no crossfade, no close-up, no pulse", { timeout: 30_000 }, async () => {
    const { tab, push } = await boardTab("reduce");
    try {
      expect(await tab.locator('[data-task="T-1"] .av').evaluate(e => getComputedStyle(e).animationName)).toBe("none");
      const seen = sample(tab, 700);
      await push(MOVED());
      expect((await seen).animations).toBe(0);                         // negative control: the test above sees > 0 with motion
      await tab.locator('[data-column="doing"] [data-task="T-2"]').waitFor();
      expect(await tab.evaluate(() => document.getAnimations().length)).toBe(0);
    } finally { await tab.close(); }
  });
});
