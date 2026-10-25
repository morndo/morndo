// The page guard (steady.ts) on a stand-in page: which loads it repeats after Chromium's net::ERR_NETWORK_CHANGED, and
// which failures it lets stand. Each load is scripted: the requests it sees fail, how goto ends, what the module check
// finds. No browser.
import { EventEmitter } from "node:events";
import type { Browser, Page } from "playwright";
import { describe, expect, it } from "vitest";
import { loadsAgainWhenCut, steady } from "../../../test/steady.ts";

const CUT = "net::ERR_NETWORK_CHANGED";
type Load = { cut?: boolean; other?: string; throws?: string; modulesFailed?: boolean; evaluateThrows?: string };

function standIn(loads: Load[]) {
  const events = new EventEmitter();
  const calls = { goto: 0, evaluate: 0, waitForLoadState: 0, init: 0 };
  let current: Load = {};
  const page = {
    addInitScript: async () => { calls.init++; },
    on: (name: string, f: (...a: unknown[]) => void) => { events.on(name, f); },
    off: (name: string, f: (...a: unknown[]) => void) => { events.off(name, f); },
    goto: async (url: string) => {
      current = loads[calls.goto++] ?? {};
      if (current.cut) events.emit("requestfailed", { failure: () => ({ errorText: CUT }) });
      if (current.other) events.emit("requestfailed", { failure: () => ({ errorText: current.other }) });
      if (current.throws) throw new Error(current.throws);
      return { url };
    },
    evaluate: async () => {
      calls.evaluate++;
      if (current.evaluateThrows) { const m = current.evaluateThrows; delete current.evaluateThrows; throw new Error(m); }
      return current.modulesFailed === true;
    },
    waitForLoadState: async () => { calls.waitForLoadState++; },
  };
  return { page: page as unknown as Page, calls };
}

// A browser whose every page is a fresh stand-in with the same scripted loads. browser.newPage() makes its context with
// the browser's own newContext, as Playwright's does.
function standInBrowser(loads: Load[]) {
  const made: ReturnType<typeof standIn>[] = [];
  const context = { newPage: async () => { const s = standIn(loads); made.push(s); return s.page; } };
  const browser = { newContext: async () => context, async newPage(this: { newContext: () => Promise<typeof context> }) { return (await this.newContext()).newPage(); } };
  return { browser: browser as unknown as Browser, made };
}

const guarded = async (loads: Load[]) => {
  const s = standIn(loads);
  return { ...s, page: await loadsAgainWhenCut(s.page, [0, 0, 0]) };
};

describe("the page guard", () => {
  it("loads again when a cut kept the page's modules from loading, and returns the next whole load", async () => {
    const { page, calls } = await guarded([{ cut: true, modulesFailed: true }, {}]);
    expect(await page.goto("http://test/")).toEqual({ url: "http://test/" });
    expect(calls.goto).toBe(2);
  });

  it("returns at once when a request was cut but the modules loaded (the page's code ran)", async () => {
    const { page, calls } = await guarded([{ cut: true, modulesFailed: false }]);
    await page.goto("http://test/");
    expect(calls.goto).toBe(1);
  });

  it("loads again when goto itself threw after a request of that load was cut, whatever its words (review point 1)", async () => {
    const { page, calls } = await guarded([{ cut: true, throws: "page.goto: Timeout 30000ms exceeded." }, {}]);
    expect(await page.goto("http://test/")).toEqual({ url: "http://test/" });
    expect(calls.goto).toBe(2);
  });

  it("lets any other failure stand: a goto that throws with no cut, a request failed another way (negative controls)", async () => {
    const thrown = await guarded([{ throws: "page.goto: Timeout 30000ms exceeded." }, {}]);
    await expect(thrown.page.goto("http://test/")).rejects.toThrow(/Timeout 30000ms/);
    expect(thrown.calls.goto).toBe(1);
    const refused = await guarded([{ other: "net::ERR_CONNECTION_REFUSED", modulesFailed: true }, {}]);
    await refused.page.goto("http://test/");
    expect(refused.calls.goto).toBe(1);
    expect(refused.calls.evaluate).toBe(0);
  });

  it("asks again after the page navigated during its module check, instead of failing the load (review point 4)", async () => {
    const { page, calls } = await guarded([{ cut: true, evaluateThrows: "page.evaluate: Execution context was destroyed, most likely because of a navigation" }]);
    expect(await page.goto("http://test/")).toEqual({ url: "http://test/" });
    expect(calls.goto).toBe(1);
    expect(calls.evaluate).toBe(2);
  });

  it("fails naming the cut when the last load's modules were cut too, never returning that page (review point 6)", async () => {
    const { page, calls } = await guarded(Array.from({ length: 4 }, () => ({ cut: true, modulesFailed: true })));
    await expect(page.goto("http://test/")).rejects.toThrow(/ERR_NETWORK_CHANGED.*4 loads/);
    expect(calls.goto).toBe(4);
  });

  it("guards the pages of a browser, from a context and from browser.newPage(): a first load cut mid-module loads again", async () => {
    const { browser, made } = standInBrowser([{ cut: true, modulesFailed: true }, {}]);
    steady(browser);
    for (const page of [await (await browser.newContext()).newPage(), await browser.newPage()]) {
      expect(await page.goto("http://test/")).toEqual({ url: "http://test/" });
    }
    expect(made.map(m => m.calls.goto)).toEqual([2, 2]);
  });

  it("guards a browser once, however many harnesses ask: one init script, and four loads in all when every one is cut", async () => {
    const { browser, made } = standInBrowser(Array.from({ length: 8 }, () => ({ cut: true, modulesFailed: true })));
    steady(steady(browser));
    const page = await (await browser.newContext()).newPage();
    await expect(page.goto("http://test/")).rejects.toThrow(/ERR_NETWORK_CHANGED.*4 loads/);
    expect(made[0]!.calls).toMatchObject({ goto: 4, init: 1 });
  });
});
