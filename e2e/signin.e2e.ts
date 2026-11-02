// Sign-in from the app (ADR-0039), end to end: a real fleet, a real node agent on its own tmux server, the real hub in
// fleet mode serving the built web app in headless Chromium, paired through a virtual passkey. The node's CLIs are
// test/fixtures/fake-signin-cli.mjs (as `claude` and `agent` on the agent's PATH). Locked by the keryx run app-sign-in.
// - An account added on the Engines page signs in with the code from the sign-in page; its home is 0700, its login 0600.
// - A wrong code ends the sign-in in words, with Try again.
// - A signed-out account in rotation gets a card; the card's Sign in opens the same sheet; the card goes once it works.
// - Nothing the hub writes holds the code or the link.
// Run: npm run build (once), then: node e2e/signin.e2e.ts. Exit code 0 only if every check passed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { assert, checks, outDir, pairedPage } from "./harness.ts";
import { joinAgent, startFleet, startHub, stopAll, tmuxServer, until } from "../test/fleet-harness.ts";

const OUT = outDir("signin");
assert(existsSync(join(import.meta.dirname, "../apps/web/build/200.html")), "build the web app first: npm run build");
const { check, watch, finish } = checks(OUT);
const FAKE = join(import.meta.dirname, "../test/fixtures/fake-signin-cli.mjs");
const bin = mkdtempSync(join(tmpdir(), "signin-bin-"));
symlinkSync(FAKE, join(bin, "claude"));
symlinkSync(FAKE, join(bin, "agent"));
const mode = (p: string) => statSync(p).mode & 0o777;

async function signIn(page: Page, code: string): Promise<void> {
  const sheet = page.getByRole("dialog", { name: /Sign in/ });
  await sheet.getByRole("button", { name: "Start sign-in" }).click();
  const link = sheet.getByRole("link", { name: "Open sign-in page" });
  await link.waitFor({ timeout: 20_000 });
  const href = await link.getAttribute("href");
  assert(href?.startsWith("https://claude.com/cai/oauth/authorize?"), `the link is ${href}`);
  await sheet.getByLabel("Code from the sign-in page").fill(code);
  await sheet.getByRole("button", { name: "Send code" }).click();
}

let code = 1;
const browser = await chromium.launch();
try {
  const fleet = await startFleet();
  const n1 = await joinAgent(fleet, "n1", { tmux: tmuxServer() });
  mkdirSync(join(n1.home, ".claude-accounts", "a1"), { recursive: true, mode: 0o775 });   // signed out, in rotation
  await n1.run(undefined, { env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  await n1.waitOnline();
  const hub = await startHub(fleet, { web: "build", pollMs: 400 });
  const { page } = await pairedPage(browser, hub);
  watch(page);
  const sheet = page.getByRole("dialog", { name: /Sign in/ });

  await check("an account added on the Engines page signs in with the code from the sign-in page", async () => {
    await page.goto(new URL("/engines", page.url()).href);
    const accounts = page.getByRole("region", { name: "Accounts" });
    await accounts.getByLabel("Node").selectOption("n1");
    await accounts.getByLabel("New account name").fill("a8");
    await accounts.getByRole("button", { name: "Add account" }).click();
    await signIn(page, "good-code");
    await sheet.getByText("Works again").waitFor({ timeout: 20_000 });
    await sheet.getByText("person@example.com").waitFor();
    const dir = join(n1.home, ".claude-accounts", "a8");
    assert(mode(dir) === 0o700, `a8's home is ${mode(dir).toString(8)}`);
    assert(mode(join(dir, ".credentials.json")) === 0o600, "a8's login file isn't 0600");
    await page.screenshot({ path: join(OUT, "1-added-a8.png") });
    await sheet.getByRole("button", { name: "Close" }).click();
    await accounts.getByText("a8").waitFor();
  });

  await check("a wrong code ends the sign-in in words, with Try again, and signs nothing in", async () => {
    const accounts = page.getByRole("region", { name: "Accounts" });
    await accounts.getByLabel("New account name").fill("a9");
    await accounts.getByRole("button", { name: "Add account" }).click();
    await signIn(page, "wrong-code");
    await sheet.getByRole("button", { name: "Try again" }).waitFor({ timeout: 20_000 });
    assert(!existsSync(join(n1.home, ".claude-accounts", "a9", ".credentials.json")), "a9 got a login");
    await page.screenshot({ path: join(OUT, "2-wrong-code.png") });
    await sheet.getByRole("button", { name: "Close" }).click();
  });

  await check("a signed-out account in rotation gets a card; its Sign in signs it in and the card goes", async () => {
    await page.goto(new URL("/", page.url()).href);
    await page.locator(".rail").getByRole("button", { name: /Decisions/ }).click();
    const card = page.getByRole("complementary", { name: "Decisions" }).locator('[data-decision="signin-n1-claude-a1"]');
    await card.getByText("Claude a1 on n1 is signed out").waitFor({ timeout: 40_000 });
    await page.screenshot({ path: join(OUT, "3-card.png") });
    await card.getByRole("button", { name: "Sign in" }).click();
    await signIn(page, "good-code");
    await sheet.getByText("Works again").waitFor({ timeout: 20_000 });
    await sheet.getByRole("button", { name: "Close" }).click();
    await until("the card to go", async () => (await card.count()) === 0, 20_000);
    assert(existsSync(join(n1.home, ".claude-accounts", "a1", ".credentials.json")), "a1 has no login");
  });

  await check("nothing the hub wrote holds the code or the link", async () => {
    const written = hub.audit() + readFileSync(join(hub.home, "hub.log"), "utf8");
    assert(!written.includes("good-code"), "the code is in the hub's audit or log");
    assert(!written.includes("claude.com/cai/oauth"), "the sign-in link is in the hub's audit or log");
  });
  code = finish();
} finally {
  await browser.close();
  await stopAll();
}
process.exit(code);
