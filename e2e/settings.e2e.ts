// One Settings page (ADR-0039 §9, the owner's ask after the first live sign-in): the desktop's gear and the phone's
// settings sheet open /settings, with its sections on the left (desktop) or as a list (phone): Accounts, LLM
// connections, Devices and Updates, each shown when this hub has it. Each account names its email and plan, and two
// folders that share an email say so. A real fleet, a real node agent, the real hub serving the built app, in Chromium;
// the node's CLIs are test/fixtures/fake-signin-cli.mjs. Locked by the keryx run settings-accounts.
// Run: npm run build (once), then: node e2e/settings.e2e.ts. Exit code 0 only if every check passed.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { assert, checks, outDir, pairedPage } from "./harness.ts";
import { joinAgent, startFleet, startHub, stopAll, tmuxServer } from "../test/fleet-harness.ts";

const OUT = outDir("settings");
assert(existsSync(join(import.meta.dirname, "../apps/web/build/200.html")), "build the web app first: npm run build");
const { check, watch, finish } = checks(OUT);
const FAKE = join(import.meta.dirname, "../test/fixtures/fake-signin-cli.mjs");
const bin = mkdtempSync(join(tmpdir(), "settings-bin-"));
symlinkSync(FAKE, join(bin, "claude"));
symlinkSync(FAKE, join(bin, "agent"));

// Two accounts signed in to the same email (the stand-in's), one signed out that last named another.
function account(home: string, name: string, o: { signedIn: boolean; email?: string }) {
  const dir = join(home, ".claude-accounts", name);
  mkdirSync(dir, { recursive: true });
  if (o.signedIn) {
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x", refreshToken: "y", subscriptionType: "max" } }));
    chmodSync(join(dir, ".credentials.json"), 0o600);
  }
  if (o.email) writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: o.email } }));
}

let code = 1;
const browser = await chromium.launch();
try {
  const fleet = await startFleet();
  const n1 = await joinAgent(fleet, "n1", { tmux: tmuxServer() });
  account(n1.home, "a1", { signedIn: true });
  account(n1.home, "a2", { signedIn: true });
  account(n1.home, "a3", { signedIn: false, email: "earlier@example.com" });
  await n1.run(undefined, { env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  await n1.waitOnline();
  const hub = await startHub(fleet, { web: "build", pollMs: 400 });

  const desk = await pairedPage(browser, hub, { width: 1440, height: 900 });
  watch(desk.page);
  const row = (name: string) => desk.page.getByRole("region", { name: "Accounts" }).getByRole("listitem").filter({ hasText: new RegExp(`^\\s*${name}\\b`) });

  await check("the desktop's gear opens Settings, its sections on the left, Accounts first", async () => {
    await desk.page.getByRole("link", { name: "Settings", exact: true }).click();
    await desk.page.getByRole("heading", { name: "Settings", level: 1 }).waitFor({ timeout: 10_000 });
    assert(new URL(desk.page.url()).pathname.startsWith("/settings"), `at ${desk.page.url()}`);
    const nav = desk.page.getByRole("navigation", { name: "Settings sections" });
    for (const s of ["Accounts", "Devices"]) await nav.getByRole("link", { name: s, exact: true }).waitFor();
    await desk.page.getByRole("region", { name: "Accounts" }).waitFor();
    await desk.page.screenshot({ path: join(OUT, "1-settings-accounts.png") });
  });

  await check("each account names its email and plan; two folders on one email say so; a signed-out one shows the email it last had", async () => {
    await desk.page.getByRole("region", { name: "Accounts" }).getByLabel("Node").selectOption("n1");
    await row("a1").getByText("person@example.com").waitFor({ timeout: 20_000 });
    await row("a1").getByText(/max/i).waitFor();
    await row("a1").getByText("Same email as a2").waitFor();
    await row("a2").getByText("Same email as a1").waitFor();
    await row("a3").getByText("earlier@example.com").waitFor();
    assert(await row("a3").getByText(/Same email as/).count() === 0, "a3 is flagged although no other folder has its email");
    await desk.page.screenshot({ path: join(OUT, "2-emails.png") });
  });

  await check("another section opens in place, and its address names it", async () => {
    await desk.page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Devices", exact: true }).click();
    await desk.page.getByRole("heading", { name: "Devices" }).first().waitFor({ timeout: 10_000 });
    assert(new URL(desk.page.url()).pathname === "/settings/devices", `at ${desk.page.url()}`);
    await desk.page.getByRole("navigation", { name: "Settings sections" }).waitFor();
    await desk.page.screenshot({ path: join(OUT, "3-devices.png") });
  });

  await check("no console errors on the desktop", async () => {
    assert(desk.errors.length === 0, `console errors: ${desk.errors.join(" | ")}`);
  });

  const phone = await pairedPage(browser, hub, { width: 390, height: 844, phone: true, ready: "nav.tabbar", init: () => localStorage.setItem("morndo.tab", "chats") });
  watch(phone.page);
  await check("on the phone the settings sheet leads to Settings: the sections as a list, a section, and back", async () => {
    await phone.page.getByRole("button", { name: "Settings" }).click();
    await phone.page.getByRole("link", { name: "Settings", exact: true }).click();
    await phone.page.getByRole("heading", { name: "Settings", level: 1 }).waitFor({ timeout: 10_000 });
    const list = phone.page.getByRole("navigation", { name: "Settings sections" });
    await list.getByRole("link", { name: "Accounts", exact: true }).click();
    await phone.page.getByRole("region", { name: "Accounts" }).waitFor({ timeout: 10_000 });
    await phone.page.screenshot({ path: join(OUT, "4-phone-accounts.png") });
    await phone.page.getByRole("link", { name: "Back" }).click();
    await phone.page.getByRole("navigation", { name: "Settings sections" }).waitFor();
    assert(phone.errors.length === 0, `console errors: ${phone.errors.join(" | ")}`);
  });
  code = finish();
} finally {
  await browser.close();
  await stopAll();
}
process.exit(code);
