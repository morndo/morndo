// The dev-only state gallery (ADR-0008 phase G), screenshotted for QA in both themes: Vite's dev server on its own
// port, no hub at all (any /api request is refused and fails the run). Run: node e2e/gallery.e2e.ts
// That the gallery is absent from a production build is the build's own check (apps/web/scripts/check-build.ts).
import { spawn } from "node:child_process";
import { join } from "node:path";
import { chromium } from "playwright";
import { assert, checks, freePort, outDir } from "./harness.ts";

const OUT = outDir("gallery");
const WEB = join(import.meta.dirname, "../apps/web");
const port = await freePort();
const vite = spawn(process.execPath, [join(WEB, "../../node_modules/vite/bin/vite.js"), "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: WEB, stdio: ["ignore", "pipe", "pipe"] });
const base = `http://127.0.0.1:${port}`;
// Ready when it answers, not when its banner says so: with CI set, Vite colours the port inside the URL it prints.
let said = "";
vite.stdout.on("data", (d: Buffer) => { said += String(d); });
vite.stderr.on("data", (d: Buffer) => { said += String(d); });
const viteState: { exited: number | null } = { exited: null };            // set from a callback, so not narrowed away
vite.once("exit", c => { viteState.exited = c ?? -1; });
for (const end = Date.now() + 60_000; ; await new Promise(r => setTimeout(r, 250))) {
  if (viteState.exited !== null) throw new Error(`vite dev exited ${viteState.exited}: ${said.slice(-400)}`);
  if (Date.now() > end) { vite.kill("SIGTERM"); throw new Error(`vite dev didn't answer in 60 s: ${said.slice(-400)}`); }
  if (await fetch(`${base}/gallery`).then(r => r.ok, () => false)) break;
}

const { check, watch, finish } = checks(OUT);
const browser = await chromium.launch();
let code = 1;
const SENDS = ["Queued", "Waiting to send…", "Sending…", "Sent", "Sent, not seen in the conversation yet", "Not sent", "May have been sent", "Waiting for the message above"];
const PILLS = ["Connecting", "Live", "Reconnecting", "Offline", "Signed out"];
try {
  const backgrounds: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    watch(page);
    const errors: string[] = [], hubCalls: string[] = [];
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/api/**", r => { hubCalls.push(r.request().url()); return r.abort(); });   // never the box's hub

    await check(`${theme}: every section renders its states from synthetic data, with no hub`, async () => {
      await page.goto(`${base}/gallery?theme=${theme}`);
      await page.getByRole("heading", { name: "State gallery" }).waitFor({ timeout: 60_000 });
      assert(await page.evaluate(() => document.documentElement.dataset.theme) === theme, "the theme wasn't applied");
      const pills = page.locator('[data-shot="pills"]');
      for (const p of PILLS) assert(await pills.getByRole("status").filter({ hasText: new RegExp(`^${p}$`) }).count() === 1, `no "${p}" pill`);
      const sends = page.locator('[data-shot="sends"] article[data-state]');
      const labels = await sends.locator(".who time").allInnerTexts();
      for (const s of SENDS) assert(labels.includes(s), `no send labelled "${s}": ${JSON.stringify(labels)}`);
      assert(new Set(await sends.evaluateAll(a => a.map(x => x.getAttribute("data-state")))).size === 5, "not all five send states");
      // Every row on screen in its pane, so the screenshot shows each state (none scrolled away above).
      const hidden = await sends.evaluateAll(a => a.filter(x => {
        const pane = x.closest(".pane")?.getBoundingClientRect(), r = x.getBoundingClientRect();
        return !pane || r.top < pane.top || r.bottom > pane.bottom;
      }).length);
      assert(hidden === 0, `${hidden} send rows scrolled out of view`);
      const divider = page.locator('[data-shot="divider"]');
      await divider.getByRole("separator", { name: "New messages" }).waitFor();
      await divider.getByRole("button", { name: "Jump to the latest: 3 new" }).waitFor();
      // Each sidebar row in its state, by the classes and badge the app styles (review L2).
      const side = page.locator('[data-shot="sidebar"]');
      const row = (name: string) => side.locator("button.row").filter({ has: page.getByText(name, { exact: true }) });
      const cls = async (name: string) => ` ${(await row(name).getAttribute("class")) ?? ""} `;
      assert((await cls("billing")).includes(" unread ") && await row("billing").locator(".badge", { hasText: "!" }).count() === 1, "billing isn't unread with the needs-you badge");
      assert((await cls("onboarding")).includes(" unread "), "onboarding isn't unread");
      assert((await cls("newsletter")).includes(" muted "), "newsletter isn't muted");
      assert((await cls("search")).includes(" sel "), "search isn't selected");
      assert(!/ (unread|muted|sel) /.test(await cls("api-docs")), `api-docs isn't plain: ${await cls("api-docs")}`);
      const starred = side.getByRole("button", { name: /^Starred/ });
      assert(await starred.count() === 1 && await row("release").count() === 1, `no Starred section with release: ${await starred.count()} headers, ${await row("release").count()} rows`);
      // Each decision card in its state (review L2).
      assert(await page.locator('[data-shot="decisions"] figure').count() === 12, "not 12 decision cards");
      const card = (caption: string) => page.locator('[data-shot="decisions"] figure').filter({ has: page.locator("figcaption", { hasText: caption }) }).locator("article.dc");
      for (const [caption, u] of [["Blocking", "blocking"], ["Overdue", "overdue"], ["Due soon", "soon"], ["Normal, asked again", "normal"], ["Answered here", "answered"], ["Settled", "done"]] as const) {
        assert((await card(caption).getAttribute("class"))?.split(" ").includes(`u-${u}`), `"${caption}" isn't u-${u}`);
      }
      await card("Answers paused").getByText("answers are paused").waitFor();
      await card("A worker's question").getByRole("button", { name: "Answer in #billing's terminal" }).waitFor();
      await card("Answered in words").getByRole("button", { name: "Answer…" }).waitFor();
      await card("Answered here").getByText("You chose").waitFor();
      await card("Settled").getByText("Decided:").waitFor();
      // Answering, by clicking as a person would (review L3): the confirmation, words, sending, refused.
      const answering = (i: number) => page.locator(`[data-answering="${i}"]`);
      const ship = (i: number) => answering(i).getByRole("button", { name: "Ship Friday", exact: true });
      await ship(0).click();
      await answering(0).getByRole("group", { name: "Confirm your answer" }).waitFor();
      await answering(1).getByRole("button", { name: "Something else…" }).click();
      await answering(1).getByRole("textbox", { name: "Your answer for the manager" }).waitFor();
      await ship(2).click();
      await answering(2).getByRole("button", { name: "Send answer" }).click();
      await answering(2).getByRole("button", { name: "Sending…" }).waitFor();
      await ship(3).click();
      await answering(3).getByRole("button", { name: "Send answer" }).click();
      await answering(3).getByRole("alert").filter({ hasText: "Try again in a few seconds" }).waitFor();
      backgrounds.push(await page.locator(".gallery").evaluate(el => getComputedStyle(el).backgroundColor));
      await page.screenshot({ path: join(OUT, `g-${theme}-full.png`), fullPage: true });
      for (const s of ["pills", "sidebar", "sends", "divider", "decisions", "answering"]) await page.locator(`[data-shot="${s}"]`).screenshot({ path: join(OUT, `g-${theme}-${s}.png`) });
    });
    await check(`${theme}: no console errors, and no request to a hub`, async () => {
      assert(errors.length === 0, `console errors: ${errors.join(" | ").slice(0, 400)}`);
      assert(hubCalls.length === 0, `requests to /api: ${hubCalls.join(", ")}`);
    });
    await context.close();
  }
  await check("the two themes really differ", async () => {
    assert(backgrounds.length === 2 && backgrounds[0] !== backgrounds[1], `backgrounds ${JSON.stringify(backgrounds)}`);
  });
  code = finish();
} finally {
  await browser.close();
  vite.kill("SIGTERM");
}
process.exit(code);
