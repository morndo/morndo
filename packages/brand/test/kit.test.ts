// The brand kit is complete, exact and regenerable: the index and the files agree, every PNG has
// its exact size, favicon.ico holds 16/32/48 px, the manifest is valid, every SVG renders, and a
// fresh build from source/mark.svg writes the same SVGs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { brandAssets, themes, type BrandAssetPath } from "../src/index.ts";
import { brandAssetUrl } from "../src/node.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const leaves = (o: object): string[] => Object.values(o).flatMap(v => (typeof v === "string" ? [v] : leaves(v as object)));
const listed = leaves(brandAssets) as BrandAssetPath[];
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => relative(dir, join(d.parentPath, d.name)))
    .sort();
const read = (p: BrandAssetPath): Buffer => readFileSync(brandAssetUrl(p));

export function pngSize(buf: Buffer): [number, number] {
  if (buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("not a PNG");
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

export function icoEntries(buf: Buffer): { width: number; height: number; data: Buffer }[] {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error("not an ICO");
  return Array.from({ length: buf.readUInt16LE(4) }, (_, i) => {
    const at = 6 + 16 * i;
    const size = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    return { width: buf.readUInt8(at) || 256, height: buf.readUInt8(at + 1) || 256, data: buf.subarray(offset, offset + size) };
  });
}

const viewBox = (svg: string): [number, number] => {
  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!m) throw new Error("no viewBox");
  return [Number(m[1]), Number(m[2])];
};

/** The exact size a PNG must have, from its name (and, for lockups, its SVG's proportions). */
function expectedSize(p: string): [number, number] {
  const wh = /-(\d+)x(\d+)\.png$/.exec(p);
  if (wh) return [Number(wh[1]), Number(wh[2])];
  const h = /^(.*)-(black|white)-(\d+)h\.png$/.exec(p);
  if (h) {
    const [w0, h0] = viewBox(readFileSync(join(ROOT, `${h[1]}-${h[2]}.svg`), "utf8"));
    const height = Number(h[3]);
    return [Math.round((w0 / h0) * height), height];
  }
  if (p.endsWith("apple-touch-icon.png")) return [180, 180];
  const sq = /-(\d+)\.png$/.exec(p);
  if (sq) return [Number(sq[1]), Number(sq[1])];
  throw new Error(`no expected size for ${p}`);
}

describe("brand kit", () => {
  it("the index lists every generated file, and every listed file exists", () => {
    const files = filesUnder(join(ROOT, "assets")).map(f => `assets/${f}`);
    expect([...listed].sort()).toEqual(files);
  });

  it("every PNG has its exact pixel size", () => {
    const pngs = listed.filter(p => p.endsWith(".png"));
    expect(pngs.length).toBeGreaterThanOrEqual(15);
    for (const p of pngs) expect([p, ...pngSize(read(p))]).toEqual([p, ...expectedSize(p)]);
  });

  it("favicon.ico holds 16, 32 and 48 px PNG entries", () => {
    const entries = icoEntries(read(brandAssets.web.faviconIco));
    expect(entries.map(e => [e.width, e.height])).toEqual([[16, 16], [32, 32], [48, 48]]);
    for (const e of entries) expect(pngSize(e.data)).toEqual([e.width, e.height]);
  });

  it("site.webmanifest uses the light page background (the default theme) for theme and background colour, never black", () => {
    const m = JSON.parse(read(brandAssets.web.manifest).toString("utf8")) as { theme_color: string; background_color: string };
    expect(m.theme_color).toBe(themes.light.bg);
    expect(m.background_color).toBe(themes.light.bg);
    expect(m.theme_color).not.toBe("#000000");
  });

  it("site.webmanifest is valid JSON and its icons exist at their declared sizes", () => {
    const manifest = JSON.parse(read(brandAssets.web.manifest).toString("utf8")) as {
      icons: { src: string; sizes: string; purpose: string }[];
    };
    expect(manifest.icons.map(i => i.purpose)).toEqual(["any", "any", "maskable"]);
    for (const icon of manifest.icons) {
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(pngSize(readFileSync(join(ROOT, "assets/web", icon.src)))).toEqual([w, h]);
    }
  });

  it("every SVG renders to an image with more than one colour", async () => {
    for (const p of listed.filter(f => f.endsWith(".svg"))) {
      const { data } = await sharp(read(p), { density: 144 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const seen = new Set<number>();
      for (let i = 0; i + 4 <= data.length; i += 4 * 7) seen.add(data.readUInt32BE(i));
      expect([p, seen.size > 1]).toEqual([p, true]); // a blank or flat render has one colour
    }
  });

  it("every mark, lockup and icon SVG carries the source mark's path data", () => {
    const d = /\sd="([^"]+)"/.exec(readFileSync(join(ROOT, "source/mark.svg"), "utf8"))?.[1];
    expect(d).toBeTruthy();
    const withMark = listed.filter(p => p.endsWith(".svg") && !p.includes("wordmark"));
    for (const p of withMark) expect([p, read(p).toString("utf8").includes(`d="${d}"`)]).toEqual([p, true]);
  });

  it("a fresh build from the source writes the same SVGs, manifest, head snippet and tokens CSS", () => {
    const out = mkdtempSync(join(ROOT, ".build-check-")); // the build only writes inside the package
    try {
      execFileSync(process.execPath, [join(ROOT, "scripts/build.ts"), out], { stdio: "pipe" });
      const text = listed.filter(p => /\.(svg|webmanifest|html|css)$/.test(p));
      for (const p of text) {
        expect([p, readFileSync(join(out, p.replace(/^assets\//, "")), "utf8")]).toEqual([p, read(p).toString("utf8")]);
      }
      expect(filesUnder(out)).toEqual(filesUnder(join(ROOT, "assets")));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  it("the stacked lockup centres the wordmark's ink under the mark (offset under 1 px at 512 px high)", async () => {
    const { data, info } = await sharp(read(brandAssets.lockupStacked.black512h)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const inkRow = (y: number): number[] => {
      const xs: number[] = [];
      for (let x = 0; x < info.width; x++) if ((data[(y * info.width + x) * 4 + 3] ?? 0) > 128) xs.push(x);
      return xs;
    };
    const rows = Array.from({ length: info.height }, (_, y) => inkRow(y));
    const firstGap = rows.findIndex((xs, y) => y > 0 && xs.length === 0 && (rows[y - 1]?.length ?? 0) > 0);
    const span = (from: number, to: number) => {
      const xs = rows.slice(from, to).flat();
      return { min: Math.min(...xs), max: Math.max(...xs) };
    };
    const mark = span(0, firstGap);
    const word = span(firstGap, info.height);
    const centre = (b: { min: number; max: number }) => (b.min + b.max + 1) / 2;
    expect(Math.abs(centre(word) - centre(mark))).toBeLessThan(1);
    expect(Math.abs(centre(word) - info.width / 2)).toBeLessThan(1);
  });

  it("the format checks reject the wrong input (negative control)", () => {
    expect(() => pngSize(Buffer.from("GIF89a-not-a-png-at-all"))).toThrow("not a PNG");
    expect(() => icoEntries(Buffer.from([0, 0, 2, 0, 1, 0]))).toThrow("not an ICO");
    expect(() => expectedSize("assets/x/no-size.png")).toThrow();
  });
});
