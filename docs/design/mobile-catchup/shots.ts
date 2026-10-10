// Screenshots of the static mockups at 390 x 844, light and dark, in Playwright's own Chromium.
// Run: node docs/design/mobile-catchup/shots.ts <output folder> [part of a file name]
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
const DIR = join(import.meta.dirname, "mockups");
const OUT = process.argv[2] ?? ".";
const only = process.argv[3];
const browser = await chromium.launch();
for (const f of readdirSync(DIR).filter(f => f.endsWith(".html") && (!only || f.includes(only))).sort()) {
  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme });
    const page = await context.newPage();
    const failed: string[] = [];
    page.on("requestfailed", r => failed.push(r.url().split("/").pop() ?? ""));
    await page.goto(pathToFileURL(join(DIR, f)).href);
    await page.evaluate(() => document.fonts.ready);
    const fonts = await page.evaluate(() => [...document.fonts].filter(x => x.status === "loaded").map(x => `${x.family} ${x.weight}`));
    const overflow = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.body.scrollHeight }));
    await page.screenshot({ path: join(OUT, `${f.replace(".html", "")}-${scheme}.png`) });
    if (scheme === "light") console.log(f, "fonts:", fonts.join(", "), "| failed:", failed.join(",") || "none", "| size:", JSON.stringify(overflow));
    await context.close();
  }
}
await browser.close();
