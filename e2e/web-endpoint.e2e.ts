// End-to-end check of the web endpoint, the way the principal uses it, on synthetic workers only.
// A private tmux server with fake panes, the real hub, the built web app, and headless Chromium with a virtual
// passkey (Chrome DevTools Protocol, WebAuthn domain). Run: npm run build && node e2e/web-endpoint.e2e.ts
// Screenshots go to $E2E_OUT (default: a temp dir). Exit code 0 only if every check passed.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const ROOT = join(import.meta.dirname, "..");
const OUT = process.env.E2E_OUT ?? mkdtempSync(join(tmpdir(), "morndo-e2e-out-"));
const HOME = mkdtempSync(join(tmpdir(), "morndo-e2e-"));
const SOCKET = `morndo-e2e-${process.pid}`;
mkdirSync(OUT, { recursive: true });

const results: { name: string; ok: boolean; detail?: string }[] = [];
let watched: Page | null = null;                          // screenshot this page when a check fails
const logs: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}`); }
  catch (e) {
    results.push({ name, ok: false, detail: (e as Error).message });
    console.log(`FAIL  ${name}\n      ${(e as Error).message.split("\n")[0]}`);
    if (watched) {
      await watched.screenshot({ path: join(OUT, `fail-${results.length}.png`) }).catch(() => {});
      console.log(`      page says: ${(await watched.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(-220)}`);
    }
    if (logs.length) console.log(`      browser log: ${logs.splice(0).join(" | ").slice(0, 600)}`);
  }
}
const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8" });
const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

const port = await freePort();
const env = {
  ...process.env, MORNDO_HOME: HOME, MORNDO_PORT: String(port), MORNDO_ORIGIN: `http://localhost:${port}`,
  MORNDO_TMUX_SOCKET: SOCKET, MORNDO_POLL_MS: "300", MORNDO_QUIET_AFTER_MS: "2000",
};
const hubMain = join(ROOT, "apps/hub/src/main.ts");
let hub: ChildProcess | null = null;
async function startHub() {
  hub = spawn(process.execPath, [hubMain, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  hub.stderr?.on("data", d => { for (const l of String(d).split("\n")) if (l.includes("[hub]")) logs.push(l.trim()); });
  await new Promise<void>((resolve, reject) => {
    hub?.stdout?.on("data", d => { if (String(d).includes("morndo hub on")) resolve(); });
    hub?.once("exit", code => reject(new Error(`hub exited ${code}`)));
  });
}
const stopHub = () => new Promise<void>(resolve => { if (!hub) return resolve(); hub.once("exit", () => resolve()); hub.kill("SIGTERM"); hub = null; });
const pairUrl = () => {
  const out = execFileSync(process.execPath, [hubMain, "pair"], { env, encoding: "utf8" });
  const url = out.split("\n").find(l => l.includes("/pair#t="));
  assert(url, "morndo pair printed no URL");
  return url!.trim();
};

assert(existsSync(join(ROOT, "apps/web/build/200.html")), "build the web app first: npm run build");
tmux("new-session", "-d", "-s", "qa", "-n", "builder", "-x", "100", "-y", "30", "bash --norc --noprofile");
tmux("new-window", "-t", "qa", "-n", "reviewer", "bash --norc --noprofile");
tmux("send-keys", "-t", "qa:builder", "PS1='$ '; clear; echo 'synthetic worker: building the login page'", "Enter");
tmux("send-keys", "-t", "qa:reviewer", "PS1='$ '; clear; echo 'synthetic worker: reviewing change 42'", "Enter");

const browser = await chromium.launch();
try {
  await startHub();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", deviceScaleFactor: 2 });
  const page = await context.newPage();
  watched = page;
  page.on("console", m => { if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`); });
  page.on("pageerror", e => logs.push(`pageerror: ${e.message}`));
  page.on("response", r => { if (r.url().includes("/api/") && r.status() >= 400) logs.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } });

  const firstPairUrl = pairUrl();
  const fingerprint = new URL(firstPairUrl).hash.match(/f=([0-9a-f]{64})/)?.[1] ?? "";

  await check("pairing page shows the hub identity from the QR and drops the code from the address bar", async () => {
    await page.goto(firstPairUrl);
    await page.getByText("Check that your terminal or your other device shows this hub identity").waitFor();
    const shown = (await page.getByLabel("Hub identity").innerText()).replace(/\s/g, "");
    assert(shown === fingerprint, `fingerprint shown ${shown} != QR ${fingerprint}`);
    assert(!page.url().includes("#t="), `pairing code still in the URL: ${page.url()}`);
    await page.screenshot({ path: join(OUT, "1-pair.png") });
  });

  // A tap where the phone's tab bar shows (see e2e/phone-chat.e2e.ts tapTab: Playwright's own click scrolls a sticky
  // bar's static place into view first).
  const tapTab = async (name: string) => {
    const box = await page.locator("nav.tabbar button", { hasText: name }).boundingBox();
    assert(box !== null, `no ${name} tab`);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  await check("creating a passkey pairs the device and opens the phone; its Status tab lists the agents", async () => {
    await page.getByRole("button", { name: "Create passkey and pair" }).click();
    // Since ADR-0011 the phone opens on Chats; every agent's state is on the Status tab.
    await page.getByRole("navigation", { name: "Morndo" }).waitFor({ timeout: 10_000 });
    await page.locator("[data-chat]").first().waitFor({ timeout: 10_000 });
    await tapTab("Status");
    await page.locator('[data-status="builder"]').waitFor();
    await page.locator('[data-status="reviewer"]').waitFor();
    await page.locator(".conn.live").waitFor();
    await page.screenshot({ path: join(OUT, "2-agents.png") });
  });

  await check("a worker's screen shows and updates live", async () => {
    await page.locator('[data-status="builder"]').click();
    await page.getByRole("tab", { name: "Screen" }).click();
    await page.waitForFunction(() => document.querySelector("pre.screen")?.textContent?.includes("building the login page"), null, { timeout: 5000 });
    tmux("send-keys", "-t", "qa:builder", "echo 'step 2 of 3 done'", "Enter");
    await page.waitForFunction(() => document.querySelector("pre.screen")?.textContent?.includes("step 2 of 3 done"), null, { timeout: 5000 });
    await page.screenshot({ path: join(OUT, "3-screen.png") });
  });

  await check("the status view marks a changing worker working, then not", async () => {
    await page.getByRole("button", { name: "Back to chats" }).click();
    await tapTab("Status");
    tmux("send-keys", "-t", "qa:builder", "echo 'still working'", "Enter");
    await page.locator('[data-status="builder"].working').waitFor({ timeout: 5000 });
    await page.locator('[data-status="builder"]:not(.working)').waitFor({ timeout: 8000 });
  });

  await check("going offline and back reconnects and catches up", async () => {
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    tmux("rename-window", "-t", "qa:reviewer", "reviewer-2");
    await context.setOffline(false);
    await page.getByText("reviewer-2").waitFor({ timeout: 15_000 });
    await page.locator(".conn.live").waitFor({ timeout: 15_000 });
  });

  await check("the same pairing code can't pair a second device", async () => {
    const other = await context.newPage();
    await other.goto(firstPairUrl);
    // The page asks the hub about its link first (ADR-0008 phase E), so a used one says so before any passkey prompt.
    await other.getByText("already used").waitFor({ timeout: 5000 });
    assert(await other.getByRole("button", { name: "Create passkey and pair" }).count() === 0, "a used link still offers pairing");
    // And the hub itself refuses it, whatever a page shows.
    const token = new URLSearchParams(new URL(firstPairUrl).hash.slice(1)).get("t") ?? "";
    const r = await other.evaluate(t => fetch("/api/pair/options", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: t, name: "again" }) }).then(async x => ({ status: x.status, body: await x.json() as unknown })), token);
    assert(r.status === 400 && JSON.stringify(r.body) === JSON.stringify({ error: "used" }), `the hub answered ${r.status} ${JSON.stringify(r.body)}`);
    await other.close();
  });

  await check("sign out, then unlock again with the passkey", async () => {
    await page.goto(`http://localhost:${port}/devices`);
    await page.getByText("this device", { exact: true }).waitFor();          // the tag, not "Notifications on this device"
    await page.screenshot({ path: join(OUT, "4-devices.png") });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("button", { name: "Unlock with passkey" }).click();
    await page.getByRole("navigation", { name: "Morndo" }).waitFor({ timeout: 10_000 });
  });

  await check("revoking this device signs it out and its passkey no longer unlocks", async () => {
    await page.goto(`http://localhost:${port}/devices`);
    await page.getByRole("button", { name: "Revoke…" }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByRole("button", { name: "Unlock with passkey" }).click();
    await page.getByText("was revoked").waitFor({ timeout: 5000 });
    await page.screenshot({ path: join(OUT, "5-revoked.png") });
  });

  await check("a hub with a different identity is a hard stop", async () => {
    await stopHub();
    unlinkSync(join(HOME, "hub-identity.pem"));
    await startHub();
    await page.goto(`http://localhost:${port}/`);
    await page.getByText("The hub's identity changed").waitFor({ timeout: 5000 });
    assert(!(await page.getByRole("button", { name: "Unlock with passkey" }).isVisible()), "unlock offered despite the mismatch");
    await page.screenshot({ path: join(OUT, "6-identity-changed.png") });
  });

  await check("the app shows no console errors or CSP violations", async () => {
    const errors: string[] = [];
    const fresh = await context.newPage();
    fresh.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    fresh.on("pageerror", e => errors.push(e.message));
    await fresh.goto(`http://localhost:${port}/`);
    await fresh.getByText("The hub's identity changed").waitFor();
    assert(errors.length === 0, errors.join(" | "));
  });
} finally {
  await browser.close();
  await stopHub();
  try { tmux("kill-server"); } catch { /* already gone */ }
  rmSync(HOME, { recursive: true, force: true });
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`);
process.exit(failed.length ? 1 : 0);
