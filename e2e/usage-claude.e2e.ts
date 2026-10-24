// End-to-end check of the headless usage reader (slice 5 of the usage plan, docs/plans/2026-10-23-usage-detection.md
// section 4.4) on a synthetic office with its own hub, in Playwright's Chromium: the collector (`morndo-usage-claude
// --once`) asks the hub for a lease; the hub has never heard of the account, so it is wanted once and the pass is granted
// (that rule is what lets a configured account appear on Home at all; every later read waits for a viewer or a limit
// mark, which the hub's own tests drive with a fake clock); the collector runs a FAKE CLI (a script that prints a made-up report: the real CLI is
// never run here), and posts the reading with its lease; Home shows the account's windows from that source; a second
// pass inside the cache window spawns nothing; a failing CLI (signed out) posts a failure Home says in words.
// Run: npm run build && node e2e/usage-claude.e2e.ts
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { HUB_MAIN, assert, checks, outDir, pairedPage, startOffice } from "./harness.ts";

const OUT = outDir("usage-claude");
const { check, watch, finish } = checks(OUT);
let code = 1;
let office: Awaited<ReturnType<typeof startOffice>> | null = null;
const browser = await chromium.launch();
const work = mkdtempSync(join(tmpdir(), "morndo-usage-claude-"));
const COLLECTOR = join(import.meta.dirname, "../apps/connections/src/adapters/usage-claude-main.ts");

// The fake CLI: `-p /usage ...` prints a made-up report (one assistant event carrying it, then a result), `auth status`
// exits 1 (signed out) when the marker file exists. It counts its own runs in a file, so the test can say "spawned once".
const reset = (ms: number) => new Date(Date.now() + ms).toISOString();
const report = (extra = "") => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "usage" }], usage_report: {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  rate_limits: { limits: [
    { kind: "session", group: "session", percent: 37, resets_at: reset(2 * 3_600_000), scope: null, severity: "normal", is_active: false },
    { kind: "weekly_all", group: "weekly", percent: 58, resets_at: reset(3 * 86_400_000), scope: null, severity: "normal", is_active: true },
  ], extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: "EUR" } },
} } }) + extra;
const fakeCli = join(work, "fake-cli.mjs");
writeFileSync(fakeCli, `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
const a = process.argv.slice(2);
if (a[0] === "auth") process.exit(existsSync(${JSON.stringify(join(work, "signed-out"))}) ? 1 : 0);
appendFileSync(${JSON.stringify(join(work, "runs"))}, "run\\n");
if (existsSync(${JSON.stringify(join(work, "signed-out"))})) { console.log(JSON.stringify({ type: "result", is_error: true, result: "Not logged in. Please sign in again (401)." })); process.exit(1); }
console.log(JSON.stringify({ type: "system", subtype: "init" }));
console.log(${JSON.stringify(report())});
console.log(JSON.stringify({ type: "result", is_error: false, num_turns: 0, total_cost_usd: 0 }));
`);
chmodSync(fakeCli, 0o755);
const runs = () => { try { return readFileSync(join(work, "runs"), "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };

const mint = (env: NodeJS.ProcessEnv) =>
  execFileSync(process.execPath, ["--no-warnings", HUB_MAIN, "agent-token", "new", "usage-claude", "--role", "worker"], { env, encoding: "utf8" }).split("\n")[0]?.trim() ?? "";

try {
  office = await startOffice("usage-claude");
  const token = mint(office.env);
  assert(token.startsWith("mat_"), "the console didn't print the token");
  writeFileSync(join(work, "token"), token + "\n", { mode: 0o600 });
  const config = join(work, "config.json");
  writeFileSync(config, JSON.stringify({ hub: office.base, tokenFile: join(work, "token"), node: "pc", accounts: { "seat-a": { configDir: join(work, "seat-a-config") } } }));
  const pass = () => spawnSync(process.execPath, ["--no-warnings", COLLECTOR, "--once"], {
    env: { ...process.env, MORNDO_USAGE_CLAUDE_CONFIG: config, MORNDO_CLAUDE_BIN: fakeCli }, encoding: "utf8", timeout: 60_000,
  });
  const paired = await pairedPage(browser, office);
  const { page } = paired;
  watch(page);

  await check("an account the hub has never heard of is read once, on the collector's first ask (nobody could be looking at it yet)", async () => {
    const first = pass();
    assert(first.status === 0, `the collector failed: ${first.stderr}`);
    assert(!`${first.stdout}${first.stderr}`.includes(token), "the token reached the collector's output");
    assert(runs() === 1, `the CLI ran ${runs()} times on the first ask`);
  });

  await check("Home shows the account's windows from that source, with its line", async () => {
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor({ timeout: 10_000 });
    const card = page.locator('[data-account="seat-a"]');
    await card.waitFor({ timeout: 10_000 });
    await card.getByRole("group", { name: /5-hour window: 37% used/ }).waitFor({ timeout: 10_000 });
    await card.getByRole("group", { name: /Weekly window: 58% used/ }).waitFor({ timeout: 10_000 });
    assert((await card.innerText()).includes("claude-usage: reading now"), `the source line is missing: ${await card.innerText()}`);
    await page.screenshot({ path: join(OUT, "1-reader-home-desktop.png") });
  });

  await check("a second pass inside the cache window spawns nothing", async () => {
    const before = runs();
    pass(); pass();
    assert(runs() === before, `the CLI ran again inside the cache window (${runs() - before} more)`);
  });

  await check("a signed-out CLI posts a failure, and Home says it in words", async () => {
    writeFileSync(join(work, "signed-out"), "1");
    // The cache and the demand must be spent for a new read: a fresh account name keeps this test off the clock.
    const cfg2 = join(work, "config2.json");
    writeFileSync(cfg2, JSON.stringify({ hub: office!.base, tokenFile: join(work, "token"), node: "pc", accounts: { "seat-b": { configDir: join(work, "seat-b-config") } } }));
    const card = page.locator('[data-account="seat-b"]');
    let seen = false;
    for (let i = 0; i < 8 && !seen; i++) {
      spawnSync(process.execPath, ["--no-warnings", COLLECTOR, "--once"], { env: { ...process.env, MORNDO_USAGE_CLAUDE_CONFIG: cfg2, MORNDO_CLAUDE_BIN: fakeCli }, encoding: "utf8", timeout: 60_000 });
      seen = (await card.count()) > 0;
      if (!seen) await new Promise(r => setTimeout(r, 1000));
    }
    assert(seen, "the signed-out account never showed");
    await card.getByRole("status").waitFor({ timeout: 10_000 });
    const text = (await card.innerText()).replace(/\s+/g, " ");
    assert(text.includes("Can't read since"), `no 'can't read since': ${text}`);
    assert(text.includes("Fix: sign in again"), `no fix: ${text}`);
    await page.screenshot({ path: join(OUT, "2-reader-signed-out-desktop.png") });
    assert(paired.errors.length === 0, `console errors: ${paired.errors.join(" | ")}`);
  });

  code = finish();
} catch (e) {
  console.log(`FAIL  setup: ${(e as Error).message}`);
} finally {
  await browser.close();
  office?.stop();
  rmSync(work, { recursive: true, force: true });
  process.exit(code);
}
