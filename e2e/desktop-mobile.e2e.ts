// End-to-end check of the Desktop on a phone and a tablet (T-670), on a synthetic office with its own hub and a private
// TigerVNC desktop (office.ts), in Chromium with a phone's touch screen at 390x844 and 820x1180: an agent's
// conversation offers the desktop beside Chat and Screen; watching shows no input controls and drops input; under
// control the extra keys, the keyboard field, "Paste text" and "Copy from desktop" reach the real desktop through the
// hub. Screenshots of each size, watching and in control, go to the output folder, never into the tree.
// Run: npm run build && node e2e/desktop-mobile.e2e.ts
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Page } from "playwright";
import { assert, checks, launch, outDir, pairedPage, startOffice } from "./harness.ts";

const OUT = outDir("desktop-mobile");
// A check this machine can't run, said with its reason, never silently (ADR-0008 phase G: CI has no VNC desktop).
if (process.env.MORNDO_E2E_NO_VNC === "1") {
  console.log("SKIP  the Desktop on a phone and a tablet\n      MORNDO_E2E_NO_VNC=1: this machine has no VNC desktop to show (it needs TigerVNC's Xtigervnc and vncpasswd)");
  process.exit(0);
}
const office = await startOffice("deskmobile");
const desk = office.office.desktop;
const { check, watch, finish } = checks(OUT);
const browser = await launch();
const helpers: ChildProcess[] = [];

// The X clipboard of the private desktop, as a program on it sees it.
const xclipOut = () => { try { return execFileSync("xclip", ["-o", "-selection", "clipboard"], { env: desk!.env, encoding: "utf8", timeout: 3000 }); } catch { return ""; } };
// A program on the desktop puts text on its clipboard (xclip keeps owning it until it is killed).
function xclipIn(text: string) {
  const p = spawn("xclip", ["-i", "-selection", "clipboard"], { env: desk!.env, stdio: ["pipe", "ignore", "ignore"] });
  p.stdin?.end(text);
  helpers.push(p);
}
// Every key the desktop's root window gets, as xev prints it ("keysym 0x68, h").
function keyLog() {
  const p = spawn("xev", ["-root", "-event", "keyboard"], { env: desk!.env, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  p.stdout?.on("data", d => (out += String(d)));
  helpers.push(p);
  return { pressed: () => [...out.matchAll(/KeyPress event[\s\S]*?keysym (0x[0-9a-f]+)/g)].map(m => Number.parseInt(m[1]!, 16)) };
}
const orange = async (page: Page) => {
  const px = await page.locator(".screen canvas").evaluate((c: HTMLCanvasElement) => [...c.getContext("2d")!.getImageData(5, 5, 1, 1).data]);
  return px[0]! > 200 && px[1]! > 100 && px[1]! < 170 && px[2]! < 60;
};

try {
  assert(desk, "no private VNC desktop (TigerVNC missing)");
  for (const size of [{ name: "phone", width: 390, height: 844 }, { name: "tablet", width: 820, height: 1180 }]) {
    const { page, context, errors } = await pairedPage(browser, office, { width: size.width, height: size.height, phone: true, ready: "nav.tabbar" });
    watch(page);
    const convo = page.getByRole("region", { name: "Conversation with builder" });
    const view = convo.getByRole("region", { name: "Desktop" });
    const keys = view.getByRole("toolbar", { name: "Keys for the desktop" });

    await check(`${size.name} ${size.width}x${size.height}: an agent's conversation offers the desktop; watching is view-only`, async () => {
      await page.locator('[data-chat="builder"]').click();
      await convo.getByRole("tablist", { name: "Show" }).getByRole("tab", { name: "Desktop" }).click();
      await view.locator(".status.live").waitFor({ timeout: 15_000 });
      await view.locator(".screen canvas").waitFor();
      await page.waitForTimeout(1200);
      assert(await orange(page), "the desktop's orange background didn't arrive");
      for (const name of ["Keyboard", "Paste text", "Copy from desktop", "Fit", "1:1"]) assert(await view.getByRole("button", { name, exact: true }).count() === 0, `${name} shown while watching`);
      assert(await keys.count() === 0, "the keys row shows while watching");
      const s = (await view.locator(".screen").boundingBox())!;
      assert(Math.abs(s.y + s.height - size.height) <= 1, `the desktop doesn't reach the bottom: ${s.y + s.height} of ${size.height}`);
      const dialog = desk!.dialog();
      let closed = false;
      dialog.once("exit", () => { closed = true; });
      await page.waitForTimeout(600);
      await view.locator(".screen").tap({ position: { x: s.width / 2, y: s.height / 2 } });
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1000);
      assert(!closed, "the desktop took input while only watching");
      dialog.kill();
      await page.screenshot({ path: join(OUT, `${size.name}-watching.png`) });
    });

    await check(`${size.name}: under control the keys row, the keyboard field, Paste text and Copy from desktop reach the desktop`, async () => {
      await view.getByRole("button", { name: "Take control" }).click();
      await view.getByRole("button", { name: "Release control" }).waitFor({ timeout: 10_000 });
      await keys.waitFor();
      const s = (await view.locator(".screen").boundingBox())!;
      // The keys row's Enter closes a dialog on the desktop: a tap puts the pointer over it, as on the phone.
      const dialog = desk!.dialog();
      let closed = false;
      dialog.once("exit", () => { closed = true; });
      await page.waitForTimeout(600);
      await view.locator(".screen").tap({ position: { x: s.width / 2, y: s.height / 2 } });
      await page.waitForTimeout(300);
      await keys.getByRole("button", { name: "Enter", exact: true }).tap();
      for (let i = 0; i < 30 && !closed; i++) await page.waitForTimeout(200);
      if (!closed) dialog.kill();
      assert(closed, "the keys row's Enter didn't reach the desktop");
      await page.screenshot({ path: join(OUT, `${size.name}-control.png`) });
      // The keyboard field: typed text (Latin-1 and beyond), as the desktop's root window sees it.
      const log = keyLog();
      await page.waitForTimeout(500);
      await view.getByRole("button", { name: "Keyboard", exact: true }).tap();
      await page.keyboard.type("hé");
      await page.keyboard.insertText("€");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1200);
      const got = log.pressed().filter(k => k !== 0xffe3 && k !== 0xffe9);
      assert(JSON.stringify(got.slice(0, 2)) === JSON.stringify([0x68, 0xe9]) && [0x20ac, 0x010020ac].includes(got[2]!) && got[3] === 0xff0d,
        `the desktop got keysyms ${got.map(k => k.toString(16)).join(" ")}`);
      await page.screenshot({ path: join(OUT, `${size.name}-keyboard.png`) });
      await view.getByRole("button", { name: "Keyboard", exact: true }).tap();
      // Paste text: the desktop's clipboard gets it through the hub.
      const text = `morndo e2e paste ${size.name}`;
      await view.getByRole("button", { name: "Paste text", exact: true }).tap();
      await view.getByRole("dialog", { name: "Paste text" }).getByRole("textbox", { name: "Text to paste" }).fill(text);
      await page.screenshot({ path: join(OUT, `${size.name}-paste.png`) });
      await view.getByRole("dialog", { name: "Paste text" }).getByRole("button", { name: "Send to the desktop's clipboard" }).tap();
      let clip = "";
      for (let i = 0; i < 25 && clip !== text; i++) { await page.waitForTimeout(200); clip = xclipOut(); }
      assert(clip === text, `the desktop's clipboard holds ${JSON.stringify(clip)}`);
      // Copy from desktop: what a program there copies shows here.
      const back = `from the desk ${size.name}`;
      xclipIn(back);
      await view.getByRole("button", { name: "Copy from desktop", exact: true }).tap();
      const shown = view.getByRole("dialog", { name: "Copy from desktop" }).getByRole("textbox", { name: "The desktop's clipboard" });
      for (let i = 0; i < 25 && (await shown.inputValue()) !== back; i++) await page.waitForTimeout(200);
      assert((await shown.inputValue()) === back, `Copy from desktop shows ${JSON.stringify(await shown.inputValue())}`);
      await page.screenshot({ path: join(OUT, `${size.name}-copy.png`) });
      await view.getByRole("dialog", { name: "Copy from desktop" }).getByRole("button", { name: "Close" }).tap();
      await view.getByRole("button", { name: "Release control" }).tap();
      await view.getByRole("button", { name: "Take control" }).waitFor();
      assert(await keys.count() === 0, "the keys row stays after release");
    });

    await check(`${size.name}: no errors in the page`, async () => {
      const real = errors.filter(e => !/WebSocket|ERR_NETWORK_CHANGED/.test(e));
      assert(real.length === 0, real.join(" | "));
    });
    await context.close();
  }
} finally {
  for (const p of helpers) p.kill();
  await browser.close();
  office.stop();
}
process.exit(finish());
