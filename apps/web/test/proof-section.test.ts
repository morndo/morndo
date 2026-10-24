// ProofSection in the task panel (ADR-0035 step 5): text-only proof beside a brief, in headless Chromium.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Page from "/test/proof-section-page.svelte";
  mount(Page, { target: document.body });
</script></body></html>`;

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); }, 60_000);

const cell = (tab: Awaited<ReturnType<Web["browser"]["newPage"]>>, name: string) => tab.locator(`[data-cell="${name}"]`);

describe("the panel's proof section (ADR-0035)", () => {
  it("a verified brief shows its line in the ok colour and a ✓ row per reference", { timeout: 30_000 }, async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await tab.goto(web.url);
      const box = cell(tab, "verified");
      await box.locator("[data-proof-line]").waitFor();
      const line = box.locator("[data-proof-line]");
      expect(await line.innerText()).toBe("proof: 2 of 2 green");
      expect(await line.evaluate(el => el.classList.contains("ok"))).toBe(true);
      const refs = box.locator("[data-proof-ref]");
      expect(await refs.count()).toBe(2);
      expect(await refs.nth(0).getAttribute("data-state")).toBe("green");
      expect(await refs.nth(0).locator(".mark").innerText()).toBe("✓");
      expect(await refs.nth(1).locator(".mark").innerText()).toBe("✓");
      expect(await box.locator("[data-proof-summary]").innerText()).toContain("Totals row rounds to cents");
    } finally { await tab.close(); }
  });

  it("a red reference is marked and its detail is shown; the line is in the bad colour", { timeout: 30_000 }, async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await tab.goto(web.url);
      const box = cell(tab, "failing");
      const line = box.locator("[data-proof-line]");
      await line.waitFor();
      expect(await line.evaluate(el => el.classList.contains("bad"))).toBe(true);
      const lint = box.locator('[data-proof-ref][data-state="red"]');
      await lint.waitFor();
      expect(await lint.locator(".mark").innerText()).toBe("✗");
      expect(await lint.innerText()).toContain('"lint" failed');
      expect(await lint.innerText()).toContain("https://github.com/morndo/morndo/actions/runs/9");
      const mismatch = box.locator('[data-proof-ref][data-state="mismatch"]');
      expect(await mismatch.locator(".mark").innerText()).toBe("≠");
    } finally { await tab.close(); }
  });

  it("an attested item is labelled as the lane's word", { timeout: 30_000 }, async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await tab.goto(web.url);
      const box = cell(tab, "failing");
      const item = box.locator("[data-proof-attested] li").first();
      await item.waitFor();
      expect(await item.innerText()).toContain("Attested (tests): npm test: 48 passed");
      expect(await item.innerText()).toContain("the lane's word, not checked");
    } finally { await tab.close(); }
  });

  it("a review without a brief says so", { timeout: 30_000 }, async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await tab.goto(web.url);
      const box = cell(tab, "no-brief");
      await box.locator("[data-proof-line]").waitFor();
      expect(await box.locator("[data-proof-line]").innerText()).toBe("proof: no brief");
      expect(await box.innerText()).toContain("No brief yet.");
      expect(await box.innerText()).toContain("morndo-board brief");
    } finally { await tab.close(); }
  });

  it("a reference that was not checked reads as not checked, not as a failure", { timeout: 30_000 }, async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await tab.goto(web.url);
      const box = cell(tab, "not-checked");
      const row = box.locator('[data-proof-ref][data-state="not_checked"]');
      await row.waitFor();
      expect(await row.locator(".mark").innerText()).toBe("○");
      expect(await row.locator(".sr-only, [class~=\"sr-only\"]").count()).toBeGreaterThan(0);
      expect(await row.innerText()).toContain("not checked");
      expect(await row.getAttribute("data-state")).toBe("not_checked");
      expect(await box.locator("[data-proof-line]").evaluate(el => el.classList.contains("bad"))).toBe(false);
    } finally { await tab.close(); }
  });

  it("a task at work with no brief shows no Proof section", { timeout: 30_000 }, async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await tab.goto(web.url);
      const box = cell(tab, "doing-empty");
      expect(await box.locator("[data-proof]").count()).toBe(0);
    } finally { await tab.close(); }
  });

  it("a reference with no result row reads as pending", { timeout: 30_000 }, async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await tab.goto(web.url);
      const box = cell(tab, "pending-ref");
      const pending = box.locator('[data-proof-ref][data-state="pending"]');
      await pending.waitFor();
      expect(await pending.locator(".mark").innerText()).toBe("…");
      expect(await pending.innerText()).toContain("acme/shop@3e9d1a7:ci,lint");
    } finally { await tab.close(); }
  });

  it("the needs list marks each item and colours the one not covered", { timeout: 30_000 }, async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await tab.goto(web.url);
      const box = cell(tab, "needs-list");
      const needs = box.locator("[data-proof-needs]");
      await needs.waitFor();
      expect(await needs.locator("li").count()).toBe(4);
      expect(await needs.locator('[data-proof-need][data-status="covered"]').locator(".mark").innerText()).toBe("✓");
      expect(await needs.locator('[data-proof-need][data-status="told"]').locator(".mark").innerText()).toBe("~");
      expect(await needs.locator('[data-proof-need][data-status="open"]').locator(".mark").innerText()).toBe("…");
      const bad = needs.locator('[data-proof-need][data-status="not_covered"]');
      expect(await bad.locator(".mark").innerText()).toBe("◇");
      expect(await bad.evaluate(el => el.classList.contains("bad"))).toBe(true);
      expect(await needs.locator('[data-proof-need][data-status="told"]').innerText()).toContain("added by the lane");
    } finally { await tab.close(); }
  });

  it("at 390 px the section does not overflow", { timeout: 30_000 }, async () => {
    const tab = await web.browser.newPage({ viewport: { width: 390, height: 900 } });
    try {
      await tab.goto(web.url);
      const box = cell(tab, "needs-list");
      const needs = box.locator("[data-proof-needs]");
      await needs.waitFor();
      const longSpec = "pr@acme/shop: " + "x".repeat(120);
      const overflow = await needs.evaluate((el, spec) => {
        const li = el.querySelector("li");
        if (li) li.textContent = spec;
        return el.scrollWidth > el.clientWidth;
      }, longSpec);
      expect(overflow).toBe(false);
      expect(await needs.evaluate(el => getComputedStyle(el).overflowWrap)).toBe("anywhere");
    } finally { await tab.close(); }
  });

  it("a long item wraps beside its mark: the mark stays on the item's first line", { timeout: 30_000 }, async () => {
    const tab = await web.browser.newPage({ viewport: { width: 390, height: 900 } });
    try {
      await tab.goto(web.url);
      const item = cell(tab, "long-need").locator("[data-proof-need]").first();
      await item.waitFor();
      const mark = await item.locator(".mark").boundingBox();
      const spec = await item.locator("code").boundingBox();
      expect(mark && spec).toBeTruthy();
      expect(spec!.height).toBeGreaterThan(40);                         // the text really wraps onto several lines
      expect(mark!.x).toBeLessThan(spec!.x);                            // the mark is beside it, not above it
      expect(Math.abs(mark!.y - spec!.y)).toBeLessThan(12);             // on the first line
    } finally { await tab.close(); }
  });

  it("a stand-in forge is marked, and a real one is not", { timeout: 30_000 }, async () => {
    const tab = await web.browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await tab.goto(web.url);
      const marked = cell(tab, "stand-in");
      await marked.locator("[data-proof-line]").waitFor();
      expect(await marked.locator("[data-proof-standin]").innerText()).toBe("Read from a stand-in forge, not GitHub");
      expect(await cell(tab, "verified").locator("[data-proof-standin]").count()).toBe(0);
    } finally { await tab.close(); }
  });
});

