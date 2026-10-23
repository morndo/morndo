// End-to-end check of the Slack-style desktop client (ADR-0006) on synthetic agents only: a private tmux server,
// synthetic Claude Code session files, the real hub and built app, headless Chromium at Slack's measured 1920x908.
// Also measures the layout against the Slack metrics recorded in ADR-0006. Run: npm run build && node e2e/desktop.e2e.ts
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { themes } from "@morndo/brand";
import { buildOffice } from "./office.ts";

const ROOT = join(import.meta.dirname, "..");
const OUT = process.env.E2E_OUT ?? mkdtempSync(join(tmpdir(), "morndo-desk-out-"));
const HOME = mkdtempSync(join(tmpdir(), "morndo-desk-"));
const SOCKET = `morndo-desk-${process.pid}`;
mkdirSync(OUT, { recursive: true });

const results: { name: string; ok: boolean }[] = [];
const skipped: string[] = [];
let watched: Page | null = null;
// A check this machine can't run, said with its reason, never silently (ADR-0008 phase G: CI has no VNC desktop).
function skip(name: string, reason: string) { skipped.push(name); console.log(`SKIP  ${name}\n      ${reason}`); }
const NO_VNC = process.env.MORNDO_E2E_NO_VNC === "1";
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}`); }
  catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${(e as Error).message.split("\n")[0]}`);
    if (watched) await watched.screenshot({ path: join(OUT, `fail-${results.length}.png`) }).catch(() => {});
  }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const tmux = (...a: string[]) => execFileSync("tmux", ["-L", SOCKET, ...a], { encoding: "utf8" });
const freePort = () => new Promise<number>(r => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

const port = await freePort();
const office = buildOffice({ home: HOME, socket: SOCKET, vncPort: await freePort() });
const { panes, ledger, writeLedger, line: L, claudeDir: CLAUDE, env: officeEnv } = office;

// MORNDO_WORKER_ASK_GRACE_MS=0: this file checks the reviewer's question as a decision; N2's 10-minute grace would
// hold a freshly asked one (as harness.ts does for every startOffice office).
const env = { ...process.env, ...officeEnv(port), MORNDO_WORKER_ASK_GRACE_MS: "0" };
const hubMain = join(ROOT, "apps/hub/src/main.ts");
let hub: ChildProcess | null = spawn(process.execPath, [hubMain, "serve"], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((res, rej) => { hub?.stdout?.on("data", d => { if (String(d).includes("morndo hub on")) res(); }); hub?.once("exit", c => rej(new Error(`hub exited ${c}`))); });
const pairUrl = execFileSync(process.execPath, [hubMain, "pair"], { env, encoding: "utf8" }).split("\n").find(l => l.includes("/pair#t="))?.trim() ?? "";

const browser = await chromium.launch();
try {
  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 908 }, colorScheme: scheme });
    const page = await context.newPage();
    watched = page;
    const flowErrors: string[] = [];                                     // console errors and CSP violations during the whole flow
    page.on("console", m => { if (m.type() === "error") flowErrors.push(m.text()); });
    page.on("pageerror", e => flowErrors.push(e.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    const url = scheme === "light" ? pairUrl : execFileSync(process.execPath, [hubMain, "pair"], { env, encoding: "utf8" }).split("\n").find(l => l.includes("/pair#t="))?.trim() ?? "";
    await page.goto(url);
    await page.getByRole("button", { name: "Create passkey and pair" }).click();
    await page.locator(".desk").waitFor({ timeout: 10_000 });

    if (scheme === "dark") {
      await page.getByRole("button", { name: "Manager", exact: true }).first().click();
      await page.getByText("three").waitFor();
      await page.screenshot({ path: join(OUT, "desktop-dark.png") });
      await page.locator(".rail").getByRole("button", { name: /Decisions/ }).click();
      await page.getByRole("complementary", { name: "Decisions" }).locator("[data-decision]").first().waitFor();
      await page.screenshot({ path: join(OUT, "decisions-dark.png") });
      await context.close();
      continue;
    }

    await check("the sidebar shows the manager as a direct message and agents by what they do", async () => {
      await page.locator("aside.side").getByText("Direct messages").waitFor();
      await page.locator("aside.side").getByText("Manager", { exact: true }).waitFor();
      await page.locator("aside.side").getByText("builder", { exact: true }).waitFor();
      await page.locator("aside.side").getByText("reviewer", { exact: true }).waitFor();
    });

    await check("the right panel is open by default with Decisions, stays open across chats, and the header toggle hides and shows it", async () => {
      const panel = page.getByRole("complementary", { name: "Decisions" });
      await panel.locator("[data-decision]").first().waitFor({ timeout: 8000 });
      for (const name of [/Manager/, /builder/, /reviewer/]) {
        await page.locator("aside.side").getByRole("button", { name }).first().click();
        assert(await panel.isVisible(), `the panel closed when opening ${name}`);
      }
      await page.getByRole("button", { name: "Hide the right panel" }).click();
      await panel.waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Show the right panel" }).click();
      await panel.locator("[data-decision]").first().waitFor();
    });

    await check("the manager's conversation renders: markdown, folded tool use, status pill, the manager's prefix", async () => {
      await page.locator("aside.side").getByRole("button", { name: /Manager/ }).first().click();
      await page.locator(".md strong", { hasText: "three" }).waitFor({ timeout: 8000 });
      await page.getByText("Used Bash, Read ×2").waitFor();
      await page.locator(".status.decision", { hasText: "Needs decision" }).waitFor();
      assert(await page.locator("h1", { hasText: "Manager" }).isVisible(), "channel header missing");
      await page.screenshot({ path: join(OUT, "desktop-manager.png") });
    });

    await check("an agent with an open question is marked, counted in Activity, and shows the question", async () => {
      await page.locator("aside.side").getByRole("button", { name: /reviewer/ }).locator(".badge").waitFor({ timeout: 8000 });
      const railCount = await page.locator(".rail").getByRole("button", { name: /Activity/ }).locator(".badge").innerText();
      assert(railCount.trim() === "1", `rail activity count ${railCount}`);
      await page.locator("aside.side").getByRole("button", { name: /reviewer/ }).click();
      await page.locator(".chan").getByText("Keep the old endpoint for one more release?").waitFor();
      await page.locator(".state.needs").waitFor();
      await page.locator(".rail").getByRole("button", { name: /Activity/ }).click();
      await page.getByText("Waiting for you").waitFor();
      await page.screenshot({ path: join(OUT, "desktop-activity.png") });
    });

    await check("a message typed in the composer reaches the agent's terminal", async () => {
      await page.locator("aside.side").getByRole("button", { name: /builder/ }).click();
      await page.getByText("14 of 14 tests pass").waitFor({ timeout: 8000 });
      const pill = page.locator(".status.done");                            // the agent's own DONE is a claim, not a success
      assert((await pill.innerText()).trim() === "Says done", `the done pill reads "${await pill.innerText()}"`);
      const colors = await pill.evaluate(e => {
        const probe = document.createElement("span");
        probe.style.color = "var(--ok-fg)";                                 // the success color, resolved like the pill's
        e.parentElement!.appendChild(probe);
        const ok = getComputedStyle(probe).color;
        probe.remove();
        return { pill: getComputedStyle(e).color, ok };
      });
      assert(colors.pill !== colors.ok, `the claim is colored as success: ${JSON.stringify(colors)}`);
      await page.locator("#composer").fill("echo hello-from-morndo-$((6*7))");
      await page.keyboard.press("Enter");
      const deadline = Date.now() + 6000;
      let screen = "";
      while (Date.now() < deadline && !screen.includes("hello-from-morndo-42")) { await page.waitForTimeout(300); screen = tmux("capture-pane", "-p", "-t", panes.builder ?? ""); }
      assert(screen.includes("hello-from-morndo-42"), "text did not arrive in the pane");
    });

    await check("a pasted or attached image reaches the agent as a file it can open, without the photo's metadata", async () => {
      await page.locator("aside.side").getByRole("button", { name: /builder/ }).click();
      await page.locator("h1", { hasText: "builder" }).waitFor();
      tmux("send-keys", "-t", panes.builder ?? "", "clear", "Enter");
      // A real PNG drawn on a canvas, pasted the way a screenshot is: a clipboard event carrying a file.
      await page.locator("#composer").evaluate(async el => {
        const c = document.createElement("canvas"); c.width = 64; c.height = 32;
        const g = c.getContext("2d")!; g.fillStyle = "#f0a150"; g.fillRect(0, 0, 64, 32);
        const blob: Blob = await new Promise(r => c.toBlob(b => r(b!), "image/png"));
        const dt = new DataTransfer();
        dt.items.add(new File([blob], "screenshot.png", { type: "image/png" }));
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      // A JPEG with location data, attached with the paperclip; then a text file, which is refused.
      const seg = (marker: number, payload: string) => { const p = Buffer.from(payload, "latin1"); const h = Buffer.from([0xff, marker, 0, 0]); h.writeUInt16BE(p.length + 2, 2); return Buffer.concat([h, p]); };
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, "JFIF\0\x01\x01"), seg(0xe1, "Exif\0\0GPSLatitude 52.52"), Buffer.from([0xff, 0xda, 0, 2]), Buffer.from("scan"), Buffer.from([0xff, 0xd9])]);
      const input = page.locator('.box input[type="file"]');
      await input.setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: jpeg });
      await page.locator(".shots .shot.ready").nth(1).waitFor({ timeout: 6000 });
      await input.setInputFiles({ name: "run.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
      await page.getByText("run.exe can't be attached").waitFor();
      assert(await page.locator(".shots .shot, .shots .filechip").count() === 2, "the executable was attached");
      await page.screenshot({ path: join(OUT, "paste-composer.png") });
      await page.locator("#composer").fill("what is wrong here?");
      await page.keyboard.press("Enter");
      await page.locator(".pending .sent-images img").nth(1).waitFor({ timeout: 4000 });
      const deadline = Date.now() + 8000;
      let screen = "";
      while (Date.now() < deadline && (screen.match(/\[The owner attached a file: /g) ?? []).length < 2) { await page.waitForTimeout(300); screen = tmux("capture-pane", "-p", "-J", "-t", panes.builder ?? "", "-S", "-40"); }
      assert(screen.includes("what is wrong here?"), "the text didn't reach the pane");
      const paths = [...screen.matchAll(/\[The owner attached a file: (\/[^\]]+)\]/g)].map(m => m[1] ?? "");
      assert(paths.length === 2 && paths[0]!.endsWith(".png") && paths[1]!.endsWith(".jpg"), `notes in the pane: ${JSON.stringify(paths)}`);
      const pngBytes = readFileSync(paths[0]!), jpgBytes = readFileSync(paths[1]!);
      assert(pngBytes.subarray(1, 4).toString() === "PNG" && (statSync(paths[0]!).mode & 0o777) === 0o600, "the PNG isn't saved as sent, for this user only");
      assert(!jpgBytes.toString("latin1").includes("GPS") && jpgBytes.toString("latin1").includes("JFIF"), "the photo kept its location data");
      assert(paths.every(p => p.startsWith(join(office.files, "inbox"))), "the images were saved outside the inbox");
      await page.screenshot({ path: join(OUT, "paste-sent.png") });
    });

    await check("files and images agents send render in the chat; the hub serves only its copies, never as a page", async () => {
      await page.locator("aside.side").getByRole("button", { name: /builder/ }).click();
      const pane = page.locator(".pane");
      const img = pane.locator(".files img").first();
      await img.waitFor({ timeout: 8000 });
      await img.scrollIntoViewIfNeeded();
      await page.waitForFunction(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth === 320, await img.elementHandle());
      await pane.getByText("The login page, before and after").waitFor();
      await page.screenshot({ path: join(OUT, "files-chat.png") });
      await pane.getByRole("button", { name: "Open login-before-after.png" }).click();
      const viewer = page.getByRole("dialog", { name: "login-before-after.png" });
      await viewer.waitFor();
      await page.screenshot({ path: join(OUT, "files-viewer.png") });
      await page.keyboard.press("Escape");
      await viewer.waitFor({ state: "detached" });
      const notes = pane.locator(".att", { hasText: "release-notes.md" });
      await notes.getByRole("button", { name: "Preview" }).click();
      await notes.locator(".preview .md h1", { hasText: "Release notes" }).waitFor();
      await notes.locator(".preview .md td", { hasText: "green" }).waitFor();
      const log = pane.locator(".att", { hasText: "build.log" });
      await log.getByRole("button", { name: "Preview" }).click();
      await log.locator(".preview pre", { hasText: "compiled 128 modules" }).waitFor();
      assert(await pane.locator(".att", { hasText: "spec.pdf" }).getByRole("link", { name: "Open" }).count() === 1, "the PDF has no Open link");
      const bin = await pane.locator(".att", { hasText: "bundle.bin" }).getByRole("link", { name: "Download bundle.bin" }).getAttribute("href");
      assert(bin?.endsWith("?download=1"), `download link ${bin}`);
      await pane.locator(".att.gone", { hasText: "gone.png" }).getByText(/Not available/).waitFor();
      await page.screenshot({ path: join(OUT, "files-cards.png") });
      // The served copies: a hostile SVG opened as a page runs nothing; unknown ids and paths are 404.
      const svgSrc = await pane.locator('.files img[alt="evil.svg"]').getAttribute("src");
      const p2 = await context.newPage();
      const resp = await p2.goto(`http://localhost:${port}${svgSrc}`);
      assert(/sandbox/.test(resp?.headers()["content-security-policy"] ?? "") && resp?.headers()["x-content-type-options"] === "nosniff", "the SVG isn't sandboxed");
      assert(await p2.evaluate(() => (window as unknown as { __ran?: number }).__ran) === undefined, "the SVG's script ran in the hub's origin");
      await p2.goto(`http://localhost:${port}/`);                          // the 404s below belong to this page, not the flow's
      const codes = await p2.evaluate(async () => Promise.all([`/api/files/${"0".repeat(32)}`, "/api/files/..%2f..%2fetc%2fpasswd", "/api/files/abc"].map(u => fetch(u).then(r => r.status))));
      await p2.close();
      assert(codes.every(c => c === 404), `unknown files answered ${codes.join(",")}`);
      // The principal's own attachment, in the reviewer's channel: the image, without the chat bot's note.
      await page.locator("aside.side").getByRole("button", { name: /reviewer/ }).click();
      const mine = page.locator(".pane .msg", { hasText: "This is what I see on my phone" });
      await mine.locator(".files img").waitFor({ timeout: 8000 });
      assert(!(await page.locator(".pane").innerText()).includes("[The owner attached a file"), "the chat bot's note is shown");
    });

    await check("the Terminal tab shows the agent's tmux pane live; typing reaches it only after Take control", async () => {
      await page.locator("aside.side").getByRole("button", { name: /builder/ }).click();
      await page.locator("h1", { hasText: "builder" }).waitFor();
      const tabs = page.locator(".chan .tabs");
      assert(!(await tabs.getByRole("tab", { name: "Screen" }).count()), "the old Screen tab is still there");
      await tabs.getByRole("tab", { name: "Terminal" }).click();
      const term = page.getByRole("region", { name: "Terminal of #builder" });
      tmux("send-keys", "-t", panes.builder ?? "", "echo terminal-ready-$((6*7))", "Enter");   // its own marker, whatever ran before
      await term.locator(".xterm-rows", { hasText: "terminal-ready-42" }).waitFor({ timeout: 8000 });
      await term.getByText("Watching #builder's terminal").waitFor();
      const bar = await term.getByRole("button", { name: "Take control" }).evaluate(b => Math.round(b.getBoundingClientRect().height));
      assert(bar === 28, `the control bar's button is ${bar}px tall, not 28`);
      await term.locator(".xterm").click();
      await page.keyboard.type("echo watch-only-$((1+1))");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(800);
      assert(!tmux("capture-pane", "-p", "-t", panes.builder ?? "").includes("watch-only"), "keys reached the pane while only watching");
      await term.getByRole("button", { name: "Take control" }).click();
      await term.getByText("You're in control of #builder's terminal").waitFor({ timeout: 6000 });
      await page.keyboard.type("echo term-$((6*7))");
      await page.keyboard.press("Enter");
      const deadline = Date.now() + 6000;
      let screen = "";
      while (Date.now() < deadline && !screen.includes("term-42")) { await page.waitForTimeout(200); screen = tmux("capture-pane", "-p", "-t", panes.builder ?? ""); }
      assert(screen.includes("term-42"), "typed keys did not reach the pane under control");
      await term.locator(".xterm-rows", { hasText: "term-42" }).waitFor({ timeout: 4000 });
      await page.screenshot({ path: join(OUT, "terminal-control.png") });
      await term.getByRole("button", { name: "Release control" }).click();
      await term.getByText("Watching #builder's terminal").waitFor();
      // A pane as wide as the real agents' (200x50) beside the decisions panel: scaled to fit, never cut off.
      tmux("resize-window", "-t", "qa:worker-01", "-x", "200", "-y", "50");
      tmux("send-keys", "-t", "qa:worker-01", `printf 'L%.0s' {1..199}; echo R`, "Enter");
      await page.setViewportSize({ width: 1600, height: 900 });         // the panel beside: about 760px for 200 columns
      await page.locator("aside.side").getByRole("button", { name: /worker-01/ }).click();
      await tabs.getByRole("tab", { name: "Terminal" }).click();
      const wide = page.getByRole("region", { name: "Terminal of #worker-01" });
      await wide.locator(".xterm-rows", { hasText: "LLLLR" }).waitFor({ timeout: 8000 });
      await page.waitForTimeout(400);
      const fit = await wide.evaluate(el => { const s = el.querySelector(".xterm-screen")!.getBoundingClientRect(), b = el.querySelector(".box")!.getBoundingClientRect(); return { s: [s.left, s.right, s.bottom].map(Math.round), b: [b.left, b.right, b.bottom].map(Math.round) }; });
      assert(fit.s[0]! >= fit.b[0]! && fit.s[1]! <= fit.b[1]! && fit.s[2]! <= fit.b[2]!, `a 200-column pane is cut off: ${JSON.stringify(fit)}`);
      await wide.getByRole("button", { name: "Full screen to read" }).waitFor();   // shrunk: the way to read it is offered
      await page.screenshot({ path: join(OUT, "terminal-wide.png") });
      await page.setViewportSize({ width: 1920, height: 908 });
      await tabs.getByRole("tab", { name: "Messages" }).click();
    });

    const vncCheck = "the Desktop tab shows the desktop over VNC; watching drops input, control passes it";
    if (NO_VNC) skip(vncCheck, "MORNDO_E2E_NO_VNC=1: this machine has no VNC desktop to show (it needs TigerVNC's Xtigervnc and vncpasswd)");
    else await check(vncCheck, async () => {
      const desk = office.desktop;
      assert(desk, "no private VNC desktop (TigerVNC missing)");
      if (!desk) return;
      const dialog = desk.dialog();
      let dialogClosed = false;
      dialog.once("exit", () => { dialogClosed = true; });
      await page.waitForTimeout(500);
      await page.locator(".chan .tabs").getByRole("tab", { name: "Desktop" }).click();
      const view = page.getByRole("region", { name: "Desktop" });
      await view.locator(".status.live").waitFor({ timeout: 10_000 });
      await view.locator("canvas").waitFor();
      await page.waitForTimeout(1200);
      const px = await view.locator("canvas").evaluate((c: HTMLCanvasElement) => [...c.getContext("2d")!.getImageData(5, 5, 1, 1).data]);
      assert(px[0]! > 200 && px[1]! > 100 && px[1]! < 170 && px[2]! < 60, `the desktop's orange background didn't arrive: rgba ${[...px].join(",")}`);
      await page.screenshot({ path: join(OUT, "desktop-watch.png") });
      const box = (await view.locator("canvas").boundingBox())!;
      const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.click(center.x, center.y);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1000);
      assert(!dialogClosed, "the desktop took input while only watching");
      await view.getByRole("button", { name: "Take control" }).click();
      await view.getByText("You're in control of the desktop").waitFor({ timeout: 8000 });
      await page.waitForTimeout(500);
      await page.mouse.move(center.x, center.y);
      await page.mouse.click(center.x, center.y);
      await page.keyboard.press("Enter");
      const until = Date.now() + 6000;
      while (!dialogClosed && Date.now() < until) await page.waitForTimeout(200);
      if (!dialogClosed) dialog.kill();
      assert(dialogClosed, "a click and Enter under control didn't reach the desktop");
      await page.screenshot({ path: join(OUT, "desktop-control.png") });
      await view.getByRole("button", { name: "Release control" }).click();
      await view.getByText("Watching the desktop").waitFor();
      const audit = execFileSync(process.execPath, [hubMain, "audit", "20"], { env, encoding: "utf8" });
      assert(/ControlStarted.*"desktop"/.test(audit) && /ControlEnded.*"released"/.test(audit), "control start or end not in the audit");
      await page.locator(".chan .tabs").getByRole("tab", { name: "Messages" }).click();
    });

    await check("clean by default: no [quiet] markers or lane-event plumbing in the chat", async () => {
      await page.locator("aside.side").getByRole("button", { name: /Manager/ }).first().click();
      await page.getByRole("heading", { name: "Studio: retry" }).waitFor({ timeout: 8000 });
      const pane = await page.locator(".pane").innerText();
      assert(!pane.includes("[quiet]"), "[quiet] marker shown");
      assert(!pane.includes("Lane events arrived"), "lane-event plumbing shown");
    });

    await check("right-click opens a Slack-sized menu; verbose shows everything, clean hides it again", async () => {
      await page.locator("aside.side").getByRole("button", { name: /Manager/ }).first().click({ button: "right" });
      const menu = page.getByRole("menu", { name: "Manager options" });
      await menu.waitFor();
      const mm = await page.evaluate(() => {
        const m = document.querySelector(".menu") as HTMLElement, it = m.querySelector(".it") as HTMLElement, c = getComputedStyle(it);
        return { w: Math.round(m.getBoundingClientRect().width), radius: getComputedStyle(m).borderRadius, padTop: getComputedStyle(m).paddingTop,
          itemH: Math.round(it.getBoundingClientRect().height), font: `${c.fontWeight} ${c.fontSize}/${c.lineHeight}`, pad: c.padding };
      });
      const expect = { w: 300, radius: "4px", padTop: "12px", itemH: 28, font: "400 15px/28px", pad: "0px 24px" };
      assert(JSON.stringify(mm) === JSON.stringify(expect), `menu metrics ${JSON.stringify(mm)} != ${JSON.stringify(expect)}`);
      await page.screenshot({ path: join(OUT, "desktop-menu.png") });
      await menu.getByRole("menuitemradio", { name: "Everything (verbose)" }).click();
      await page.getByText("[quiet]").first().waitFor({ timeout: 4000 });
      await page.getByText("Lane events arrived").waitFor();
      await page.locator("aside.side").getByRole("button", { name: /Manager/ }).first().click({ button: "right" });
      await page.getByRole("menuitemradio", { name: "Answers only" }).click();
      await page.getByText("Lane events arrived").waitFor({ state: "detached", timeout: 4000 });
    });

    await check("the details modal matches Slack's measurements, and its settings apply", async () => {
      await page.locator("aside.side").getByRole("button", { name: /builder/ }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Conversation details" }).click();
      const dlg = page.getByRole("dialog", { name: "builder details" });
      await dlg.waitFor();
      await dlg.getByText("Build the login page").waitFor();
      const md = await page.evaluate(() => {
        const q = (s: string) => document.querySelector(s) as HTMLElement, st = (s: string) => getComputedStyle(q(s));
        const r = (s: string) => q(s).getBoundingClientRect();
        return { w: Math.round(r(".modal").width), h: Math.round(r(".modal").height), radius: st(".modal").borderRadius,
          title: `${st(".modal h2").fontWeight} ${st(".modal h2").fontSize}/${st(".modal h2").lineHeight}`, close: `${Math.round(r(".close").width)}x${Math.round(r(".close").height)}`,
          action: Math.round(r(".ob").height), tabs: Math.round(r(".modal .tabs").height), tab: `${st(".modal .tabs button").fontWeight} ${st(".modal .tabs button").fontSize}/${st(".modal .tabs button").lineHeight}`,
          card: st(".card").borderRadius, field: st(".field").padding, label: `${st(".field strong").fontWeight} ${st(".field strong").fontSize}/${st(".field strong").lineHeight}`,
          body: st(".modal .body").backgroundColor };
      });
      const want = { w: 580, h: 772, radius: "8px", title: "900 22px/30px", close: "36x36", action: 28, tabs: 36, tab: "700 13px/18px",
        card: "12px", field: "16px 20px", label: "700 15px/22px", body: `rgb(${[1, 3, 5].map(i => parseInt(themes.light.bg.slice(i, i + 2), 16)).join(", ")})` };   // the page background under the cards (Ink rule 11)
      assert(JSON.stringify(md) === JSON.stringify(want), `modal metrics ${JSON.stringify(md)} != ${JSON.stringify(want)}`);
      await page.screenshot({ path: join(OUT, "desktop-modal-about.png") });
      await dlg.getByRole("tab", { name: "Settings" }).click();
      await dlg.getByRole("switch", { name: "Mute conversation" }).click();
      await page.waitForTimeout(300);
      const sw = await page.evaluate(() => ({ muted: (document.querySelector("#pref-muted") as HTMLInputElement).checked, activity: (document.querySelector("#pref-activity") as HTMLInputElement).checked }));
      assert(sw.muted && sw.activity, `switch states after muting: ${JSON.stringify(sw)}`);
      await page.screenshot({ path: join(OUT, "desktop-modal-settings.png") });
      await page.keyboard.press("Escape");
      await dlg.waitFor({ state: "detached" });
      const op = await page.locator("aside.side").getByRole("button", { name: /builder/ }).evaluate(e => getComputedStyle(e).opacity);
      assert(op === "0.5", `muted row opacity ${op}`);
    });

    await check("star moves an agent into Starred; the channel name opens the details too", async () => {
      await page.locator("aside.side").getByRole("button", { name: /reviewer/ }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Star conversation" }).click();
      await page.locator("aside.side").getByText("Starred").waitFor();
      await page.locator("aside.side").getByRole("button", { name: /reviewer/ }).click();
      await page.getByRole("button", { name: "reviewer: conversation details" }).click();
      await page.getByRole("dialog", { name: "reviewer details" }).waitFor();
      await page.keyboard.press("Escape");
    });

    await check("security preferences: hourly and 7 days by default; loosening right after sign-in is saved; tightening never asks for the passkey", async () => {
      await page.locator("aside.side").getByRole("button", { name: /Manager/ }).first().click();
      await page.getByText(/Verified · (59|60) min left/).waitFor();
      await page.getByRole("button", { name: "Preferences" }).click();
      const dlg = page.getByRole("dialog", { name: "Preferences" });
      await dlg.waitFor();
      assert(await dlg.locator("#stepup-1h").isChecked(), "default is not hourly");
      assert(await dlg.locator("#stay-7d").isChecked(), "default sign-in is not 7 days");
      const stepUps: number[] = [];
      const onResp = (r: import("playwright").Response) => { if (r.url().endsWith("/api/stepup/verify")) stepUps.push(r.status()); };
      page.on("response", onResp);
      await dlg.locator("#stepup-signin").check();
      await page.waitForTimeout(800);
      assert(await dlg.locator("#stepup-signin").isChecked(), "'only when I sign in' was not saved");
      await page.screenshot({ path: join(OUT, "desktop-preferences.png") });
      const afterLoosening = stepUps.length;
      await dlg.locator("#stay-12h").check();                             // stricter: no passkey needed
      await page.waitForTimeout(500);
      assert(await dlg.locator("#stay-12h").isChecked(), "12 hours was not saved");
      page.off("response", onResp);
      assert(stepUps.length === afterLoosening, `tightening asked for the passkey (${stepUps.length - afterLoosening} times)`);
      await page.keyboard.press("Escape");
      await page.getByText("Signed in with your passkey").waitFor();
      const policy = await page.evaluate(() => fetch("/api/policy").then(r => r.json()));
      assert(policy.policy.stepUp === "signin" && policy.policy.stay === "12h", `hub policy ${JSON.stringify(policy.policy)}`);
    });

    await check("decisions land in the right-hand panel: counts, urgency, the list's question, the terms and the options", async () => {
      await page.locator("aside.side").getByRole("button", { name: /Manager/ }).first().click();
      const railBadge = page.locator(".rail").getByRole("button", { name: /Decisions/ }).locator(".badge");
      await railBadge.waitFor({ timeout: 8000 });
      assert((await railBadge.innerText()).trim() === "3", `rail decisions badge ${await railBadge.innerText()}`);   // ny-7, ny-8, the reviewer's question
      await page.locator(".rail").getByRole("button", { name: /Decisions/ }).click();
      const panel = page.getByRole("complementary", { name: "Decisions" });
      await panel.waitFor();
      const tiles = await panel.locator(".tile b").allInnerTexts();
      assert(JSON.stringify(tiles) === JSON.stringify(["3", "1", "1"]), `summary tiles ${JSON.stringify(tiles)}`);   // to decide; urgent (ny-7 blocks; ny-9 is due in over a day); on your plate
      const card = panel.locator('[data-decision="ny-7"]');
      await card.getByText("Ship the demo release tonight?").waitFor();
      await card.getByText("Blocking").waitFor();
      await card.getByText("Filed without a brief").waitFor();
      const buttons = await card.locator(".actions .btn").allInnerTexts();
      assert(JSON.stringify(buttons.map(b => b.trim())) === JSON.stringify(["Ship it", "Hold for a day", "Ask the reviewer first"]), `buttons ${JSON.stringify(buttons)}`);
      assert((await card.locator(".btn.primary").innerText()).trim() === "Ship it", "the recommended (first) option isn't the primary button");
      await card.getByRole("button", { name: "Details ›" }).click();
      const brief = page.getByRole("dialog");
      await brief.getByText("hold until tomorrow").waitFor();
      await brief.getByText(/CI is green, the reviewer approved/).waitFor();
      await page.keyboard.press("Escape");
      await brief.waitFor({ state: "hidden" });
      const order = await panel.locator(".group").first().locator("[data-decision]").evaluateAll(els => els.map(e => e.getAttribute("data-decision")));
      assert(order[0] === "ny-7", `blocking item not first: ${JSON.stringify(order)}`);
      await panel.getByRole("button", { name: /^On your plate/ }).waitFor();
      await panel.locator('[data-decision="ny-9"]').getByText(/Sign the venue contract/).waitFor();
      await page.screenshot({ path: join(OUT, "decisions-panel.png") });
    });

    await check("in the chat, the manager's buttons line becomes a decision card under its message", async () => {
      const msg = page.locator('.pane [data-msg="md1:0"]');
      await msg.waitFor({ timeout: 8000 });
      await msg.getByText("ready to ship").waitFor();
      assert(!(await msg.innerText()).includes("[buttons"), "the raw buttons line is shown");
      await msg.locator('[data-decision="ny-7"] .btn', { hasText: "Ship it" }).waitFor();
      await msg.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(OUT, "decisions-inline.png") });
    });

    await check("answering: pick, confirm, and the manager's terminal gets exactly the tap line; the card says so", async () => {
      const card = page.locator('.pane [data-decision="ny-7"]');
      await card.getByRole("button", { name: /^Ship it/ }).click();
      await card.getByText("Your answer:").waitFor();
      await page.screenshot({ path: join(OUT, "decisions-confirm.png") });
      await card.getByRole("button", { name: "Send answer" }).click();
      const deadline = Date.now() + 8000;
      let screen = "";
      while (Date.now() < deadline && !screen.includes("[tap ny-7] ship (Ship it)")) { await page.waitForTimeout(300); screen = tmux("capture-pane", "-p", "-J", "-t", panes.manager ?? "", "-S", "-50"); }
      assert(screen.includes("[tap ny-7] ship (Ship it)"), "the tap line did not arrive in the manager's pane");
      await card.getByText("You chose").waitFor({ timeout: 6000 });
      await page.getByRole("complementary", { name: "Decisions" }).getByText("Answered, the manager is on it").waitFor();
      await page.screenshot({ path: join(OUT, "decisions-answered.png") });
    });

    await check("a second answer to the same decision is refused by the hub (E8)", async () => {
      const r = await page.evaluate(() => fetch("/api/escalations/ny-7/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "hold", requestId: crypto.randomUUID() }) }).then(async x => ({ status: x.status, body: await x.json() })));
      assert(r.status === 409 && r.body.error === "already_answered", `second answer: ${JSON.stringify(r)}`);
    });

    await check("an answer in words reaches the manager with the item's id", async () => {
      const card = page.getByRole("complementary", { name: "Decisions" }).locator('[data-decision="ny-8"]');
      await card.getByRole("button", { name: "Answer…" }).click();
      const box = card.getByRole("textbox");
      await box.type("Thursday");
      await page.keyboard.press("Shift+Enter");                            // a new line, not a send
      assert(await box.inputValue() === "Thursday\n", `Shift+Enter: ${JSON.stringify(await box.inputValue())}`);
      await page.keyboard.press("Backspace");
      await box.type(" morning works");
      await page.keyboard.press("Enter");                                  // sends, like the message box
      const deadline = Date.now() + 8000;
      let screen = "";
      while (Date.now() < deadline && !screen.includes("About ny-8: Thursday morning works")) { await page.waitForTimeout(300); screen = tmux("capture-pane", "-p", "-J", "-t", panes.manager ?? "", "-S", "-50"); }
      assert(screen.includes("About ny-8: Thursday morning works"), "the words did not arrive in the manager's pane");
      await card.getByText("You answered in words").waitFor({ timeout: 6000 });
    });

    await check("the manager closes it on its list: the card shows it decided, with how", async () => {
      writeLedger({ ...ledger, needsYou: ledger.needsYou.map(i => (i.id === "ny-7" ? { ...i, status: "closed", answer: "Shipped at 21:04, rollback tested", closedAt: new Date().toISOString() } : i)) });
      const card = page.locator('.pane [data-decision="ny-7"]');
      await card.getByText("Shipped at 21:04, rollback tested").waitFor({ timeout: 8000 });
      const panel = page.getByRole("complementary", { name: "Decisions" });
      await panel.getByRole("button", { name: /^Decided/ }).click();
      await panel.locator('[data-decision="ny-5"]').getByText("Renamed to demo-staging").waitFor();
    });

    await check("an unreadable list pauses answers and says so; readable again, it recovers", async () => {
      writeLedger("{ half-written");
      const panel = page.getByRole("complementary", { name: "Decisions" });
      await panel.getByText(/Can't read the manager's list/).waitFor({ timeout: 8000 });
      await page.screenshot({ path: join(OUT, "decisions-unreadable.png") });
      writeLedger(ledger);
      await panel.getByText(/Can't read the manager's list/).waitFor({ state: "detached", timeout: 8000 });
    });

    await check("a worker's question lands in the panel with its options, and opens that worker's terminal", async () => {
      const panel = page.getByRole("complementary", { name: "Decisions" });
      const card = panel.locator('[data-decision="q-q1"]');
      await card.getByText("Keep the old endpoint for one more release?").waitFor({ timeout: 8000 });
      await card.getByText("Remove it in the next release").waitFor();
      await card.getByRole("button", { name: /Answer in #reviewer's terminal/ }).click();
      await page.locator("h1", { hasText: "reviewer" }).waitFor();
      assert(await page.locator(".chan .tabs").getByRole("tab", { name: "Terminal" }).getAttribute("aria-selected") === "true", "the Terminal tab didn't open");
      await page.locator(".chan .tabs").getByRole("tab", { name: "Messages" }).click();
      await page.locator('.pane [data-decision="q-q1"]').waitFor();
    });

    await check("all caught up: once nothing waits, the panel says so", async () => {
      appendFileSync(join(CLAUDE, "projects", "-qa", "s-reviewer.jsonl"), L({ type: "user", uuid: "r3", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "q1", content: "Keep it" }] } }) + "\n");
      writeLedger({ needsYou: [], needsYouClosed: ledger.needsYouClosed });
      const panel = page.getByRole("complementary", { name: "Decisions" });
      await panel.getByText("You're all caught up").waitFor({ timeout: 10_000 });
      assert(!(await page.locator(".rail").getByRole("button", { name: /Decisions/ }).locator(".badge").count()), "the rail still counts decisions");
      await page.screenshot({ path: join(OUT, "decisions-caught-up.png") });
      writeLedger(ledger);                                   // the rest of the run sees the list again
      await page.getByRole("button", { name: "Close the right panel" }).click();
    });

    await check("Ctrl+K finds an agent", async () => {
      await page.keyboard.press("Control+k");
      await page.keyboard.type("revi");
      await page.keyboard.press("Enter");
      await page.locator("h1", { hasText: "reviewer" }).waitFor();
    });

    await check("like Slack, the page itself never scrolls; only its panes do", async () => {
      await page.setViewportSize({ width: 1280, height: 600 });        // a laptop-sized window: the sidebar overflows
      await page.locator("aside.side").getByRole("button", { name: /Manager/ }).first().click();
      await page.getByText("step 70 of 70").waitFor({ timeout: 8000 });
      await page.locator("#composer").focus();
      const inner = await page.evaluate(() => {
        const pane = document.querySelector(".pane") as HTMLElement, list = document.querySelector(".side .list") as HTMLElement;
        const box = document.querySelector(".box")?.getBoundingClientRect();
        return { paneScrolls: pane.scrollHeight > pane.clientHeight, listScrolls: list.scrollHeight > list.clientHeight,
          composerVisible: !!box && box.bottom <= innerHeight && box.top >= 0 };
      });
      assert(inner.paneScrolls && inner.listScrolls, `panes don't scroll on their own: ${JSON.stringify(inner)}`);
      assert(inner.composerVisible, "the composer is pushed out of the window");
      const m = await page.evaluate(() => {
        const se = document.scrollingElement as HTMLElement;
        const over = [...document.querySelectorAll("body *")].filter(e => {
          const r = e.getBoundingClientRect();
          return r.height > 0 && (r.bottom > innerHeight + 1 || r.right > innerWidth + 1) && !e.closest(".pane, .list, .screen, .body > .act, .hits");
        }).slice(0, 6).map(e => `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).split(" ")[0]} bottom=${Math.round(e.getBoundingClientRect().bottom)}`);
        return { scrollH: se.scrollHeight, clientH: se.clientHeight, scrollW: se.scrollWidth, clientW: se.clientWidth, over };
      });
      for (const [x, yy] of [[35, 500], [200, 500], [900, 400]] as const) { await page.mouse.move(x, yy); await page.mouse.wheel(0, 800); }
      await page.waitForTimeout(200);
      const y = await page.evaluate(() => scrollY + (document.querySelector(".desk")?.scrollTop ?? 0) + (document.querySelector(".panel")?.scrollTop ?? 0));
      await page.setViewportSize({ width: 1920, height: 908 });
      assert(m.scrollH <= m.clientH && m.scrollW <= m.clientW && y === 0,
        `page scrolls: height ${m.scrollH}/${m.clientH}, width ${m.scrollW}/${m.clientW}, scrollY ${y}; overflowing: ${m.over.join(", ")}`);
    });

    await check("in a narrow window the decisions panel lies over the conversation instead of crushing it", async () => {
      await page.setViewportSize({ width: 1024, height: 720 });
      await page.locator(".rail").getByRole("button", { name: /Decisions/ }).click();
      await page.getByRole("complementary", { name: "Decisions" }).locator("[data-decision]").first().waitFor();
      const narrow = await page.evaluate(() => ({ over: document.querySelector(".panel")?.classList.contains("over"), main: Math.round(document.querySelector(".main")?.getBoundingClientRect().width ?? 0), scrollW: document.scrollingElement?.scrollWidth }));
      await page.screenshot({ path: join(OUT, "decisions-narrow.png") });
      await page.setViewportSize({ width: 1920, height: 908 });
      await page.waitForTimeout(200);
      const wide = await page.evaluate(() => document.querySelector(".panel")?.classList.contains("over"));
      await page.getByRole("button", { name: "Close the right panel" }).click();
      assert(narrow.over && narrow.main >= 560 && narrow.scrollW === 1024 && wide === false, `narrow ${JSON.stringify(narrow)}, wide over ${wide}`);   // negative control: beside it when wide
    });

    await check("the layout matches Slack's measured metrics", async () => {
      await page.locator("aside.side").getByRole("button", { name: /Manager/ }).first().click();
      await page.locator(".md strong", { hasText: "three" }).waitFor();
      const m = await page.evaluate(() => {
        const box = (s: string) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); const c = getComputedStyle(e);
          return { w: Math.round(r.width), h: Math.round(r.height), font: `${c.fontWeight} ${c.fontSize}/${c.lineHeight}`, family: c.fontFamily.split(",")[0], radius: c.borderRadius }; };
        return {
          top: box(".top"), rail: box(".rail"), railTab: box(".rail .tab"), team: box(".rail .team"), sideHead: box(".side .head"),
          sideTitle: box(".side .title"), filter: box(".side .filter"), row: box(".side .row:not(.static)"), sectionHead: box(".side .sh"),
          viewHeader: box(".chan .vh"), channelName: box(".chan h1"), tabs: box(".chan .tabs"), tabBtn: box(".chan .tabs button"),
          avatar: box(".msg.head .gutter .av"), sender: box(".who strong"), time: box(".who time"), body: box(".md"),
          composer: box(".box"), composerBar: box(".box .bar"), composerTools: box(".box .tools"), send: box(".send"), typing: box(".typing"),
        };
      });
      const want: [string, string, string | number][] = [
        ["top", "h", 40], ["rail", "w", 70], ["railTab", "w", 52], ["railTab", "h", 68], ["team", "w", 36], ["sideHead", "h", 49],
        ["sideTitle", "font", "900 18px/24px"], ["filter", "h", 28], ["filter", "radius", "8px"], ["row", "h", 28], ["row", "font", "400 15px/28px"],
        ["row", "radius", "6px"], ["sectionHead", "h", 28], ["viewHeader", "h", 49], ["channelName", "font", "900 18px/24px"], ["tabs", "h", 38],
        ["tabBtn", "font", "700 13px/18px"], ["avatar", "w", 36], ["avatar", "radius", "clamp(4px, min(22.222%, 12px), 12px)"], ["sender", "font", "900 15px/22px"],
        ["time", "font", "400 12px/17.6px"], ["body", "font", "400 15px/22px"], ["composer", "radius", "8px"], ["composerBar", "h", 38],
        ["composerTools", "h", 40], ["send", "w", 32], ["send", "h", 28], ["typing", "h", 24], ["sender", "family", "Lato"],
      ];
      const lines: string[] = [];
      let bad = 0;
      for (const [k, prop, v] of want) {
        const got = (m as Record<string, Record<string, unknown> | null>)[k]?.[prop];
        const ok = String(got).replace(/^"|"$/g, "") === String(v);
        if (!ok) bad++;
        lines.push(`${ok ? "ok  " : "DIFF"} ${k}.${prop}: slack ${v}, morndo ${JSON.stringify(got)}`);
      }
      writeFileSync(join(OUT, "metrics.txt"), lines.join("\n") + "\n");
      console.log(lines.map(l => `      ${l}`).join("\n"));
      assert(bad === 0, `${bad} metric(s) differ`);
    });

    await check("no console errors or CSP violations during the flow (Desktop and Terminal included)", async () => {
      // The E8 check above provokes exactly one refused answer (409) on purpose; the browser logs it as a failed load.
      const unexpected = flowErrors.filter((e, i, all) => !(/status of 409/.test(e) && all.findIndex(x => /status of 409/.test(x)) === i));
      assert(unexpected.length === 0, unexpected.slice(0, 5).join(" | "));
    });

    await check("no console errors or CSP violations", async () => {
      const errors: string[] = [];
      const p2 = await context.newPage();
      p2.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
      p2.on("pageerror", e => errors.push(e.message));
      await p2.goto(`http://localhost:${port}/`);
      await p2.locator(".desk").waitFor({ timeout: 10_000 });
      await p2.waitForTimeout(1500);
      assert(errors.length === 0, errors.join(" | "));
    });
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise<void>(r => { if (!hub) return r(); hub.once("exit", () => r()); hub.kill("SIGTERM"); hub = null; });
  office.stop();
  rmSync(HOME, { recursive: true, force: true });
}
const failed = results.filter(r => !r.ok).length;
const skips = skipped.length ? `, ${skipped.length} skipped (reasons above)` : "";
console.log(`\n${results.length - failed}/${results.length} checks passed${skips}. Screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
