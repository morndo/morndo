// End-to-end check of ADR-0015 (the board) on a synthetic office with its own hub, in Playwright's Chromium, with the
// real `morndo-board` CLI as the manager and as a lane (agent tokens minted by the hub's console), and the principal on
// the desktop: the Board tab, the channel's "working on" chip, drag and drop between columns (a drop on Blocked asks
// why), accepting a lane's review, filing a task and commenting from the app. Every change made on one side is read
// back on the other. Run: npm run build && node e2e/board.e2e.ts
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { HUB_MAIN, assert, checks, outDir, pairedPage, startOffice } from "./harness.ts";

const OUT = outDir("board");
const CLI = join(import.meta.dirname, "../apps/board-cli/src/main.ts");
const { check, watch, finish } = checks(OUT);
let code = 1;
let office: Awaited<ReturnType<typeof startOffice>> | null = null;
const browser = await chromium.launch();

// A token from the hub's console: the first line is the secret, shown once.
const mint = (env: NodeJS.ProcessEnv, name: string, role: "manager" | "worker") =>
  execFileSync(process.execPath, ["--no-warnings", HUB_MAIN, "agent-token", "new", name, "--role", role], { env, encoding: "utf8" }).split("\n")[0]?.trim() ?? "";
// The CLI as someone: its output, or its stderr and exit code on a refusal.
const cliAs = (env: NodeJS.ProcessEnv) => (...args: string[]) => {
  try { return { code: 0, out: execFileSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd() }; }
  catch (e) { const x = e as { status: number; stderr: string }; return { code: x.status, out: String(x.stderr).trim() }; }
};
const column = (page: Page, status: string) => page.locator(`[data-column="${status}"]`);
const cardOf = (page: Page, key: string) => page.locator(`[data-task="${key}"]`);

try {
  office = await startOffice("board");
  const managerSecret = mint(office.env, "manager", "manager");
  const workerSecret = mint(office.env, "lanes", "worker");
  assert(managerSecret.startsWith("mat_") && workerSecret.startsWith("mat_"), "the console didn't print the tokens");
  const base = { ...process.env, MORNDO_HUB: office.base };
  const manager = cliAs({ ...base, MORNDO_AGENT_TOKEN: managerSecret });
  const builder = cliAs({ ...base, MORNDO_AGENT_TOKEN: workerSecret, MORNDO_LANE: "builder" });
  const reviewer = cliAs({ ...base, MORNDO_AGENT_TOKEN: workerSecret, MORNDO_LANE: "reviewer" });

  const paired = await pairedPage(browser, office);
  const { page } = paired;
  watch(page);

  await check("the manager files tasks and hands them out; a lane starts one; the Board tab shows each in its column", async () => {
    assert(manager("new", "Build the login page", "--desc", "Form plus tests; 14 of 14 pass", "--assign", "builder", "--priority", "high").code === 0, "new failed");
    assert(manager("new", "Review change 12", "--assign", "reviewer").code === 0, "new failed");
    assert(manager("new", "Write the release notes").code === 0, "new failed");
    assert(builder("start", "T-1").code === 0, "start failed");
    await page.locator(".rail").getByRole("button", { name: "Board" }).click();
    await page.getByRole("heading", { name: "Board", level: 1 }).waitFor({ timeout: 10_000 });
    // The columns are 340px (Linear's): beside the open Decisions panel three show and the rest scroll. A real drag
    // scrolls the board under the pointer (BoardView, edgeScroll); Playwright's emulated drag doesn't, so the panel is
    // closed here (remembered on this device) and Backlog to Blocked are on screen for the drags below.
    await page.getByRole("complementary", { name: "Decisions" }).getByRole("button", { name: "Close the right panel" }).click();
    await column(page, "doing").locator('[data-task="T-1"]').waitFor({ timeout: 8000 });
    await column(page, "todo").locator('[data-task="T-2"]').waitFor();
    await column(page, "backlog").locator('[data-task="T-3"]').waitFor();
    assert((await cardOf(page, "T-1").innerText()).includes("builder"), "T-1 doesn't show its lane");
    await page.screenshot({ path: join(OUT, "1-board.png") });
  });

  await check("a card held at the board's right edge scrolls the columns past the window (BoardView edgeScroll)", async () => {
    // What the browser does in a real drag, by hand: dragstart on the card, then dragover near the edge, a few times
    // 50 ms apart as it fires while the pointer rests. Six columns at 340px overflow the 1920px window.
    const moved = await page.evaluate(() => new Promise<number>(res => {
      const cols = document.querySelector<HTMLElement>(".cols")!, card = document.querySelector<HTMLElement>('[data-task="T-1"]')!;
      cols.scrollLeft = 0;
      card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() }));
      const r = cols.getBoundingClientRect();
      let n = 0;
      const tick = () => {
        cols.dispatchEvent(new DragEvent("dragover", { bubbles: true, clientX: r.right - 20, clientY: r.top + 40, dataTransfer: new DataTransfer() }));
        if (++n < 6) { setTimeout(tick, 50); return; }
        card.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
        const left = cols.scrollLeft;
        cols.scrollLeft = 0;
        res(left);
      };
      tick();
    }));
    assert(moved > 0, `the board didn't scroll: scrollLeft stayed ${moved}`);
  });

  await check("the lane's channel shows what it is working on, and the chip opens the task on the board", async () => {
    await page.locator("aside.side").getByRole("button", { name: /builder/ }).click();
    const chip = page.getByRole("button", { name: /Working on T-1/ });
    await chip.waitFor({ timeout: 8000 });
    assert((await chip.innerText()).includes("Build the login page"), "the chip doesn't name the task");
    await page.screenshot({ path: join(OUT, "2-channel-chip.png") });
    await chip.click();
    await page.locator('[data-task-panel="T-1"]').waitFor({ timeout: 5000 });
    await page.locator('[data-task-panel="T-1"]').getByText("Form plus tests; 14 of 14 pass").waitFor();
    await page.locator('[data-task-panel="T-1"]').getByText("builder moved it from To do to In progress").waitFor({ timeout: 5000 });
    await page.screenshot({ path: join(OUT, "3-task-panel.png") });
    await page.getByRole("button", { name: "Close the task" }).click();
  });

  await check("dragging a card to In progress moves it on the hub, as the principal; the lane reads it back", async () => {
    await cardOf(page, "T-2").dragTo(column(page, "doing"));
    await column(page, "doing").locator('[data-task="T-2"]').waitFor({ timeout: 8000 });
    const shown = reviewer("show", "T-2");
    assert(shown.code === 0 && shown.out.includes("In progress") && shown.out.includes("principal    todo → doing"), `the lane reads: ${shown.out}`);
  });

  await check("a drop on Blocked asks why first; the reason reaches the board, and the rail counts it", async () => {
    await cardOf(page, "T-3").dragTo(column(page, "blocked"));
    const panel = page.locator('[data-task-panel="T-3"]');
    await panel.getByLabel("Why is it blocked?").waitFor({ timeout: 5000 });
    await panel.getByLabel("Why is it blocked?").fill("needs the changelog from the manager");
    await panel.getByRole("button", { name: "Mark blocked" }).click();
    await column(page, "blocked").locator('[data-task="T-3"]').waitFor({ timeout: 8000 });
    await cardOf(page, "T-3").getByText("needs the changelog from the manager").waitFor();
    const badge = await page.locator(".rail").getByRole("button", { name: "Board" }).locator(".badge").innerText();
    assert(badge.trim() === "1", `the rail's badge reads ${badge}`);
    const list = manager("list", "--status", "blocked");
    assert(list.out.includes("[blocked: needs the changelog from the manager]"), `the manager reads: ${list.out}`);
    await page.getByRole("button", { name: "Close the task" }).click();
  });

  await check("a lane offers its task for review; the principal accepts it as done; the lane can't do that itself", async () => {
    assert(builder("review", "T-1", "--note", "npm test: 14 passed").code === 0, "review failed");
    await column(page, "review").locator('[data-task="T-1"]').waitFor({ timeout: 8000 });
    const refused = builder("done", "T-1");
    assert(refused.code === 1 && refused.out.startsWith("refused:"), `a lane marked done: ${refused.out}`);
    await cardOf(page, "T-1").click();
    const panel = page.locator('[data-task-panel="T-1"]');
    await panel.getByText("npm test: 14 passed").waitFor({ timeout: 5000 });
    await panel.getByRole("button", { name: "Accept as done" }).click();
    await column(page, "done").locator('[data-task="T-1"]').waitFor({ timeout: 8000 });
    const shown = manager("show", "T-1");
    assert(shown.out.includes("Done this week") && shown.out.includes("principal    review → done"), `the manager reads: ${shown.out}`);
    await page.screenshot({ path: join(OUT, "4-accepted.png") });
    await page.getByRole("button", { name: "Close the task" }).click();
  });

  await check("the principal files a task from the board and comments on it; the lane lists and reads both", async () => {
    await page.getByRole("button", { name: "New task" }).click();
    await page.getByLabel("Title").fill("Ship the login page");
    await page.getByLabel("Description").fill("After the reviewer's OK");
    await page.getByRole("button", { name: "Assign to" }).click();
    await page.getByRole("option", { name: /^builder/ }).click();
    await page.getByRole("button", { name: "File it" }).click();
    await column(page, "todo").locator('[data-task="T-4"]').waitFor({ timeout: 8000 });
    await cardOf(page, "T-4").click();
    const panel = page.locator('[data-task-panel="T-4"]');
    await panel.getByLabel("Comment", { exact: true }).fill("Tonight, after the reviewer's OK.");
    await panel.getByRole("button", { name: "Send the comment" }).click();
    await panel.getByText("Tonight, after the reviewer's OK.").waitFor({ timeout: 5000 });
    const mine = builder("list", "--mine");
    assert(mine.out.includes("T-4    builder        Ship the login page  1 comment"), `the lane lists: ${mine.out}`);
    const shown = builder("show", "T-4");
    assert(shown.out.includes("principal    commented: Tonight, after the reviewer's OK."), `the lane reads: ${shown.out}`);
    await page.getByRole("button", { name: "Close the task" }).click();
  });

  await check("a refused drop says why on the task it opens, and a draft survives the board changing under it (review round)", async () => {
    assert(manager("new", "Nobody's yet").code === 0, "new failed");
    await column(page, "backlog").locator('[data-task="T-5"]').waitFor({ timeout: 8000 });
    await cardOf(page, "T-5").dragTo(column(page, "doing"));
    const panel = page.locator('[data-task-panel="T-5"]');
    await panel.getByRole("alert").waitFor({ timeout: 5000 });
    assert((await panel.getByRole("alert").innerText()).includes("Assign it to a lane first"), "the refused drop didn't say why");
    assert(await column(page, "backlog").locator('[data-task="T-5"]').count() === 1, "the card left its column");
    assert((await panel.getByRole("button", { name: "Status" }).innerText()).includes("Backlog"), "the status picker kept the refused pick");
    await panel.getByLabel("Comment", { exact: true }).fill("a draft, not sent");
    assert(reviewer("comment", "T-2", "the board changed under the open panel").code === 0, "comment failed");
    await cardOf(page, "T-2").locator(".n", { hasText: "1" }).waitFor({ timeout: 8000 });   // the frame landed: 1 comment
    assert(await panel.getByLabel("Comment", { exact: true }).inputValue() === "a draft, not sent", "the draft was wiped by the board frame");
    await page.getByRole("button", { name: "Close the task" }).click();
  });

  await check("the board survives a hub restart (the tasks and their record are on disk), with no console errors", async () => {
    await office!.restartHub();
    paired.errors.length = 0;                      // the reconnects refused while the hub was down are expected
    await page.reload();
    await page.locator(".desk").waitFor({ timeout: 15_000 });
    await page.locator(".rail").getByRole("button", { name: "Board" }).click();
    await column(page, "done").locator('[data-task="T-1"]').waitFor({ timeout: 15_000 });
    await column(page, "blocked").locator('[data-task="T-3"]').waitFor();
    assert(paired.errors.length === 0, `console errors: ${paired.errors.join(" | ")}`);
  });

  await check("the board reads in the dark theme", async () => {
    // The brand's tokens take data-theme on <html> too (tokens.css; ink.e2e.ts checks it), so the dark theme is set on
    // the document as well as asked of the browser: a browser build whose scheme emulation doesn't take still renders it.
    const dark = await pairedPage(browser, office, { colorScheme: "dark" });
    try {
      await dark.page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await dark.page.locator(".rail").getByRole("button", { name: "Board" }).click();
      await column(dark.page, "done").locator('[data-task="T-1"]').waitFor({ timeout: 10_000 });
      await cardOf(dark.page, "T-3").click();
      await dark.page.locator('[data-task-panel="T-3"]').waitFor();
      await dark.page.screenshot({ path: join(OUT, "5-board-dark.png") });
      assert(dark.errors.length === 0, `console errors: ${dark.errors.join(" | ")}`);
    } finally { await dark.context.close(); }
  });

  code = finish();
} catch (e) {
  console.log(`FAIL  setup: ${(e as Error).message}`);
} finally {
  await browser.close();
  office?.stop();
  process.exit(code);
}
