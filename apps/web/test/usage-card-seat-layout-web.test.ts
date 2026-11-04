// Home's usage card with a seat mark: the account's name and label keep their room. Before, the card header was one
// flex row in which only the name block could shrink (min-width 0, overflow-wrap anywhere), so the mark box and its
// Clear button squeezed it to a column one letter wide and the label ran down the card. Synthetic accounts only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const NOW = Date.UTC(2026, 9, 31, 19, 19, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Two columns of cards in an 840 px main pane, as on Home with the Decisions panel open.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="pane" style="width:840px"></div>
<script type="module">
  import { mount } from "svelte";
  import Home from "/src/lib/desktop/HomeView.svelte";
  const NOW = ${NOW};
  const acc = (account, profile, extra) => ({
    account, reportedAt: NOW - 11 * 60_000,
    fiveHour: { usedPercentage: 15, resetsAt: NOW + 2 * ${HOUR} }, sevenDay: { usedPercentage: 95, resetsAt: NOW + 4 * ${DAY} },
    spend: null, sessions: [], limits: null, onDemand: null, profile, ...extra,
  });
  mount(Home, { target: document.getElementById("pane"), props: { accounts: [
    acc("a1", { email: "pat.example@example.test", org: "personal", plan: "Max 20x" }, {
      reportedAt: NOW - 3 * ${DAY},
      seat: { state: "out", why: "usage_limit", since: NOW - 3 * ${DAY}, backAt: NOW - 6 * ${HOUR}, owner: "derived", by: "worker-one", fix: "wait_for_reset" },
    }),
    acc("a3", { email: "sam@example.test", org: "team", plan: "Max 5x" }),
  ], at: NOW, now: NOW, live: true, onOpenLane: () => {}, onClearSeat: () => {} } });
</script></body></html>`;

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });

describe("Home usage card: a seat mark leaves the label its room", () => {
  // [window, main pane] widths: two columns of about 400 px (the owner's case), a narrow window, and one column of
  // 600-640 px, where the mark, its button and the age just fit beside a name squeezed to a few px unless it keeps
  // a minimum width (measured: 7, 27 and 47 px at panes of 640, 660 and 680 without it).
  for (const [width, pane] of [[1280, 840], [600, 840], [1280, 640], [1280, 680]] as const) {
    it(`at a ${width} px window and a ${pane} px pane the account's name and label stay readable`, async () => {
      const tab = await web.browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = [];
      tab.on("pageerror", e => errors.push(e.message.split("\n")[0] ?? ""));
      await tab.goto(web.url);
      await tab.evaluate(w => { (document.getElementById("pane") as HTMLElement).style.width = `${w}px`; }, pane);
      const card = tab.locator('article.card[data-account="a1"]');
      await card.waitFor();
      await card.getByRole("button", { name: /Clear this mark/ }).waitFor();
      const who = await card.locator(".who").boundingBox();
      const name = await card.locator(".who h3").boundingBox();
      expect(who, "the name block is laid out").not.toBeNull();
      // The bug: the name block was squeezed to about one character (under 20 px) and grew hundreds of px tall.
      expect(who!.width, "the name block keeps at least 10em of width").toBeGreaterThanOrEqual(140);
      expect(name!.height, "the account's name stays on one line").toBeLessThanOrEqual(30);
      expect(who!.height, "the name and its label take at most three lines").toBeLessThanOrEqual(3 * 22);
      // Nothing in the header spills out of the card.
      const box = (await card.boundingBox())!;
      const header = (await card.locator("header").boundingBox())!;
      expect(header.x + header.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      expect(errors).toEqual([]);
      await tab.close();
    });
  }
});
