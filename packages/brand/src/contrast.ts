// The contrast measures and targets the brand's tokens are held to (COLOR.md), shared by test/tokens.test.ts, which
// checks every pair here in both themes, and by the app's end-to-end checks, which hold each pair a screen actually
// renders to the same targets (ADR-0009). Not exported from index.ts: the app never ships apca-w3.
import { APCAcontrast, sRGBtoY } from "apca-w3";
import type { ThemeName, TokenName } from "./tokens.ts";

// ---------- measures ----------
export const rgb255 = (hex: string): [number, number, number] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const lin = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const linear = (hex: string): [number, number, number] => rgb255(hex).map(v => lin(v / 255)) as [number, number, number];
export const luminance = (hex: string): number => { const [r, g, b] = linear(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

/** A token over a base colour: translucent tokens (#rrggbbaa) are composited, opaque ones pass through. */
export const over = (token: string, base: string): string => {
  if (token.length !== 9) return token;
  const a = parseInt(token.slice(7, 9), 16) / 255;
  const [f, b] = [rgb255(token), rgb255(base)];
  return "#" + f.map((v, i) => Math.round(v * a + (b[i] ?? 0) * (1 - a)).toString(16).padStart(2, "0")).join("");
};

/** WCAG 2.2 contrast ratio (https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio). */
export const wcag = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
/** APCA Lc (signed), from the official apca-w3 package, unmodified. */
export const apca = (text: string, bg: string): number => Number(APCAcontrast(sRGBtoY(rgb255(text)), sRGBtoY(rgb255(bg))));
// ---------- targets (COLOR.md; research in the product lane, 2026-10-01) ----------
export type Target = { fg: TokenName; on: TokenName[]; wcag: number; lc: Record<ThemeName, number>; what: string };
export const TARGETS: Target[] = [
  { fg: "text", on: ["bg", "surface", "raised"], wcag: 7, lc: { light: 90, dark: 85 }, what: "body text" },
  { fg: "textMuted", on: ["bg", "surface", "raised"], wcag: 4.5, lc: { light: 75, dark: 75 }, what: "secondary text, also below 16px" },
  { fg: "placeholder", on: ["surface"], wcag: 4.5, lc: { light: 45, dark: 45 }, what: "placeholder" },
  { fg: "link", on: ["bg", "surface"], wcag: 4.5, lc: { light: 75, dark: 75 }, what: "links" },
  { fg: "inkFg", on: ["ink"], wcag: 4.5, lc: { light: 75, dark: 75 }, what: "label on a primary button" },
  { fg: "accentFg", on: ["accent"], wcag: 4.5, lc: { light: 75, dark: 75 }, what: "label on accent" },
  // Tinted rows carry labels and always take --morndo-text (COLOR.md rule 8): 7:1 and Lc 85.
  { fg: "text", on: ["fill", "selection"], wcag: 7, lc: { light: 85, dark: 85 }, what: "text on a tint (fill, selection)" },
  { fg: "inkFg", on: ["inkHover"], wcag: 4.5, lc: { light: 75, dark: 75 }, what: "label on a hovered primary button" },
  { fg: "focus", on: ["bg", "surface"], wcag: 3, lc: { light: 45, dark: 45 }, what: "focus ring (2px solid)" },
  { fg: "border", on: ["bg", "surface"], wcag: 3, lc: { light: 45, dark: 45 }, what: "control boundary" },
  ...(["success", "warning", "danger"] as const).flatMap((s): Target[] => [
    { fg: s, on: ["bg", "surface"], wcag: 3, lc: { light: 45, dark: 45 }, what: `${s} indicator (icon, dot)` },
    { fg: `${s}Text`, on: ["bg", "surface", `${s}Subtle`], wcag: 4.5, lc: { light: 75, dark: 75 }, what: `${s} text` },
  ]),
];

/** One row of the contrast table: both gates must pass. */
export function measure(fgHex: string, bgHex: string, need: { wcag: number; lc: number }) {
  const ratio = wcag(fgHex, bgHex);
  const lc = apca(fgHex, bgHex);
  return { ratio, lc, pass: ratio >= need.wcag && Math.abs(lc) >= need.lc };
}
