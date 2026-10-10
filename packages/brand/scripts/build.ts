// Generates the Morndo brand kit from one source: source/mark.svg (the mark on a 48-unit grid)
// plus the Outfit font for the wordmark outlines. Every SVG is written from the same path data;
// every PNG is rasterised from those SVGs with sharp (libvips). The colour tokens CSS is written
// from src/tokens.ts. Run: npm run build -w @morndo/brand (from the repo root), or
// `node scripts/build.ts [outDir]` from this package. The assets are committed; rerun after
// changing the source, the font or the constants below.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";
import sharp from "sharp";
import { cssVarName, neutral, themes, tokenRoles, type TokenName } from "../src/tokens.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = outputFolder(process.argv[2]);
const PREVIEW = join(ROOT, "preview");

/** The build deletes and rewrites its output folder, so it only writes to assets/ (the default) or
 *  to a .build-* scratch folder inside this package. Anything else is refused before any deletion. */
function outputFolder(arg: string | undefined): string {
  const assets = join(ROOT, "assets");
  if (arg === undefined) return assets;
  const out = resolve(arg);
  const rel = relative(ROOT, out);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (out === assets || (inside && (rel.split(sep)[0] ?? "").startsWith(".build-"))) return out;
  console.error(`build: refusing to write to ${out}; use the default (assets/) or a .build-* folder inside ${ROOT}`);
  process.exit(1);
}

const G = 48; // the mark's grid: 16 px = 3 units per pixel
const INK = "#000000";
const PAPER = "#ffffff";

// Lockup proportions, in mark units (the mark is G x G).
const WORD_XH = 0.42 * G; // wordmark x-height in the horizontal lockup
const H_GAP = 0.5 * G; // mark to wordmark, horizontal
const S_WIDTH = 2.25 * G; // wordmark width in the stacked lockup
const S_GAP = 0.25 * G; // mark to wordmark top, stacked
const TRACKING = 0.02; // em added after each letter
const WGHT = 500; // Outfit weight used for "morndo"
const ICON_RADIUS = 0.22; // app-icon corner radius, share of the side

// --- the mark -----------------------------------------------------------------------------

const source = readFileSync(join(ROOT, "source/mark.svg"), "utf8");
const paths = [...source.matchAll(/<path\b[^>]*>/g)].map(m => m[0]);
if (paths.length !== 1 || !/fill-rule="evenodd"/.test(paths[0] ?? "") || !/viewBox="0 0 48 48"/.test(source)) {
  throw new Error("source/mark.svg must hold exactly one evenodd <path> on a 0 0 48 48 viewBox");
}
const MARK_D = /\sd="([^"]+)"/.exec(paths[0] ?? "")?.[1] ?? "";

const fmt = (v: number): string => (Math.round(v * 1000) / 1000).toString();
const markPath = (fill: string, x = 0, y = 0, s = 1): string =>
  `<path transform="translate(${fmt(x)} ${fmt(y)}) scale(${fmt(s)})" fill="${fill}" fill-rule="evenodd" d="${MARK_D}"/>`;

// --- the wordmark ---------------------------------------------------------------------------

// At x-height 1, baseline 0: left/width to the ink, top/bottom of the ink (y down).
type Outline = { d: string; left: number; width: number; top: number; bottom: number };

const fontBuf = readFileSync(join(ROOT, "source/fonts/Outfit[wght].ttf"));
const font = opentype.parse(fontBuf.buffer.slice(fontBuf.byteOffset, fontBuf.byteOffset + fontBuf.byteLength));
const glyphAt = (ch: string) => font.variation.getTransform(font.charToGlyph(ch), { wght: WGHT });
// The x-height at this weight, measured on "x": OS/2 sxHeight holds the default (thinnest) instance.
const XH = -glyphAt("x").getPath(0, 0, font.unitsPerEm).getBoundingBox().y1;

function outline(text: string): Outline {
  const upm = font.unitsPerEm;
  let pen = 0;
  const ds: string[] = [];
  let top = 0;
  let bottom = 0;
  for (const ch of text) {
    const g = glyphAt(ch);
    const p = g.getPath(pen / XH, 0, upm / XH); // font units scaled so the x-height is 1
    const bb = p.getBoundingBox();
    if (Number.isFinite(bb.y1)) {
      top = Math.min(top, bb.y1);
      bottom = Math.max(bottom, bb.y2);
    }
    ds.push(p.toPathData(4));
    pen += g.advanceWidth + TRACKING * upm;
  }
  const last = glyphAt(text.at(-1) ?? "");
  const lastBox = last.getPath(0, 0, upm).getBoundingBox();
  const width = (pen - TRACKING * upm - last.advanceWidth + lastBox.x2) / XH; // to the last ink
  const left = glyphAt(text[0] ?? "").getPath(0, 0, upm).getBoundingBox().x1 / XH;
  return { d: ds.join(""), left, width, top, bottom };
}

const WORD = outline("morndo");
const wordPath = (fill: string, x: number, baseline: number, xh: number): string =>
  `<path transform="translate(${fmt(x)} ${fmt(baseline)}) scale(${fmt(xh)})" fill="${fill}" d="${WORD.d}"/>`;

// --- documents ----------------------------------------------------------------------------

const svg = (w: number, h: number, body: string, title = "Morndo"): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(w)} ${fmt(h)}" width="${fmt(w)}" height="${fmt(h)}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;

type Doc = { w: number; h: number; body: (fill: string) => string };

const MARK: Doc = { w: G, h: G, body: fill => markPath(fill) };

const WORDMARK: Doc = (() => {
  const xh = WORD_XH;
  const top = -WORD.top * xh;
  const left = WORD.left * xh;
  return { w: WORD.width * xh - left, h: top + WORD.bottom * xh, body: fill => wordPath(fill, -left, top, xh) };
})();

const HORIZONTAL: Doc = (() => {
  const xh = WORD_XH;
  const baseline = G / 2 + xh / 2; // the x-height band centred on the mark
  return {
    w: G + H_GAP + WORD.width * xh,
    h: G,
    body: fill => markPath(fill) + wordPath(fill, G + H_GAP, baseline, xh),
  };
})();

const STACKED: Doc = (() => {
  // Centre the wordmark by its ink, not its pen origin: drop the side bearing before the "m",
  // so the ink spans exactly 0..S_WIDTH under the centred mark.
  const xh = S_WIDTH / (WORD.width - WORD.left);
  const w = S_WIDTH;
  const baseline = G + S_GAP - WORD.top * xh;
  return {
    w,
    h: baseline + WORD.bottom * xh,
    body: fill => markPath(fill, (w - G) / 2, 0) + wordPath(fill, -WORD.left * xh, baseline, xh),
  };
})();

// Opaque square icons: the block fills the icon, its cuts show paper.
const square = (size: number, rounded: boolean): string => {
  const r = rounded ? fmt(ICON_RADIUS * size) : "0";
  const clip = rounded ? `<clipPath id="r"><rect width="${size}" height="${size}" rx="${r}"/></clipPath>` : "";
  const g = rounded ? ` clip-path="url(#r)"` : "";
  return svg(size, size, `${clip}<g${g}><rect width="${size}" height="${size}" fill="${PAPER}"/>${markPath(INK, 0, 0, size / G)}</g>`);
};

// favicon.svg: ink block on paper; swapped in dark mode so the tab never shows a black hole.
const faviconSvg = svg(G, G,
  `<style>.paper{fill:${PAPER}}.ink{fill:${INK}}@media (prefers-color-scheme:dark){.paper{fill:${INK}}.ink{fill:${PAPER}}}</style>` +
  `<rect class="paper" width="${G}" height="${G}"/>` +
  `<path class="ink" fill-rule="evenodd" d="${MARK_D}"/>`);

// --- writing --------------------------------------------------------------------------------

const written: string[] = [];
function write(rel: string, data: string | Buffer): void {
  const file = join(OUT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  written.push(rel);
}

const png = async (svgText: string, width: number, height: number): Promise<Buffer> =>
  sharp(Buffer.from(svgText), { density: 72 * Math.max(width / svgWidth(svgText), 1) })
    .resize(width, height, { fit: "fill" })
    .png({ compressionLevel: 9 })
    .toBuffer();

function svgWidth(text: string): number {
  return Number(/viewBox="0 0 ([\d.]+) /.exec(text)?.[1] ?? "1");
}

/** A PNG of the given height, its width from the SVG's own (written) proportions. */
function pngHigh(svgText: string, height: number): Promise<Buffer> {
  const [w, h] = (/viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svgText) ?? []).slice(1).map(Number);
  return png(svgText, Math.round(((w ?? 1) / (h ?? 1)) * height), height);
}

// ICO with PNG-compressed entries (supported since Windows Vista and by all current browsers).
function ico(entries: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((e, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(e.size >= 256 ? 0 : e.size, at); // width
    header.writeUInt8(e.size >= 256 ? 0 : e.size, at + 1); // height
    header.writeUInt8(0, at + 2); // palette colours
    header.writeUInt8(0, at + 3); // reserved
    header.writeUInt16LE(1, at + 4); // colour planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(e.data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += e.data.length;
  });
  return Buffer.concat([header, ...entries.map(e => e.data)]);
}

const variants = { black: INK, white: PAPER, currentcolor: "currentColor" } as const;

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });

  for (const [name, doc] of [["mark", MARK], ["wordmark", WORDMARK], ["lockup-horizontal", HORIZONTAL], ["lockup-stacked", STACKED]] as const) {
    for (const [variant, fill] of Object.entries(variants)) {
      write(`${name}/morndo-${name}-${variant}.svg`, svg(doc.w, doc.h, doc.body(fill)));
    }
  }
  // Raster copies for places that take no SVG (chat avatars, documents).
  for (const variant of ["black", "white"] as const) {
    const fill = variants[variant];
    write(`mark/morndo-mark-${variant}-512.png`, await png(svg(G, G, MARK.body(fill)), 512, 512));
    write(`lockup-horizontal/morndo-lockup-horizontal-${variant}-256h.png`, await pngHigh(svg(HORIZONTAL.w, HORIZONTAL.h, HORIZONTAL.body(fill)), 256));
    write(`lockup-stacked/morndo-lockup-stacked-${variant}-512h.png`, await pngHigh(svg(STACKED.w, STACKED.h, STACKED.body(fill)), 512));
  }

  // App icons.
  const appIcon = square(1024, true);
  write("app-icon/morndo-app-icon.svg", appIcon);
  write("app-icon/morndo-app-icon-1024.png", await png(appIcon, 1024, 1024));
  // Maskable: full bleed. The sun's farthest point is 18/48 = 37.5% of the side from the centre,
  // inside the 40% safe-zone circle (W3C Web App Manifest); the horizon runs to the edge by design.
  const maskable = square(1024, false);
  write("app-icon/morndo-app-icon-maskable.svg", maskable);
  write("app-icon/morndo-app-icon-maskable-1024.png", await png(maskable, 1024, 1024));

  // Favicons and web app icons.
  // web/: exactly the files to copy into the web app's static root, plus head.html to paste.
  const full = square(G, false);
  const icoEntries: { size: number; data: Buffer }[] = [];
  for (const size of [16, 32, 48]) {
    const data = await png(full, size, size);
    write(`web/favicon-${size}.png`, data);
    icoEntries.push({ size, data });
  }
  write("web/favicon.ico", ico(icoEntries));
  write("web/favicon.svg", faviconSvg);
  write("web/apple-touch-icon.png", await png(square(180, false), 180, 180)); // opaque; iOS rounds it
  write("web/icon-192.png", await png(square(192, true), 192, 192));
  write("web/icon-512.png", await png(square(512, true), 512, 512));
  write("web/icon-maskable-512.png", await png(square(512, false), 512, 512));
  write("web/site.webmanifest", `${JSON.stringify({
    name: "Morndo",
    short_name: "Morndo",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // The light page background: light is the default theme in tokens.css (dark follows the OS),
    // and WIRING-web.md uses the same value for the light theme-color meta. Never pure black.
    theme_color: themes.light.bg,
    background_color: themes.light.bg,
  }, null, 2)}\n`);
  write("web/head.html", [
    `<link rel="icon" href="/favicon.ico" sizes="32x32">`,
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`,
    `<link rel="manifest" href="/site.webmanifest">`,
    "",
  ].join("\n"));

  // Social image, 1200 x 630: the white lockup on black, centred.
  const og = (() => {
    const W = 1200;
    const H = 630;
    const h = 150;
    const s = h / G;
    const w = HORIZONTAL.w * s;
    return svg(W, H, `<rect width="${W}" height="${H}" fill="${INK}"/><g transform="translate(${fmt((W - w) / 2)} ${fmt((H - h) / 2)}) scale(${fmt(s)})">${HORIZONTAL.body(PAPER)}</g>`);
  })();
  write("social/morndo-og-1200x630.svg", og);
  write("social/morndo-og-1200x630.png", await png(og, 1200, 630));

  write("tokens/morndo-tokens.css", tokensCss());

  if (OUT === join(ROOT, "assets")) await contactSheet();
  console.log(`${written.length} files in ${OUT}`);
}

// --- colour tokens (assets/tokens/morndo-tokens.css) -----------------------------------------

/** Light by default; dark follows the OS unless data-theme="light"; data-theme="dark" forces dark,
 *  also on a subtree. Rules for using the tokens: COLOR.md. */
function tokensCss(): string {
  // Anything that refers to a themed token must be declared inside each theme block: a custom
  // property's var() is resolved where it is declared, so a :root-level ring would keep the
  // page theme's colour inside a data-theme subtree.
  const block = (theme: "light" | "dark", indent: string): string =>
    [...(Object.keys(themes[theme]) as TokenName[]).map(k => `${indent}${cssVarName(k)}: ${themes[theme][k]}; /* ${tokenRoles[k]} */`),
      `${indent}--morndo-focus-ring: var(--morndo-focus-width) solid var(--morndo-focus);`].join("\n");
  const ramp = Object.entries(neutral).map(([k, v]) => `  --morndo-neutral-${k}: ${v};`).join("\n");
  return [
    `/* Morndo colour tokens, palette "A Ink": monochrome, colour only for status.`,
    `   Generated by packages/brand/scripts/build.ts from src/tokens.ts; do not edit by hand.`,
    `   Every text and UI pair is checked against WCAG 2.2 and APCA in test/tokens.test.ts. */`,
    ``,
    `:root {`,
    ramp,
    `  --morndo-focus-width: 2px;`,
    `  --morndo-focus-offset: 2px;`,
    `}`,
    ``,
    `:root, [data-theme="light"] {`,
    `  color-scheme: light;`,
    block("light", "  "),
    `}`,
    ``,
    `@media (prefers-color-scheme: dark) {`,
    `  :root:not([data-theme="light"]) {`,
    `    color-scheme: dark;`,
    block("dark", "    "),
    `  }`,
    `}`,
    ``,
    `[data-theme="dark"] {`,
    `  color-scheme: dark;`,
    block("dark", "  "),
    `}`,
    ``,
  ].join("\n");
}

// --- contact sheet (preview/contact-sheet.png), for review only -------------------------------

async function contactSheet(): Promise<void> {
  const label = (text: string, x: number, y: number): string => {
    const o = outline(text.toLowerCase());
    return `<path transform="translate(${x} ${y}) scale(10)" fill="#555" d="${o.d}"/>`;
  };
  const W = 1800;
  const tiles: string[] = [];
  const cell = (x: number, y: number, w: number, h: number, bg: string, inner: string, name: string): void => {
    tiles.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${bg}" stroke="#ddd"/>${inner}${label(name, x, y + h + 26)}`);
  };
  const place = (doc: Doc, fill: string, x: number, y: number, w: number, h: number, maxH: number): string => {
    const s = Math.min(maxH / doc.h, (w - 80) / doc.w);
    return `<g transform="translate(${fmt(x + (w - doc.w * s) / 2)} ${fmt(y + (h - doc.h * s) / 2)}) scale(${fmt(s)})">${doc.body(fill)}</g>`;
  };
  let y = 40;
  for (const [name, doc, h, maxH] of [["mark", MARK, 260, 180], ["wordmark", WORDMARK, 200, 90], ["lockup horizontal", HORIZONTAL, 220, 110], ["lockup stacked", STACKED, 320, 240]] as const) {
    cell(40, y, 820, h, PAPER, place(doc, INK, 40, y, 820, h, maxH), `${name} black`);
    cell(940, y, 820, h, INK, place(doc, PAPER, 940, y, 820, h, maxH), `${name} white`);
    y += h + 70;
  }
  const icons = [
    ["app icon", readSvgBody(square(1024, true)), 1024],
    ["maskable", readSvgBody(square(512, false)), 512],
    ["favicon", readSvgBody(square(G, false)), G],
  ] as const;
  icons.forEach(([name, body, size], i) => {
    const x = 40 + i * 300;
    tiles.push(`<rect x="${x}" y="${y}" width="260" height="260" rx="12" fill="#e9e9e9"/><g transform="translate(${x + 30} ${y + 30}) scale(${fmt(200 / size)})">${body}</g>${label(name, x, y + 286)}`);
  });
  // The maskable safe zone: a centred circle, radius 40% of the icon (W3C Web App Manifest).
  tiles.push(`<circle cx="${340 + 130}" cy="${y + 130}" r="80" fill="none" stroke="#e33" stroke-width="2" stroke-dasharray="6 5"/>`);
  tiles.push(label("16 and 32 px", 940, y + 140), label("favicon.svg", 940, y + 286), label("light, dark", 940, y + 306));
  const darkFav = readSvgBody(faviconSvg.replace(/@media \(prefers-color-scheme:dark\)\{(.*?)\}\}/, "$1}"));
  tiles.push(`<g transform="translate(940 ${y + 180}) scale(1.5)">${readSvgBody(faviconSvg)}</g>`);
  tiles.push(`<rect x="1030" y="${y + 172}" width="88" height="88" rx="8" fill="#202124"/><g transform="translate(1038 ${y + 180}) scale(1.5)">${darkFav.replace(/\.paper/g, ".dpaper").replace(/\.ink/g, ".dink").replace(/class="paper"/, 'class="dpaper"').replace(/class="ink"/, 'class="dink"')}</g>`);
  tiles.push(label("social 1200 x 630", 1160, y + 330));
  const sheetH = y + 350;
  const sheet = svg(W, sheetH, `<rect width="${W}" height="${sheetH}" fill="#f6f6f6"/>${tiles.join("")}`);
  let img = sharp(Buffer.from(sheet)).png();
  const base = await img.toBuffer();
  // True-size favicons (16, 32 px) and the OG image, composited as rasters.
  const fav16 = await png(square(G, false), 16, 16);
  const fav32 = await png(square(G, false), 32, 32);
  const og = await sharp(join(OUT, "social/morndo-og-1200x630.png")).resize(600, 315).png().toBuffer();
  img = sharp(base).composite([
    { input: fav16, left: 948, top: y + 100 },
    { input: fav32, left: 980, top: y + 92 },
    { input: og, left: 1160, top: y - 10 },
  ]);
  mkdirSync(PREVIEW, { recursive: true });
  await img.png({ compressionLevel: 9 }).toFile(join(PREVIEW, "contact-sheet.png"));
  console.log(`preview/contact-sheet.png ${W}x${sheetH}`);
}

function readSvgBody(text: string): string {
  return text.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<title>.*?<\/title>/, "");
}

await main();
