// Phone file chips stay apart: each name is its own chip, and the chips do not overlap.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Page from "/test/phone-file-chips-page.svelte";
  mount(Page, { target: document.body });
</script></body></html>`;

const NAMES = [
  "login-before-after.png", "release-notes.md", "build.log", "spec.pdf", "bundle.bin", "evil.svg",
  "notes.md", "rows.csv", "phone.md", "quarterly-planning-notes-for-the-whole-team.md",
];

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); }, 60_000);

describe("phone file chips", () => {
  it("keeps each file on its own chip, with a gap, and does not let the chips overlap", async () => {
    const tab = await web.browser.newPage({ viewport: { width: 390, height: 844 } });
    await tab.goto(web.url);
    await tab.locator(".file", { hasText: "release-notes.md" }).waitFor();
    const laid = await tab.locator(".bubble .file").evaluateAll(els => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      const hits = (a: { left: number; right: number; top: number; bottom: number }, b: typeof a) =>
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
      return els.map(el => {
        const name = el.querySelector("span");
        const size = el.querySelector("small");
        const chip = box(el);
        const others = els.filter(o => o !== el).map(box);
        const sizeBox = size ? box(size) : null;
        return {
          name: name?.textContent ?? "",
          size: size?.textContent ?? "",
          nameOwn: name !== null && name.parentElement === el && name.childElementCount === 0,
          sizeInside: !!sizeBox && sizeBox.left >= chip.left - 1 && sizeBox.right <= chip.right + 1 && sizeBox.top >= chip.top - 1 && sizeBox.bottom <= chip.bottom + 1,
          overlapsChip: others.some(o => hits(chip, o)),
          gap: Math.min(...others.filter(o => Math.abs(o.top - chip.top) < 8 && o.left > chip.left - 1).map(o => o.left - chip.right), Number.POSITIVE_INFINITY),
        };
      });
    });
    const names = laid.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining(NAMES));
    expect(new Set(names).size).toBe(names.length);
    for (const chip of laid) {
      expect(chip.nameOwn).toBe(true);
      expect(NAMES).toContain(chip.name);
      expect(chip.size.length).toBeGreaterThan(0);
      expect(chip.sizeInside).toBe(true);
      expect(chip.overlapsChip).toBe(false);
      if (chip.gap !== Number.POSITIVE_INFINITY) expect(chip.gap).toBeGreaterThanOrEqual(4);
    }
    const long = tab.locator(".file span", { hasText: "quarterly-planning-notes" });
    expect(await long.evaluate(el => el.scrollWidth > el.clientWidth + 1)).toBe(true);
    await tab.close();
  });
});
