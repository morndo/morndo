// The tests-only override of N2's worker-ask grace (MORNDO_WORKER_ASK_GRACE_MS, config.ts): an office with a 3-second
// grace does not list a worker's menu on /api/escalations before the grace has passed, and lists it as an open worker's
// ask after it. On a synthetic office with its own hub and tmux server, in Playwright's own Chromium. Nothing here reads
// or touches the real lanes, the real hub or its data. Run: npm run build && node e2e/worker-grace.e2e.ts
import { chromium } from "playwright";
import { assert, checks, outDir, pairedPage, startOffice } from "./harness.ts";

const OUT = outDir("worker-grace");
const office = await startOffice("grace", { MORNDO_WORKER_ASK_GRACE_MS: "3000", MORNDO_POLL_MS: "500" });
const { tmux, office: o } = office;
const { panes } = o;
const { check, watch, finish } = checks(OUT);
const browser = await chromium.launch();
let code = 1;

const until = async (cond: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise(r => setTimeout(r, 150)); }
  if (!(await cond())) throw new Error(`timed out: ${what}`);
};

try {
  // A desktop-sized page is enough: the check reads /api/escalations, not the phone's catch-up.
  const { page, errors } = await pairedPage(browser, office);
  watch(page);

  await check("a worker's menu is not listed before the grace and is listed after it", async () => {
    // A menu on builder's screen (as Claude Code draws a permission prompt), and the command still running under it.
    tmux("send-keys", "-t", panes.builder ?? "", "printf 'Do you want to proceed?\\n> 1. Yes\\n  2. No\\nEsc to cancel\\n'; sleep 600", "Enter");
    await page.waitForTimeout(1500);                     // the menu is at most about 2 s old; the grace is 3 s
    const early = await page.evaluate(() => fetch("/api/escalations").then(r => r.json()).then((b: { items: { id: string }[] }) => b.items.filter(i => i.id.startsWith("menu-")).map(i => i.id)));
    assert(early.length === 0, `the menu was listed before the grace: ${JSON.stringify(early)}`);
    let menu: { id: string; status: string; asker?: { kind?: string } } | null = null;
    await until(async () => {
      menu = await page.evaluate(() => fetch("/api/escalations").then(r => r.json()).then((b: { items: { id: string; status: string; asker?: { kind?: string } }[] }) => b.items.find(i => i.id.startsWith("menu-") && i.status === "open") ?? null));
      return menu !== null;
    }, 15_000, "the hub lists builder's menu once the grace has passed");
    assert(!menu!.asker || menu!.asker.kind === "worker", `the menu's asker is ${JSON.stringify(menu!.asker)}`);
    tmux("send-keys", "-t", panes.builder ?? "", "C-c", "");   // the command under the menu is still running
  });

  code = finish();
  if (errors.length) { console.log(`page errors: ${errors.join(" | ")}`); code = 1; }
} finally {
  await browser.close();
  office.stop();
}
process.exit(code);
