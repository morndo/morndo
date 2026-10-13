// The contrast of what a phone screen renders (ADR-0009, criterion 17; moved here from catchup.e2e.ts by ADR-0011 so
// the chat screens are held to it too).
import type { Page } from "playwright";
import { themes, type ThemeName, type TokenName } from "../packages/brand/src/tokens.ts";
import { TARGETS, measure } from "../packages/brand/src/contrast.ts";

// ---- the contrast of what a screen renders (criterion 17): every text's colour against the background it sits on, as
// the brand's tokens; each pair must be one the brand's contrast test holds to its target (packages/brand).
const hex = (rgb: string) => { const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(rgb); return m && (m[4] === undefined || Number(m[4]) === 1) ? `#${[m[1], m[2], m[3]].map(x => Number(x).toString(16).padStart(2, "0")).join("")}` : null; };
export async function contrastProblems(page: Page, theme: ThemeName, root = "body"): Promise<string[]> {
  const pairs = await page.evaluate((root) => {
    const out: { fg: string; bg: string; text: string }[] = [];
    // A colour as [r, g, b, a] (0-255, alpha 0-1), from rgb()/rgba() or color(srgb …), as browsers compute them.
    const parse = (c: string): [number, number, number, number] | null => {
      let m = /rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)/.exec(c);
      if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
      m = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(c);
      if (m) return [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255, m[4] === undefined ? 1 : Number(m[4])];
      return null;
    };
    // The background a text sits on, as seen: translucent layers (a sticky header's glass) composited over the first
    // opaque background below them.
    const bgOf = (el: Element | null): string => {
      const layers: [number, number, number, number][] = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (!c || c[3] === 0) continue;
        layers.push(c);
        if (c[3] === 1) break;
      }
      let base = layers.at(-1)?.[3] === 1 ? layers.pop() ?? [255, 255, 255, 1] : parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1];
      for (const l of layers.reverse()) base = [0, 1, 2].map(i => l[3] * (l[i] ?? 0) + (1 - l[3]) * (base[i] ?? 0)).concat(1) as [number, number, number, number];
      return `rgb(${base.slice(0, 3).map(v => Math.round(v)).join(", ")})`;
    };
    const start = document.querySelector(root) ?? document.body;
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const el = t.parentElement;
      if (!el || !t.textContent?.trim() || el.closest("pre.screen, .sr, [aria-hidden='true']")) continue;
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      if (!r.width || !r.height || s.visibility === "hidden" || s.opacity === "0") continue;
      out.push({ fg: s.color, bg: bgOf(el), text: t.textContent.trim().slice(0, 30) });
    }
    return out;
  }, root);
  const names = (h: string) => (Object.entries(themes[theme]) as [TokenName, string][]).filter(([, v]) => v.toLowerCase() === h).map(([k]) => k);
  const problems = new Set<string>();
  for (const p of pairs) {
    const f = hex(p.fg), b = hex(p.bg);
    if (!f || !b) { problems.add(`translucent colour on "${p.text}": ${p.fg} on ${p.bg}`); continue; }
    const ok = names(f).some(fg => names(b).some(bg => TARGETS.some(t => t.fg === fg && t.on.includes(bg) && measure(f, b, { wcag: t.wcag, lc: t.lc[theme] }).pass)));
    if (!ok) problems.add(`"${p.text}": ${f} (${names(f).join("/") || "no token"}) on ${b} (${names(b).join("/") || "no token"})`);
  }
  return [...problems];
}

