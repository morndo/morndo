// The colour tokens keep their contrast: every text and UI pair passes WCAG 2.2 AND APCA in both
// themes (targets: COLOR.md), the dark/light lightness rules hold, Ink stays monochrome (colour only
// for status), the status indicators stay apart for colour-blind users, and the generated CSS
// matches src/tokens.ts. A token change that drops any pair below its target fails here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { brandAssets } from "../src/index.ts";
import { brandAssetUrl } from "../src/node.ts";
import { cssVarName, neutral, themes, type ThemeName, type TokenName } from "../src/tokens.ts";
import { TARGETS, apca, linear, luminance, measure, over, wcag } from "../src/contrast.ts";

// ---------- measures (src/contrast.ts holds the shared ones and the targets) ----------
/** CIE L* 0-100. */
const cieL = (hex: string): number => { const Y = luminance(hex); return Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y; };
/** OKLab (Ottosson). */
const oklab = ([r, g, b]: [number, number, number]): [number, number, number] => {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const chroma = (hex: string): number => { const [, a, b] = oklab(linear(hex)); return Math.hypot(a, b); };
// Colour-vision deficiency, Machado, Oliveira & Fernandes 2009, severity 1.0, applied in linear RGB.
const CVD = {
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
} as const;
const deltaEOK = (a: string, b: string, kind?: keyof typeof CVD): number => {
  const sim = (hex: string): [number, number, number] => {
    const v = linear(hex);
    if (!kind) return v;
    return CVD[kind].map(row => Math.min(1, Math.max(0, row[0] * v[0] + row[1] * v[1] + row[2] * v[2]))) as [number, number, number];
  };
  const [p, q] = [oklab(sim(a)), oklab(sim(b))];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};

const THEMES: ThemeName[] = ["light", "dark"];

describe.each(THEMES)("%s theme: every pair passes WCAG 2.2 and APCA", theme => {
  const t = themes[theme];
  const rows = TARGETS.flatMap(x => x.on.map(bg => ({ ...x, bg, lcMin: x.lc[theme] })));
  it.each(rows)("$fg on $bg ($what): WCAG >= $wcag:1, |Lc| >= $lcMin", ({ fg, bg, wcag: w, lcMin }) => {
    const m = measure(t[fg], t[bg], { wcag: w, lc: lcMin });
    expect({ ratio: Number(m.ratio.toFixed(2)), lc: Number(Math.abs(m.lc).toFixed(1)), pass: m.pass }).toMatchObject({ pass: true });
  });
});

describe("design rules", () => {
  it("light background is L* 97-100, dark background L* 4-10 (never #000), dark body text L* 88-94 (never #fff)", () => {
    expect(cieL(themes.light.bg)).toBeGreaterThanOrEqual(97);
    expect(cieL(themes.dark.bg)).toBeGreaterThanOrEqual(4);
    expect(cieL(themes.dark.bg)).toBeLessThanOrEqual(10);
    expect(cieL(themes.dark.text)).toBeGreaterThanOrEqual(88);
    expect(cieL(themes.dark.text)).toBeLessThanOrEqual(94);
  });

  it.each(THEMES)("%s: dividers are visible but quiet, 1.2-2.1:1 against bg and surface", theme => {
    for (const bg of ["bg", "surface"] as const) {
      const r = wcag(themes[theme].divider, themes[theme][bg]);
      expect(r).toBeGreaterThanOrEqual(1.2);
      expect(r).toBeLessThanOrEqual(2.1);
    }
  });

  it.each(THEMES)("%s: Ink has no colour accent; colour is only for status", theme => {
    const t = themes[theme];
    for (const k of ["ink", "inkHover", "accent", "link", "focus", "hover", "fill", "selection", "text", "textMuted", "bg", "surface", "raised", "border", "divider"] as const) {
      expect([k, chroma(t[k]) < 0.02]).toEqual([k, true]);
    }
    for (const k of ["success", "warning", "danger"] as const) expect([k, chroma(t[k]) >= 0.06]).toEqual([k, true]);
  });

  it.each(THEMES)("%s: status indicators stay apart for deuteranopia and protanopia (deltaE OK >= 0.06)", theme => {
    const t = themes[theme];
    const pairs = [["success", "warning"], ["success", "danger"], ["warning", "danger"]] as const;
    for (const [a, b] of pairs) {
      for (const kind of [undefined, "deuteranopia", "protanopia"] as const) {
        expect([a, b, kind ?? "normal", deltaEOK(t[a], t[b], kind) >= 0.06]).toEqual([a, b, kind ?? "normal", true]);
      }
    }
  });

  it.each(THEMES)("%s: tints are ordered and visible: hover < fill < selection, selection >= 1.2:1 on bg and 1.25:1 on surface", theme => {
    const t = themes[theme];
    for (const base of ["bg", "surface"] as const) {
      const [h, f, s] = (["hover", "fill", "selection"] as const).map(k => wcag(over(t[k], t[base]), t[base]));
      expect([base, (h ?? 0) < (f ?? 0) && (f ?? 0) < (s ?? 0)]).toEqual([base, true]);
    }
    expect(wcag(t.fill, t.surface)).toBeGreaterThanOrEqual(1.15);
    expect(wcag(t.selection, t.bg)).toBeGreaterThanOrEqual(1.2);
    expect(wcag(t.selection, t.surface)).toBeGreaterThanOrEqual(1.25);
  });

  it.each(THEMES)("%s: hover is a state layer, visible on bg, surface and raised (menus) and below selection there", theme => {
    const t = themes[theme];
    for (const base of ["bg", "surface", "raised"] as const) {
      const h = over(t.hover, t[base]);
      expect([base, Number(wcag(h, t[base]).toFixed(3)) >= 1.08]).toEqual([base, true]);
      expect([base, wcag(h, t[base]) < wcag(t.selection, t[base])]).toEqual([base, true]);
      const m = measure(t.text, h, { wcag: 7, lc: 85 });
      expect([base, "text on hover", m.pass]).toEqual([base, "text on hover", true]);
    }
  });

  it.each(THEMES)("%s: the primary button's hover is visibly different from ink (>= 1.2:1)", theme => {
    expect(wcag(themes[theme].inkHover, themes[theme].ink)).toBeGreaterThanOrEqual(1.2);
  });

  it("both themes define the same tokens", () => {
    expect(Object.keys(themes.dark).sort()).toEqual(Object.keys(themes.light).sort());
  });
});

describe("generated CSS", () => {
  const css = readFileSync(brandAssetUrl(brandAssets.tokens.css), "utf8");
  const block = (start: string): string => {
    const i = css.indexOf(start);
    if (i < 0) throw new Error(`no block ${start}`);
    return css.slice(i, css.indexOf("}", i));
  };
  const blocks: [string, ThemeName][] = [[':root, [data-theme="light"] {', "light"], [':root:not([data-theme="light"]) {', "dark"], ['[data-theme="dark"] {', "dark"]];

  it.each(blocks)("%s holds every %s token with its value", (start, theme) => {
    const b = block(start);
    for (const [k, v] of Object.entries(themes[theme])) expect(b).toContain(`${cssVarName(k as TokenName)}: ${v};`);
  });
  it("holds the neutral ramp and the dark media query", () => {
    for (const [k, v] of Object.entries(neutral)) expect(css).toContain(`--morndo-neutral-${k}: ${v};`);
    expect(css).toContain("@media (prefers-color-scheme: dark)");
  });
  it.each(blocks)("%s declares the focus ring itself, so it follows a data-theme subtree", start => {
    expect(block(start)).toContain("--morndo-focus-ring: var(--morndo-focus-width) solid var(--morndo-focus);");
  });
  it("no :root-level property refers to a themed token (its var() would resolve once, at the root)", () => {
    const root = block(":root {");
    const themed = new Set(Object.keys(themes.light).map(k => cssVarName(k as TokenName)));
    const refs = [...root.matchAll(/var\((--morndo-[a-z0-9-]+)\)/g)].map(m => m[1] ?? "");
    expect(refs.filter(r => themed.has(r))).toEqual([]);
  });
});

describe("the checks can fail (negative controls)", () => {
  it("rejects grey #999 text on white, a #000 dark background and a coloured accent", () => {
    expect(measure("#999999", "#ffffff", { wcag: 4.5, lc: 75 }).pass).toBe(false);
    expect(cieL("#000000")).toBeLessThan(4);
    expect(chroma("#5e6ad2")).toBeGreaterThanOrEqual(0.02);
  });
  it("uses the official APCA: #888 on #fff is Lc 63.06, black on white 106.04 (apca-w3 test values)", () => {
    expect(apca("#888888", "#ffffff")).toBeCloseTo(63.056, 3);
    expect(apca("#000000", "#ffffff")).toBeCloseTo(106.041, 3);
    expect(apca("#ffffff", "#888888")).toBeCloseTo(-68.541, 3);
  });
});
