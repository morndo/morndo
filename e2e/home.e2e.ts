// End-to-end check of ADR-0016 (Home: usage across accounts) on a synthetic office with its own hub, in Playwright's
// Chromium: the desktop opens on Home, which says no account reports yet; sessions post their status-line JSON under
// a worker token for two accounts; Home shows the KPI row, a card per account with its meters in words and a reset
// time, the critical account's warning, the sessions on each account, and the Chats tab still leads to the agents.
// ADR-0034: once the pool's usage file (made-up accounts) exists, each card and tile adds the email, organization and plan.
// Run: npm run build && node e2e/home.e2e.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { HUB_MAIN, assert, checks, outDir, pairedPage, startOffice } from "./harness.ts";

// Polls a read until it satisfies `ok` (what Playwright's expect.poll does in its own test runner, which this script does not use).
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, timeout = 8000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`${what}: last read ${JSON.stringify(v)}`);
    await new Promise(r => setTimeout(r, 200));
  }
}

const OUT = outDir("home");
const { check, watch, finish } = checks(OUT);
let code = 1;
let office: Awaited<ReturnType<typeof startOffice>> | null = null;
const browser = await chromium.launch();
const HOUR = 3_600_000;
// The pool's usage file (JSON Lines) for the label check: made-up accounts, written only when the check says so.
const poolDir = mkdtempSync(join(tmpdir(), "morndo-home-pool-"));
const poolFile = join(poolDir, "usage-from-pc.json");
const poolLines = [
  { name: "max-1", email: "ada@example.test", org: "claude_team", orgId: "org-0001", plan: "max", tier: "default_claude_max_5x" },
  { name: "max-2", email: "lin@example.test", org: "personal_org", orgId: "org-0002", plan: "max", tier: "default_claude_max_20x" },
].map(l => JSON.stringify(l)).join("\n") + "\n";

const mint = (env: NodeJS.ProcessEnv, role: "worker" | "manager" = "worker", scopes: string[] = []) =>
  execFileSync(process.execPath, ["--no-warnings", HUB_MAIN, "agent-token", "new", role === "manager" ? "manager" : scopes.length > 0 ? "collector" : "lanes", "--role", role, ...scopes.flatMap(s => ["--scope", s])], { env, encoding: "utf8" }).split("\n")[0]?.trim() ?? "";
// A status line's JSON as Claude Code gives it (resets_at in epoch seconds), posted as a lane's status line would.
const statusLine = (session: string, five: number | null, week: number | null, ctx: number) => ({
  cwd: "/w", session_id: session, model: { id: "claude-opus-5-5", display_name: "Opus" }, version: "2.1.295", context_window: { used_percentage: ctx },
  ...(five === null && week === null ? {} : { rate_limits: {
    ...(five === null ? {} : { five_hour: { used_percentage: five, resets_at: Math.floor((Date.now() + 2 * HOUR + 10 * 60_000) / 1000) } }),
    ...(week === null ? {} : { seven_day: { used_percentage: week, resets_at: Math.floor((Date.now() + 3 * 24 * HOUR) / 1000) } }),
  } }),
});

try {
  // T-430: the readings route is a manager's or the usage-pool scope's; this office runs the gate in enforce.
  office = await startOffice("home", { MORNDO_POOL_USAGE: poolFile, MORNDO_USAGE_READINGS_GATE: "enforce" });
  const token = mint(office.env);
  assert(token.startsWith("mat_"), "the console didn't print the token");
  const managerToken = mint(office.env, "manager");
  assert(managerToken.startsWith("mat_"), "the console didn't print the manager token");
  const poolToken = mint(office.env, "worker", ["usage-pool"]);
  assert(poolToken.startsWith("mat_"), "the console didn't print the usage-pool token");
  const post = (account: string, lane: string, body: unknown) => fetch(`${office!.base}/api/agent/usage`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-morndo-lane": lane, "x-morndo-account": account }, body: JSON.stringify(body),
  });
  // A usage reading a source posts (U14), epoch seconds on the wire; and a seat's limit hit (a manager's route).
  const readingsAs = (secret: string, account: string, body: unknown) => fetch(`${office!.base}/api/agent/usage/readings`, {
    method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "x-morndo-lane": "collector", "x-morndo-account": account }, body: JSON.stringify(body),
  });
  const readings = (account: string, body: unknown) => readingsAs(poolToken, account, body);
  const limit = (account: string, body: unknown) => fetch(`${office!.base}/api/agent/usage/limit`, {
    method: "POST", headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json", "x-morndo-lane": "collector" }, body: JSON.stringify({ account, ...body }),
  });
  const SEC = 1000;
  const fiveHour = (n: number) => ({ id: "five_hour", used_percent: n, resets_at: Math.floor((Date.now() + 2 * HOUR) / SEC), length_mins: 300 });

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

  await check("the pool's file is absent: the cards name the accounts alone; once it exists, the hub's next look adds email, organization and plan", async () => {
    const one = page.locator('[data-account="max-1"]');
    assert((await one.locator("header").innerText()).split("\n")[0] === "max-1", "the card names more than the account before the file");
    assert(!(await page.getByLabel("Usage at a glance").innerText()).includes("example.test"), "an email shows without the file");
    await page.screenshot({ path: join(OUT, "3-labels-before-desktop.png") });
    writeFileSync(poolFile, poolLines);
    await office!.restartHub();                // the hub looks at the file at its start, then every minute
    paired.errors.length = 0;                  // the restart refused the open feed once
    await page.reload();
    await one.waitFor({ timeout: 15_000 });
    await one.locator(".ident").waitFor({ timeout: 15_000 });   // the first look is asynchronous: the label follows the card
    const head = await one.locator("header").innerText();
    assert(/max-1\s*·\s*ada@example\.test\s*·\s*Team\s*·\s*Max 5x/.test(head), `max-1 header: ${head}`);
    const two = await page.locator('[data-account="max-2"] header').innerText();
    assert(/max-2\s*·\s*lin@example\.test\s*·\s*personal\s*·\s*Max 20x/.test(two), `max-2 header: ${two}`);
    assert(await one.getAttribute("aria-label") === "Account max-1 · ada@example.test · Team · Max 5x", "the card's name for assistive tech");
    const kpis = await page.getByLabel("Usage at a glance").innerText();
    assert(/max-2 · lin@example\.test · personal · Max 20x/.test(kpis), `the tightest tile doesn't say who: ${kpis}`);
    assert(!(await page.content()).includes("org-000"), "an org id reached the page");
    await page.screenshot({ path: join(OUT, "4-labels-after-desktop.png") });
  });

  await check("on a phone (390 px) the same labels show, wrap and never widen the page", async () => {
    const phone = await pairedPage(browser, office!, { width: 390, height: 844, phone: true, ready: "nav.tabbar" });
    try {
      // A tap where the tab bar shows (phone-chat.e2e.ts tapTab): Playwright's own click scrolls the sticky bar's static place into view.
      const box = await phone.page.locator("nav.tabbar button", { hasText: "Home" }).boundingBox();
      assert(box !== null, "no Home tab");
      await phone.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const card = phone.page.locator('[data-account="max-1"]');
      await card.waitFor({ timeout: 10_000 });
      const head = await card.locator("header").innerText();
      assert(/max-1\s*·\s*ada@example\.test\s*·\s*Team\s*·\s*Max 5x/.test(head), `phone header: ${head}`);
      assert(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page scrolls sideways at 390 px");
      await phone.page.screenshot({ path: join(OUT, "5-labels-after-phone.png") });
      assert(phone.errors.length === 0, `console errors: ${phone.errors.join(" | ")}`);
    } finally { await phone.context.close(); }
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

  await check("shows the four states and a title from the cadence (AT-12): available, stale, unavailable", async () => {
    // A lane's plain worker token is refused on the readings route (T-430, enforce); the collector's usage-pool token is not.
    const plain = await readingsAs(token, "fresh", { source: "app-server", node: null, captured_at: Math.floor(Date.now() / SEC), windows: [fiveHour(99)] });
    assert(plain.status === 403, `a plain worker token's reading was not refused: ${plain.status}`);
    // (a) `fresh`: a fresh app-server reading — available, meters as usual.
    assert((await readings("fresh", { source: "app-server", node: null, captured_at: Math.floor(Date.now() / SEC), windows: [fiveHour(42)] })).status === 200, "post failed");
    const fresh = page.locator('[data-account="fresh"]');
    await fresh.waitFor({ timeout: 8000 });
    await fresh.getByRole("group", { name: "5-hour window: 42% used, Fine" }).waitFor({ timeout: 8000 });
    // (b) `old`: a reading stamped 20 minutes ago (the hub accepts a past stamp) — stale, dimmed, "As of".
    assert((await readings("old", { source: "app-server", node: null, captured_at: Math.floor((Date.now() - 20 * 60_000) / SEC), windows: [fiveHour(30)] })).status === 200, "post failed");
    const old = page.locator('[data-account="old"]');
    await old.waitFor({ timeout: 8000 });
    await old.getByRole("group", { name: "5-hour window: 30% used, Fine" }).waitFor({ timeout: 8000 });
    assert((await old.locator(".meter.stale").count()) > 0, "the stale meters are not dimmed");
    assert((await old.innerText()).includes("As of"), "the stale card doesn't say since when");
    // (c) `dead`: a first post that is a failure with reason signed_out — the meters are replaced by the words.
    assert((await readings("dead", { source: "app-server", node: null, captured_at: Math.floor(Date.now() / SEC), failure: { reason: "signed_out", hint: "<b>x</b> https://x.example/" } })).status === 200, "post failed");
    const dead = page.locator('[data-account="dead"]');
    await dead.waitFor({ timeout: 8000 });
    await dead.getByRole("status").waitFor({ timeout: 8000 });
    const deadText = (await dead.innerText()).replace(/\s+/g, " ");
    assert(deadText.includes("Can't read since"), `the dead card doesn't say since when: ${deadText}`);
    assert(deadText.includes("Fix: sign in again"), `the dead card doesn't say the fix: ${deadText}`);
    assert(deadText.includes("the source says:"), `the dead card doesn't quote the source: ${deadText}`);
    assert(deadText.includes("<b>x</b>"), `the hint is not shown as text: ${deadText}`);
    assert(!deadText.includes("https://x.example"), `a link in the hint reached the page: ${deadText}`);
    assert(!/reported \d+ d ago/.test(deadText), `an account nothing was reported for says it was long ago: ${deadText}`);
    assert(await dead.locator(".meter").count() === 0, "an unavailable source still shows meters");
    assert(await dead.locator("b, a[href]").count() === 0, "the hint created markup or a link");
    // (d) a window the poster calls "Monthly" whose length is a week is the weekly window (the hub names a window by its length,
    // never by the poster's word); an account whose only window has another length keeps its own label with the title its cadence gives it.
    assert((await readings("fresh", { source: "app-server", node: null, captured_at: Math.floor(Date.now() / SEC), windows: [
      fiveHour(42),
      { id: "Monthly", used_percent: 61, resets_at: Math.floor((Date.now() + 7 * 24 * HOUR) / SEC), length_mins: 10080 },
    ] })).status === 200, "post failed");
    await eventually(async () => (await fresh.innerText()).replace(/\s+/g, " "), v => v.includes("Weekly window") && v.includes("61%"), "the week-long window");
    const freshText = (await fresh.innerText()).replace(/\s+/g, " ");
    assert(!/monthly/i.test(freshText), `the poster's word named a window: ${freshText}`);
    assert((await readings("burst", { source: "app-server", node: null, captured_at: Math.floor(Date.now() / SEC), windows: [
      { id: "Burst", used_percent: 33, resets_at: Math.floor((Date.now() + 3 * 24 * HOUR) / SEC), length_mins: 4320 },
    ] })).status === 200, "post failed");
    const burst = page.locator('[data-account="burst"]');
    await eventually(async () => (await burst.innerText().catch(() => "")).replace(/\s+/g, " "), v => v.includes("Burst · 3-day"), "the titled window's title");
    await page.screenshot({ path: join(OUT, "6-states-desktop.png") });
    // (d, S6) the same account with a fixed pair and a named window beside them: the card shows the fixed rows first
    // and the named one after them under "Other limits".
    assert((await readings("fresh", { source: "app-server", node: null, captured_at: Math.floor(Date.now() / SEC), windows: [
      fiveHour(42),
      { id: "seven_day", used_percent: 61, resets_at: Math.floor((Date.now() + 7 * 24 * HOUR) / SEC), length_mins: 10080 },
      { id: "Burst", used_percent: 33, resets_at: Math.floor((Date.now() + 3 * 24 * HOUR) / SEC), length_mins: 4320 },
    ] })).status === 200, "post failed");
    await eventually(async () => (await fresh.innerText()).replace(/\s+/g, " "), v => v.includes("Weekly window") && v.includes("5-hour window") && v.includes("Burst · 3-day"), "the mixed card");
    await page.screenshot({ path: join(OUT, "10-mixed-desktop.png") });
  });

  await check("the states on a phone (390 px): the tab bar's Home, nothing wider than the screen", async () => {
    const phone = await pairedPage(browser, office!, { width: 390, height: 844, phone: true, ready: "nav.tabbar" });
    try {
      const box = await phone.page.locator("nav.tabbar button", { hasText: "Home" }).boundingBox();
      assert(box !== null, "no Home tab");
      await phone.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await phone.page.locator('[data-account="dead"]').waitFor({ timeout: 10_000 });
      assert(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page scrolls sideways at 390 px");
      assert(phone.errors.length === 0, `console errors: ${phone.errors.join(" | ")}`);
      await phone.page.screenshot({ path: join(OUT, "7-states-phone.png") });
    } finally { await phone.context.close(); }
  });

  await check("the mixed card on a phone (390 px): fixed rows, Other limits, nothing wider than the screen (S6)", async () => {
    const phone = await pairedPage(browser, office!, { width: 390, height: 844, phone: true, ready: "nav.tabbar" });
    try {
      const box = await phone.page.locator("nav.tabbar button", { hasText: "Home" }).boundingBox();
      assert(box !== null, "no Home tab");
      await phone.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const fresh = phone.page.locator('[data-account="fresh"]');
      await fresh.waitFor({ timeout: 10_000 });
      await eventually(async () => (await fresh.innerText().catch(() => "")).replace(/\s+/g, " "), v => v.includes("Burst · 3-day"), "the mixed card on the phone");
      assert(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page scrolls sideways at 390 px");
      assert(phone.errors.length === 0, `console errors: ${phone.errors.join(" | ")}`);
      await fresh.scrollIntoViewIfNeeded();                    // the shot shows the mixed card, not the top of the page
      await phone.page.screenshot({ path: join(OUT, "11-mixed-phone.png") });
    } finally { await phone.context.close(); }
  });

  await check("a seat from a limit hit, the notices panel, and the principal's Clear", async () => {
    // (e) a manager token's limit post for `fresh`: the badge, the notice, and the Clear that removes it.
    assert((await limit("fresh", { kind: "usage_limit", by: "worker-one", back_at: Math.floor((Date.now() + HOUR) / SEC), at: Math.floor(Date.now() / SEC) })).status === 200, "limit post failed");
    const fresh = page.locator('[data-account="fresh"]');
    const seated = fresh.locator(".seat");
    await seated.waitFor({ timeout: 8000 });
    assert((await seated.innerText()).includes("Out until"), `the seat badge doesn't say since when: ${await seated.innerText()}`);
    const panel = page.locator(".notices");
    await panel.waitFor({ timeout: 8000 });
    const panelText = (await panel.innerText()).replace(/\s+/g, " ");
    assert(/fresh: .*usage limit reached/.test(panelText), `the notices panel doesn't name the seat notice: ${panelText}`);
    const clear = fresh.getByRole("button", { name: /Clear this mark/ });
    await clear.click();
    await eventually(async () => fresh.locator(".seat").count(), v => v === 0, "the seat badge goes");
    await page.screenshot({ path: join(OUT, "8-seat-and-notices-desktop.png") });
  });

  await check("the seat and notices on a phone, then the two-tap Forget of a dead source", async () => {
    const phone = await pairedPage(browser, office!, { width: 390, height: 844, phone: true, ready: "nav.tabbar" });
    try {
      const box = await phone.page.locator("nav.tabbar button", { hasText: "Home" }).boundingBox();
      assert(box !== null, "no Home tab");
      await phone.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await phone.page.locator(".notices").waitFor({ timeout: 10_000 });
      assert(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page scrolls sideways at 390 px");
      assert(phone.errors.length === 0, `console errors: ${phone.errors.join(" | ")}`);
      await phone.page.screenshot({ path: join(OUT, "9-seat-and-notices-phone.png") });
      // (f) the Forget flow: two taps, and the dead account's source line is gone.
      const dead = phone.page.locator('[data-account="dead"]');
      await dead.waitFor({ timeout: 10_000 });
      const forget = dead.getByRole("button", { name: /Forget/ }).first();
      await forget.click();
      await eventually(async () => forget.innerText(), v => v.includes("Forget? (this removes it)"), "the second tap asks");
      await new Promise(r => setTimeout(r, 500));                 // a second tap right on the first is a double click, not a decision
      await forget.click();
      await eventually(async () => dead.getByRole("button", { name: /Forget/ }).count(), v => v === 0, "the source line goes");
      assert((await dead.count()) === 0, "the forgotten account's card is still there");
    } finally { await phone.context.close(); }
  });

  code = finish();
} catch (e) {
  console.log(`FAIL  setup: ${(e as Error).message}`);
} finally {
  await browser.close();
  office?.stop();
  rmSync(poolDir, { recursive: true, force: true });
  process.exit(code);
}
