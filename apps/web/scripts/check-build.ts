// The production build's own checks (ADR-0008 phase G), run after `vite build` as `npm run check:build`:
//   1. The state gallery is dev-only: no trace of its code or its synthetic data is in the build.
//   2. The bundle budget: two sizes, gzipped, each grows at most 15% over the recorded baseline. The entry is what
//      200.html preloads before any route (SvelteKit's start and app, the root layout and their chunks), as the brief
//      asks; the whole client's JS covers the app's own code too, every route and view (review M1: 60 KB more in the
//      desktop view passed the entry alone).
// `npm run check:build -- --record "<why>"` writes today's sizes as the new baseline: a step taken on purpose and
// reviewed like any other change, never by CI, and refused while the gallery is in the build.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

export const GALLERY_MARKER = "morndo-gallery";           // in every gallery file's markup and data (src/lib/gallery)
export const ALLOWANCE_PERCENT = 15;
export type Baseline = { entryGzipBytes: number; allJsGzipBytes: number; recorded: string; why: string };

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const gz = (p: string) => gzipSync(readFileSync(p), { level: 9 }).length;

// Every built file that carries the gallery's marker, relative to the build.
export function galleryTraces(buildDir: string): string[] {
  return files(buildDir).filter(p => readFileSync(p).includes(GALLERY_MARKER)).map(p => relative(buildDir, p));
}

// The JS 200.html preloads, as SvelteKit writes it: <link href="/_app/…js" rel="modulepreload">.
export function entryFiles(html: string): string[] {
  return [...html.matchAll(/<link href="\/(_app\/[^"]+\.js)" rel="modulepreload">/g)].map(m => m[1] ?? "");
}

export function measure(buildDir: string): { entry: string[]; entryGzipBytes: number; allJs: number; allJsGzipBytes: number } {
  const entry = entryFiles(readFileSync(join(buildDir, "200.html"), "utf8"));
  if (!entry.length) throw new Error("200.html preloads no JS: the entry can't be measured");
  const js = files(join(buildDir, "_app")).filter(p => p.endsWith(".js"));
  return {
    entry,
    entryGzipBytes: entry.reduce((n, f) => n + gz(join(buildDir, f)), 0),
    allJs: js.length,
    allJsGzipBytes: js.reduce((n, p) => n + gz(p), 0),
  };
}

// In whole numbers, so the limit itself has no floating-point edge: exactly +15% passes.
export const overBudget = (bytes: number, baseline: number, percent = ALLOWANCE_PERCENT) => bytes * 100 > baseline * (100 + percent);
// A baseline that isn't a positive size fails too: a missing one would compare as NaN and pass.
export function verdict(bytes: number, baseline: unknown): "within" | "over" | "no_baseline" {
  if (typeof baseline !== "number" || !(baseline > 0)) return "no_baseline";
  return overBudget(bytes, baseline) ? "over" : "within";
}

if (import.meta.main) {
  const web = join(import.meta.dirname, "..");
  const build = join(web, "build"), baselineFile = join(web, "bundle-budget.json");
  let failed = false;

  const traces = galleryTraces(build);
  if (traces.length) { failed = true; console.error(`FAIL  the dev-only gallery is in the production build: ${traces.join(", ")}`); }
  else console.log("PASS  no trace of the dev-only gallery in the production build");

  const m = measure(build);
  const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;
  if (process.argv.includes("--record")) {
    const why = process.argv[process.argv.indexOf("--record") + 1] ?? "";
    if (!why || why.startsWith("--")) { console.error("usage: check-build.ts --record \"<why the sizes changed>\""); process.exit(2); }
    if (failed) { console.error("not recorded: the build has to pass its other checks first"); process.exit(1); }
    const b: Baseline = { entryGzipBytes: m.entryGzipBytes, allJsGzipBytes: m.allJsGzipBytes, recorded: new Date().toISOString().slice(0, 10), why };
    writeFileSync(baselineFile, `${JSON.stringify(b, null, 2)}\n`);
    console.log(`recorded the baseline: entry JS ${kb(m.entryGzipBytes)} (${m.entry.length} files), all client JS ${kb(m.allJsGzipBytes)} (${m.allJs} files), gzipped`);
  } else {
    const b = JSON.parse(readFileSync(baselineFile, "utf8")) as Baseline;
    const budget = (what: string, bytes: number, baseline: unknown) => {
      const v = verdict(bytes, baseline);
      if (v === "no_baseline" || typeof baseline !== "number") { failed = true; console.error(`FAIL  ${what}: no baseline in bundle-budget.json; record one`); return; }
      const pct = (bytes / baseline - 1) * 100;
      const growth = `${pct >= 0.05 ? "+" : pct <= -0.05 ? "-" : ""}${Math.abs(pct).toFixed(1)}`;
      const line = `${what} ${kb(bytes)} gzipped, ${growth}% against the baseline ${kb(baseline)} of ${b.recorded}; at most +${ALLOWANCE_PERCENT}%`;
      if (v === "over") { failed = true; console.error(`FAIL  ${line}`); }
      else console.log(`PASS  ${line}`);
    };
    budget(`entry JS (${m.entry.length} files)`, m.entryGzipBytes, b.entryGzipBytes);
    budget(`all client JS (${m.allJs} files)`, m.allJsGzipBytes, b.allJsGzipBytes);
  }
  process.exit(failed ? 1 : 0);
}
