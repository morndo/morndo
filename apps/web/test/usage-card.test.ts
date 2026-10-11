// Home's usage card: an account that names its windows shows those bars, and a status-line account shows the
// 5-hour and weekly windows as it does today. Synthetic accounts only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const NOW = Date.UTC(2026, 9, 11, 21, 0, 0);
const RESET = Date.UTC(2026, 10, 8, 0, 0, 0);
const HOUR = 3_600_000;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Home from "/src/lib/desktop/HomeView.svelte";
  const NOW = ${NOW};
  const RESET = ${RESET};
  const HOUR = ${HOUR};
  const cursor = {
    account: "cursor", reportedAt: NOW - 60_000,
    fiveHour: null, sevenDay: null,
    spend: { usedPercentage: 85, resetsAt: RESET, usedUsd: null, limitUsd: null, period: "included usage, monthly" },
    sessions: [{ sessionId: "cursor-plan", lane: "usage-collector", model: "Cursor Ultra · Auto 88% · API 45% · on-demand off", contextUsed: null, at: NOW }],
    limits: [
      { label: "Cursor models", usedPercentage: 88, resetsAt: RESET, resetsOn: "2026-11-07" },
      { label: "Other models", usedPercentage: 45, resetsAt: RESET, resetsOn: "2026-11-07" },
    ],
    onDemand: "off",
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
  mount(Home, { target: document.body, props: { accounts: [claude, zai, cursor], at: NOW, now: NOW, live: true, onOpenLane: () => {} } });
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
    expect(cursorText).not.toContain("not reported");
    expect(cursorText).not.toContain("5-hour window");
    expect(cursorText).not.toContain("Weekly window");
    expect(cursorText).not.toContain("Spend limit");
    expect(cursorText).not.toContain("usage-collector");
    expect(cursorText).not.toContain("Auto 88%");
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
