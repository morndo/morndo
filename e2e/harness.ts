// Shared e2e harness for the checks added with ADR-0008: a synthetic office (office.ts) with its own hub on its own
// port and tmux server, browsers paired through Chromium's virtual WebAuthn authenticator, and PASS/FAIL bookkeeping.
// Nothing here reads or touches the real lanes, the real hub or its data.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { buildOffice } from "./office.ts";

const ROOT = join(import.meta.dirname, "..");
export const HUB_MAIN = join(ROOT, "apps/hub/src/main.ts");

export const freePort = () => new Promise<number>(r => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); });
});

export function checks(out: string) {
  const results: { name: string; ok: boolean }[] = [];
  let watched: Page | null = null;
  return {
    watch: (p: Page | null) => { watched = p; },
    check: async (name: string, fn: () => Promise<void>) => {
      try { await fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}`); }
      catch (e) {
        results.push({ name, ok: false });
        console.log(`FAIL  ${name}\n      ${(e as Error).message.split("\n")[0]}`);
        if (watched) await watched.screenshot({ path: join(out, `fail-${results.length}.png`) }).catch(() => {});
      }
    },
    // Prints the total; the exit code is 1 if anything failed.
    finish: (): number => {
      const passed = results.filter(r => r.ok).length;
      console.log(`\n${passed}/${results.length} checks passed. Screenshots: ${out}`);
      return passed === results.length && results.length > 0 ? 0 : 1;
    },
  };
}
export const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };

export type Office = Awaited<ReturnType<typeof startOffice>>;

// A synthetic office and its own hub, started and ready.
// `extraEnv`: more settings for this office's hub (a test's own push service, say).
export async function startOffice(name: string, extraEnv: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), `morndo-${name}-`));
  const socket = `morndo-${name}-${process.pid}`;
  const port = await freePort();
  const office = buildOffice({ home, socket, vncPort: await freePort() });
  // The offices' worker menus and questions reach the principal at once (N2's 10-minute grace would hold them), unless
  // a test sets its own value in `extraEnv`.
  const env = { ...process.env, ...office.env(port), MORNDO_WORKER_ASK_GRACE_MS: "0", ...extraEnv };
  let hub: ChildProcess | null = null;
  const log = join(home, "hub.log");
  const startHub = async () => {
    const child = spawn(process.execPath, ["--no-warnings", HUB_MAIN, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
    hub = child;
    child.stderr?.on("data", d => appendFileSync(log, d));
    await new Promise<void>((res, rej) => {
      child.stdout?.on("data", d => { appendFileSync(log, d); if (String(d).includes("morndo hub on")) res(); });
      child.once("exit", c => rej(new Error(`hub exited ${c}`)));
    });
  };
  await startHub();
  const tmux = (...a: string[]) => execFileSync("tmux", ["-L", socket, ...a], { encoding: "utf8" });
  return {
    home, port, office, env, tmux, log,
    base: `http://localhost:${port}`,
    pairUrl: () => execFileSync(process.execPath, ["--no-warnings", HUB_MAIN, "pair"], { env, encoding: "utf8" }).split("\n").find(l => l.includes("/pair#t="))?.trim() ?? "",
    // Stops the hub process (as a crash or a deploy would) and starts it again on the same data.
    async restartHub(signal: NodeJS.Signals = "SIGKILL") {
      const h = hub;
      if (h) { const gone = new Promise(r => h.once("exit", r)); h.kill(signal); await gone; }
      await startHub();
    },
    stop() {
      hub?.kill("SIGTERM");
      office.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export type Paired = { context: BrowserContext; page: Page; cdp: CDPSession; errors: string[] };

// A new browser context paired with the office's hub (a fresh console token, a virtual authenticator with user
// verification), on the desktop client. `errors` collects console errors and uncaught exceptions.
// `serviceWorkers: "block"` for a check that intercepts requests: Playwright's routing doesn't see requests made under a
// service worker (https://playwright.dev/docs/service-workers-experimental).
// `ready`: what shows once paired (the desktop's frame by default; the phone's tab bar on a narrow screen, ADR-0009).
// `phone`: a touch screen with a phone's viewport rules (Playwright's hasTouch and isMobile).
export async function pairedPage(browser: Browser, office: Pick<Office, "pairUrl">, o: {
  width?: number; height?: number; colorScheme?: "light" | "dark"; serviceWorkers?: "allow" | "block"; ready?: string; phone?: boolean; reducedMotion?: "reduce" | "no-preference"; init?: () => void;
} = {}): Promise<Paired> {
  const context = await browser.newContext({
    viewport: { width: o.width ?? 1920, height: o.height ?? 908 }, colorScheme: o.colorScheme ?? "light", serviceWorkers: o.serviceWorkers ?? "allow",
    ...(o.phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}), ...(o.reducedMotion ? { reducedMotion: o.reducedMotion } : {}),
  });
  if (o.init) await context.addInitScript(o.init);           // runs before the app on every page of this context
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push(e.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(office.pairUrl());
  await page.getByRole("button", { name: "Create passkey and pair" }).click();
  await page.locator(o.ready ?? ".desk").first().waitFor({ timeout: 15_000 });
  return { context, page, cdp, errors };
}

// A device not paired yet: its own context and its own virtual authenticator (ADR-0008 phase E: adding a device). And
// its own caller for the hub's per-caller limits: every browser here comes from one address, and the checks pair
// devices faster than one person would (in production one person's devices share one bucket: 10 at once, then 10 a
// minute).
let devices = 0;
export async function newDevice(browser: Browser, o: { width?: number; height?: number; serviceWorkers?: "allow" | "block" } = {}): Promise<Paired> {
  const context = await browser.newContext({
    viewport: { width: o.width ?? 1280, height: o.height ?? 860 }, serviceWorkers: o.serviceWorkers ?? "allow",
    extraHTTPHeaders: { "tailscale-user-login": `device-${++devices}@example.test` },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push(e.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { context, page, cdp, errors };
}

export function outDir(name: string) {
  const out = process.env.E2E_OUT ?? mkdtempSync(join(tmpdir(), `morndo-${name}-out-`));
  mkdirSync(out, { recursive: true });
  return out;
}
