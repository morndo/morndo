// Screenshots of the board (ADR-0015) for a QA record, before and after a change: the six columns with a card in every
// state, a task open beside it, the lane filter open, the dialog to file a task, at 1920 x 1000, light and dark, on a
// synthetic office with its own hub and the real `morndo-board` CLI as the manager and the lanes. Not a check
// (board.e2e.ts is). Pass a folder; this repo does not keep the shots.
// Run: npm run build && node e2e/board-shots.ts <output folder>
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { HUB_MAIN, pairedPage, startOffice } from "./harness.ts";

const OUT = process.argv[2];
if (!OUT) { console.error("usage: node e2e/board-shots.ts <output folder>"); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const CLI = join(import.meta.dirname, "../apps/board-cli/src/main.ts");

const office = await startOffice("board-shots");
const mint = (name: string, role: "manager" | "worker") =>
  execFileSync(process.execPath, ["--no-warnings", HUB_MAIN, "agent-token", "new", name, "--role", role], { env: office.env, encoding: "utf8" }).split("\n")[0]?.trim() ?? "";
const cliAs = (env: NodeJS.ProcessEnv) => (...args: string[]) =>
  execFileSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
const base = { ...process.env, MORNDO_HUB: office.base };
const manager = cliAs({ ...base, MORNDO_AGENT_TOKEN: mint("manager", "manager") });
const worker = mint("lanes", "worker");
const builder = cliAs({ ...base, MORNDO_AGENT_TOKEN: worker, MORNDO_LANE: "builder" });
const reviewer = cliAs({ ...base, MORNDO_AGENT_TOKEN: worker, MORNDO_LANE: "reviewer" });

const browser = await chromium.launch();
const shots: string[] = [];
async function shot(page: Page, name: string) {
  await page.mouse.move(0, 0);
  for (const scheme of ["light", "dark"] as const) {
    // The tokens take data-theme on <html> as well as the scheme (tokens.css), so a browser whose scheme emulation
    // doesn't take still renders the dark theme.
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(s => { document.documentElement.dataset.theme = s; }, scheme);
    await page.waitForTimeout(200);
    const file = join(OUT, `${name}-${scheme}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
}

try {
  // A board with something in every column: the manager files and hands out, the lanes move their own, one is accepted.
  // T-1..T-3: Done, In review and In progress for builder; T-4..T-6: the same for reviewer, with a block in between.
  // Inside the try, so a refused seed (a lane with a task already in progress, say) still stops the office.
  manager("new", "Public docs for Lumenfield Notes: point the footer at /docs", "--desc", "The new docs route serves the markdown from the repo; the footer and the 404 page point at it. Done means: every link on the footer answers 200 in the e2e.", "--assign", "builder");
  manager("new", "Signed-in error on /account: the layout loads the profile twice", "--desc", "The layout's load runs on the server and again on the client with a stale cookie. Done means: the e2e signs in and opens the page without a 500.", "--assign", "builder", "--priority", "high");
  manager("new", "Cache headers for the Lumenfield blog: one redirect, one canonical, cache back", "--desc", "Three findings from the crawl. Done means: the crawl reports zero duplicates and the blog's cache header is back.", "--assign", "builder");
  builder("start", "T-1"); builder("review", "T-1", "--note", "Footer links: 12 of 12 answer 200 in the e2e."); manager("done", "T-1");
  builder("start", "T-2"); builder("review", "T-2", "--note", "Signed in, opened the page, no 500; the e2e covers it.");
  builder("start", "T-3");
  manager("comment", "T-3", "The canonical fix touches the blog layout too; keep it in one change.");
  builder("comment", "T-3", "On it. The redirect is in; the cache header is next.");
  manager("new", "Rotate the sample API token in the docs and drop it from the old commit", "--desc", "Done means: the old token is revoked, the new one lives in the secret store, and the history no longer holds it.", "--assign", "reviewer", "--priority", "high");
  manager("new", "Review the checkout notes: twenty findings, pick which ship this week", "--assign", "reviewer");
  manager("new", "Marketing page logo is missing from the asset folder", "--assign", "reviewer", "--priority", "low");
  reviewer("start", "T-4"); reviewer("block", "T-4", "--why", "needs the replacement token from the password manager");
  reviewer("start", "T-5"); reviewer("review", "T-5", "--note", "Six ship this week, the rest are filed as follow-ups.");
  reviewer("start", "T-6");
  manager("new", "Move Lumenfield Notes onto one Postgres and retire the second database", "--desc", "Target: one Postgres, the app servers as clients.", "--assign", "builder", "--priority", "high");
  manager("new", "Nightly import of the sample metrics series", "--assign", "docs", "--priority", "low");
  manager("new", "Marketing loops for Lumenfield: a short playbook and the first three", "--assign", "reviewer");
  manager("new", "Stop the edge from caching 404s for static assets", "--desc", "Done means: a 404 for a static asset carries no-store at the edge, and the bad copy is gone from every cache.", "--priority", "high");
  manager("new", "Signed-in /account is rewritten to the logged-out page", "--priority", "high");
  manager("new", "The sale badge shows the list price, not the discounted price");
  manager("new", "Reports page for Lumenfield Notes: finish the summary row");
  manager("comment", "T-10", "Nobody's yet; the cache-header fix comes first.");

  const { page, context, errors } = await pairedPage(browser, office, { width: 1920, height: 1000 });
  // The Decisions panel opens beside every view by default; closed here so the board has the width it has on a
  // desktop where the owner closed it once (the choice is remembered per device).
  await page.getByRole("complementary", { name: "Decisions" }).getByRole("button", { name: /Close/ }).click();
  await page.locator(".rail").getByRole("button", { name: "Board" }).click();
  await page.locator('[data-column="done"] [data-task="T-1"]').waitFor({ timeout: 10_000 });
  await page.locator('[data-column="blocked"] [data-task="T-4"]').waitFor();
  await shot(page, "1-board");

  await page.locator('[data-task="T-3"]').click();
  await page.locator('[data-task-panel="T-3"]').getByText("On it. The redirect is in; the cache header is next.").waitFor({ timeout: 10_000 });
  await shot(page, "2-task-open");
  await page.getByRole("button", { name: "Close the task" }).click();

  await page.getByRole("button", { name: "Show tasks of" }).click();
  await page.getByRole("listbox", { name: "Show tasks of" }).waitFor();
  await shot(page, "3-lane-filter-open");
  await page.keyboard.press("Escape");

  // Filing a task: the dialog over the board (NewTaskModal), then its lane pill open.
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByRole("dialog", { name: "New task" }).waitFor();
  await page.getByLabel("Title", { exact: true }).fill("Ship the login page");
  await page.getByLabel("Description", { exact: true }).fill("After the reviewer's OK: the e2e signs in and lands on the dashboard.");
  await page.mouse.move(0, 0);
  await shot(page, "4-new-task-modal");
  await page.getByRole("button", { name: "Assign to" }).click();
  await page.getByRole("listbox", { name: "Assign to" }).waitFor();
  await shot(page, "5-new-task-assign-open");
  await page.keyboard.press("Escape");
  // Closing with a typed draft asks first.
  await page.getByRole("button", { name: "Close the form" }).click();
  await page.getByRole("button", { name: "Discard" }).waitFor();
  await shot(page, "6-new-task-discard-ask");
  await page.getByRole("button", { name: "Discard" }).click();
  await page.getByRole("dialog", { name: "New task" }).waitFor({ state: "detached" });

  // The card under the pointer, as the Ink rules draw it.
  await page.locator('[data-task="T-2"]').hover();
  await page.waitForTimeout(250);
  await shot(page, "7-card-hover");

  await context.close();
  console.log(shots.join("\n"));
  if (errors.length) console.log(`console errors:\n${errors.join("\n")}`);
} finally {
  await browser.close();
  office.stop();
}
