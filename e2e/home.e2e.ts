// End-to-end check of ADR-0016 (Home: usage across accounts) on a synthetic office with its own hub, in Playwright's
// Chromium: the desktop opens on Home, which says no account reports yet; sessions post their status-line JSON under
// a worker token for two accounts; Home shows the KPI row, a card per account with its meters in words and a reset
// time, the critical account's warning, the sessions on each account, and the Chats tab still leads to the agents.
// Run: npm run build && node e2e/home.e2e.ts
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { chromium } from "playwright";
import { HUB_MAIN, assert, checks, outDir, pairedPage, startOffice } from "./harness.ts";

const OUT = outDir("home");
const { check, watch, finish } = checks(OUT);
let code = 1;
let office: Awaited<ReturnType<typeof startOffice>> | null = null;
const browser = await chromium.launch();
const HOUR = 3_600_000;

const mint = (env: NodeJS.ProcessEnv) =>
  execFileSync(process.execPath, ["--no-warnings", HUB_MAIN, "agent-token", "new", "lanes", "--role", "worker"], { env, encoding: "utf8" }).split("\n")[0]?.trim() ?? "";
// A status line's JSON as Claude Code gives it (resets_at in epoch seconds), posted as a lane's status line would.
const statusLine = (session: string, five: number | null, week: number | null, ctx: number) => ({
  cwd: "/w", session_id: session, model: { id: "claude-opus-5-5", display_name: "Opus" }, version: "2.1.295", context_window: { used_percentage: ctx },
  ...(five === null && week === null ? {} : { rate_limits: {
    ...(five === null ? {} : { five_hour: { used_percentage: five, resets_at: Math.floor((Date.now() + 2 * HOUR + 10 * 60_000) / 1000) } }),
    ...(week === null ? {} : { seven_day: { used_percentage: week, resets_at: Math.floor((Date.now() + 3 * 24 * HOUR) / 1000) } }),
  } }),
});

try {
  office = await startOffice("home");
  const token = mint(office.env);
  assert(token.startsWith("mat_"), "the console didn't print the token");
  const post = (account: string, lane: string, body: unknown) => fetch(`${office!.base}/api/agent/usage`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-morndo-lane": lane, "x-morndo-account": account }, body: JSON.stringify(body),
  });

  const paired = await pairedPage(browser, office);
  const { page } = paired;
  watch(page);

  await check("the desktop opens on Home, which says no account reports yet and how to make them", async () => {
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor({ timeout: 10_000 });
    await page.getByText("No account reports yet").waitFor();
    await page.getByText("docs/agents/usage.md").waitFor();
    assert(/\bon\b/.test((await page.locator(".rail .tab", { hasText: "Home" }).getAttribute("class")) ?? ""), "the rail doesn't mark Home");
    await page.screenshot({ path: join(OUT, "1-home-empty.png") });
  });

  await check("sessions post their status lines; Home shows a card per account with its meters, in words, live", async () => {
    assert((await post("max-1", "builder", statusLine("s-builder", 23.5, 41.2, 8))).status === 200, "post failed");
    assert((await post("max-1", "reviewer", statusLine("s-reviewer", 23.5, 41.2, 37))).status === 200, "post failed");
    assert((await post("max-2", "worker-01", statusLine("s-w1", 92, 70, 12))).status === 200, "post failed");
    const one = page.locator('[data-account="max-1"]');
    await one.waitFor({ timeout: 8000 });
    await one.getByRole("group", { name: "5-hour window: 24% used, Fine" }).waitFor();
    await one.getByRole("group", { name: "Weekly window: 41% used, Fine" }).waitFor();
    assert((await one.innerText()).includes("resets in 2 h"), "the 5-hour reset isn't said");
    assert((await one.innerText()).includes("2 sessions reporting"), "the sessions aren't counted");
    await one.getByRole("button", { name: /#reviewer/ }).waitFor();
    assert((await one.getByRole("button", { name: /#reviewer/ }).innerText()).includes("37% context"), "the session's context isn't shown");
    const two = page.locator('[data-account="max-2"]');
    await two.getByRole("group", { name: "5-hour window: 92% used, Nearly out" }).waitFor();
    await two.getByRole("group", { name: "Weekly window: 70% used, Fine" }).waitFor();
    await page.screenshot({ path: join(OUT, "2-home-accounts.png") });
  });

  await check("the KPI row: accounts, sessions, and the tightest windows name their account; the headline warns", async () => {
    const kpis = page.getByLabel("Usage at a glance");
    const text = await kpis.innerText();
    assert(/Accounts\n2/.test(text), `accounts tile: ${text}`);
    assert(/Sessions reporting\n3/.test(text), `sessions tile: ${text}`);
    assert(/Tightest 5-hour window\n92%\nmax-2/.test(text), `5-hour tile: ${text}`);
    assert(/Tightest weekly window\n70%\nmax-2/.test(text), `weekly tile: ${text}`);
    await page.getByRole("status").filter({ hasText: "nearly out of its window" }).waitFor();
  });

  await check("a report without windows never clears an account's windows; a new window moves its meter", async () => {
    assert((await post("max-1", "builder", statusLine("s-builder-2", null, null, 1))).status === 200, "post failed");
    await new Promise(r => setTimeout(r, 500));
    await page.locator('[data-account="max-1"]').getByRole("group", { name: "5-hour window: 24% used, Fine" }).waitFor();
    assert((await post("max-1", "builder", statusLine("s-builder", 80, 41.2, 9))).status === 200, "post failed");
    await page.locator('[data-account="max-1"]').getByRole("group", { name: "5-hour window: 80% used, Running low" }).waitFor({ timeout: 8000 });
  });

  await check("a session's lane opens its chat; Chats leads to the agents; Home leads back with the accounts still there", async () => {
    await page.locator('[data-account="max-1"]').getByRole("button", { name: /#builder/ }).first().click();
    await page.locator("h1", { hasText: "builder" }).waitFor({ timeout: 8000 });
    await page.locator(".rail").getByRole("button", { name: "Home" }).click();
    await page.locator('[data-account="max-2"]').waitFor();
    await page.locator(".rail").getByRole("button", { name: "Chats" }).click();
    await page.locator("h1", { hasText: "builder" }).waitFor();
    await page.locator(".rail").getByRole("button", { name: "Home" }).click();
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    assert(paired.errors.length === 0, `console errors: ${paired.errors.join(" | ")}`);
  });

  await check("Home survives a hub restart (the accounts are on disk)", async () => {
    await office!.restartHub();
    paired.errors.length = 0;
    await page.reload();
    await page.locator('[data-account="max-2"]').waitFor({ timeout: 15_000 });
    assert(paired.errors.length === 0, `console errors: ${paired.errors.join(" | ")}`);
  });

  code = finish();
} catch (e) {
  console.log(`FAIL  setup: ${(e as Error).message}`);
} finally {
  await browser.close();
  office?.stop();
  process.exit(code);
}
