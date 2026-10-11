// End-to-end checks of ADR-0013 (the Engines page) on a synthetic office with its own hub, in Playwright's own Chromium,
// against the engine layer's real CLI (bin/engines; $ENGINES_BIN)
// on a scratch settings file and state directory: never the box's own ~/.config/engines. A change made on the page is
// read back through `engines get`, the CLI the lanes and the manager use. Where the real CLI isn't installed (CI: the
// engine layer has no remote), its stand-in with the same contract runs instead (apps/hub/test/fixtures/fake-engines.mjs),
// and the first line of the output says which one ran.
// Stand-in programs (empty scripts) for the providers' CLIs make "installed" the same on every machine.
// Run: npm run build && node e2e/engines.e2e.ts
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONNECTION_WORDS } from "@morndo/protocol";
import { chromium, type Page } from "playwright";
import { assert, checks, outDir, pairedPage, startOffice } from "./harness.ts";

const OUT = outDir("engines");
const REAL = process.env.ENGINES_BIN ?? join(homedir(), "code/engine-layer/bin/engines");
const ENGINES = existsSync(REAL) ? REAL : join(import.meta.dirname, "../apps/hub/test/fixtures/fake-engines.mjs");
console.log(ENGINES === REAL ? `engines CLI: ${REAL}` : `engines CLI: its stand-in (${ENGINES}); the real one isn't at ${REAL}`);
const STUBS = join(OUT, "stub-bin");
mkdirSync(STUBS, { recursive: true });
for (const bin of ["claude-as", "agent", "codex", "studio"]) {
  writeFileSync(join(STUBS, bin), "#!/bin/sh\nexit 0\n");
  chmodSync(join(STUBS, bin), 0o755);
}
const enginesEnv = {
  ENGINES_CONFIG: join(OUT, "engines.json"), ENGINES_STATE: join(OUT, "engines-state"), PYTHONDONTWRITEBYTECODE: "1",
  PATH: `${STUBS}:${process.env.PATH ?? ""}`,
};
const engines = (...args: string[]) => execFileSync(ENGINES, args, { env: { ...process.env, ...enginesEnv }, encoding: "utf8" });
const get = (role: string) => (JSON.parse(engines("get", role, "--json")) as Record<string, { chain: string[]; other_provider?: boolean; other_provider_effective: boolean }>)[role];

const { check, watch, finish } = checks(OUT);
let code = 1;
let office: Awaited<ReturnType<typeof startOffice>> | null = null;
const browser = await chromium.launch();

const card = (page: Page, label: string) => page.getByRole("region", { name: label, exact: true });

try {
  // Codex signed in but out of quota for two hours; Cursor installed, not signed in (the shipped defaults).
  engines("login", "codex", "ok");
  engines("mark", "codex", "quota (e2e)", "--for", "120");
  // The CLI takes the same engine twice in a chain (set by hand); the page must still show it (review finding 3).
  engines("set", "validate", "claude:opus-5.5@high,claude:opus-5.5@high");
  // …and with that model paused, the resolver skips both copies: its skipped list holds the same engine twice too
  // (review of PR #13, finding 1).
  engines("mark", "claude:opus-5.5", "quota (e2e)", "--for", "120");
  // A role set longer than the page's limit of 8, from the terminal (verify round, finding 7).
  engines("set", "images", ["low", "medium", "high", "xhigh", "max"].flatMap(x => [`claude:sonnet-5.5@${x}`, `claude:haiku-4.5@${x}`]).slice(0, 9).join(","));
  office = await startOffice("engines", { MORNDO_ENGINES: ENGINES, ...enginesEnv });

  const phone = await pairedPage(browser, office, { width: 390, height: 844, phone: true, ready: "nav.tabbar", init: () => localStorage.setItem("morndo.tab", "chats") });
  const page = phone.page;
  watch(page);

  await check("the phone's devices page leads to Engines", async () => {
    // The chat list keeps Devices in the settings sheet (ADR-0011). The devices page still links to Engines.
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("link", { name: "Devices and sign out" }).click();
    await page.getByRole("link", { name: /Engines/ }).click();
    await page.getByRole("heading", { name: CONNECTION_WORDS.title, level: 1 }).waitFor({ timeout: 10_000 });
    assert(new URL(page.url()).pathname === "/engines", `at ${page.url()}`);
  });

  await check("one card per role, each with a provider, model and effort picker per engine, in the CLI's order", async () => {
    const roles = Object.keys(JSON.parse(engines("get", "--json")) as object);
    assert(roles.length >= 9, `the CLI lists ${roles.length} roles`);
    for (const r of roles) {
      const label = (JSON.parse(engines("get", r, "--json")) as Record<string, { label: string }>)[r]?.label ?? r;
      const c = card(page, label);
      await c.waitFor({ timeout: 5000 });
      assert(await c.getByRole("combobox", { name: "Provider, first choice" }).count() === 1, `${label}: no provider picker`);
      assert(await c.getByRole("combobox", { name: "Model, first choice" }).count() === 1, `${label}: no model picker`);
    }
    assert(await card(page, "Review").getByRole("combobox", { name: "Provider, fallback 1" }).count() === 1, "review's fallback has no picker");
    const validate = card(page, "Validate findings, write tests");
    assert(await validate.getByRole("combobox", { name: /^Model, / }).count() === 2, "the role holding one engine twice doesn't show both");
    await validate.getByText(/^Why not/).click();
    assert(await validate.locator(".skipped li").count() === 2, "the resolver's two skipped copies aren't both listed");
    // Readable on the phone: nothing wider than the screen (long provider names in a picker once pushed it sideways).
    const wide = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, screen: innerWidth }));
    assert(wide.page <= wide.screen, `the page is ${wide.page} px wide on a ${wide.screen} px screen`);
    await page.screenshot({ path: join(OUT, "1-phone-before.png"), fullPage: true });
  });

  await check("each provider's availability, as the resolver reports it", async () => {
    const list = page.getByRole("list", { name: "Providers" });
    const row = (name: RegExp) => list.getByRole("listitem").filter({ hasText: name });
    await row(/Claude Code/).getByText("Ready").waitFor({ timeout: 5000 });
    await row(/Cursor/).getByText("Not signed in").waitFor();
    await row(/Codex/).getByText(/Out of quota until/).waitFor();
  });

  await check("review: change the first choice and turn on the other-provider rule, save, and `engines get review` reads it back", async () => {
    const review = card(page, "Review");
    await review.getByRole("combobox", { name: "Model, first choice" }).selectOption("sonnet-5.5");
    await review.getByRole("combobox", { name: "Effort, first choice" }).selectOption("xhigh");
    await review.getByRole("switch", { name: /Reviewer from another provider/ }).click();
    await page.screenshot({ path: join(OUT, "2-phone-changed.png"), fullPage: true });
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("status").getByText(/^Saved/).waitFor({ timeout: 10_000 });
    const r = get("review");
    assert(r?.chain[0] === "claude:sonnet-5.5@xhigh", `engines get review: ${JSON.stringify(r)}`);
    assert(r?.other_provider === true && r.other_provider_effective === true, `the rule: ${JSON.stringify(r)}`);
    await page.screenshot({ path: join(OUT, "3-phone-saved.png"), fullPage: true });
  });

  await check("after a reload the page shows what the CLI holds", async () => {
    await page.reload();
    const review = card(page, "Review");
    await review.waitFor({ timeout: 10_000 });
    assert(await review.getByRole("combobox", { name: "Model, first choice" }).inputValue() === "sonnet-5.5", "model after reload");
    assert(await review.getByRole("switch", { name: /Reviewer from another provider/ }).getAttribute("aria-checked") === "true", "rule after reload");
  });

  await check("implement backend: a fallback moved up becomes the first choice, in that order in the CLI", async () => {
    const before = get("implement-backend")?.chain ?? [];
    const backend = card(page, "Implement: backend");
    await backend.getByRole("button", { name: "Move fallback 1 up" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("status").getByText(/^Saved/).waitFor({ timeout: 10_000 });
    const after = get("implement-backend")?.chain ?? [];
    assert(after[0] === before[1] && after[1] === before[0] && after.slice(2).join() === before.slice(2).join(), `before ${before.join()} after ${after.join()}`);
  });

  await check("no console errors on the phone while using the page", async () => {
    assert(phone.errors.length === 0, `console errors: ${phone.errors.join(" | ")}`);
  });

  await check("a role the CLI holds with one engine twice: the lower copy says it never runs, and the role still saves with it", async () => {
    const validate = card(page, "Validate findings, write tests");
    await validate.getByText("Also above: never runs").waitFor({ timeout: 5000 });
    await validate.getByRole("button", { name: "+ Add a fallback" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("status").getByText(/^Saved/).waitFor({ timeout: 10_000 });
    const chain = get("validate")?.chain ?? [];
    assert(chain.length === 3 && chain[0] === "claude:opus-5.5@high" && chain[1] === "claude:opus-5.5@high", `engines get validate: ${chain.join()}`);
  });

  await check("a list holds at most 8 engines: past that the page offers no more fallbacks and says why", async () => {
    const plan = card(page, "Plan and brief");
    const add = plan.getByRole("button", { name: "+ Add a fallback" });
    const engines = () => plan.getByRole("combobox", { name: /^Model, / }).count();
    // At most 8 clicks: one that adds nothing (an alert instead) ends the loop, and the count says so.
    for (let tries = 0; tries < 8 && (await engines()) < 8 && (await add.count()) === 1; tries++) await add.click();
    assert(await engines() === 8, `Plan holds ${await engines()} engines after the clicks, not 8: ${(await plan.getByRole("alert").allInnerTexts()).join(" | ")}`);
    assert(await add.count() === 0, "an add button past the limit");
    await plan.getByText("A list holds at most 8 engines.").waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "Discard" }).click();
  });

  await check("a role set longer than 8 says it can be reordered or changed, and saved at that length or shorter", async () => {
    const images = card(page, "Images and edits");
    await images.getByText("This list is longer than 8 engines (set outside the page). You can reorder or change its engines and save it at this length or shorter.").waitFor({ timeout: 5000 });
    assert(await images.getByRole("button", { name: "+ Add a fallback" }).count() === 0, "an add button on a list past the limit");
  });

  await check("a save the CLI wouldn't take is refused before anything is written; a stale page gets 409", async () => {
    const before = get("plan")?.chain;
    const errorsBefore = phone.errors.length;
    const r = await page.evaluate(async () => {
      const v = await fetch("/api/engines").then(x => x.json()) as { version: string };
      const post = (body: unknown) => fetch("/api/engines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
      return { bad: await post({ version: v.version, changes: [{ role: "plan", chain: ["claude:opus-5.5@ultra"] }] }), stale: await post({ version: "0".repeat(64), changes: [{ role: "plan", otherProvider: true }] }) };
    });
    assert(r.bad.status === 400 && r.bad.body.error === "unknown_effort", `bad: ${JSON.stringify(r.bad)}`);
    assert(r.stale.status === 409 && r.stale.body.error === "changed", `stale: ${JSON.stringify(r.stale)}`);
    assert(JSON.stringify(get("plan")?.chain) === JSON.stringify(before), "plan changed");
    // The browser logs the two refused requests it was asked to make here; nothing else.
    const added = phone.errors.slice(errorsBefore);
    assert(added.length === 2 && added.every(m => /status of (400|409)/.test(m)), `console errors: ${added.join(" | ")}`);
  });

  await check("on the desktop, the sidebar's settings lead to Engines too; the page is readable at 1440 px", async () => {
    const desk = await pairedPage(browser, office, { width: 1440, height: 900 });
    try {
      await desk.page.getByRole("link", { name: "Engines" }).click();
      await desk.page.getByRole("heading", { name: CONNECTION_WORDS.title, level: 1 }).waitFor({ timeout: 10_000 });
      await card(desk.page, "Review").waitFor();
      await desk.page.screenshot({ path: join(OUT, "4-desktop.png"), fullPage: true });
      assert(desk.errors.length === 0, `console errors: ${desk.errors.join(" | ")}`);
    } finally { await desk.context.close(); }
  });

  code = finish();
} catch (e) {
  console.log(`FAIL  setup: ${(e as Error).message}`);
} finally {
  await browser.close();
  office?.stop();
  process.exit(code);
}
