// A text file attached on the desktop and on the phone reaches the lane as a path, the way an image does; so does an
// HTML page, byte for byte, without its script running in the app. An executable, an oversized text file and a page
// over 10 MB are refused in words. Run: npm run build && node e2e/uploads.e2e.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { assert, checks, outDir, pairedPage, startOffice } from "./harness.ts";

const OUT = outDir("uploads");
const office = await startOffice("uploads");
const { check, watch, finish } = checks(OUT);
const browser = await chromium.launch();
const { tmux, panes } = office.office;
const screen = () => tmux("capture-pane", "-p", "-J", "-t", panes.builder ?? "", "-S", "-40");
const until = async (cond: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return; await new Promise(r => setTimeout(r, 200)); }
  if (!cond()) throw new Error(`${what}\n${screen()}`);
};

let code = 1;
try {
  const desk = await pairedPage(browser, office, { width: 1280, height: 800 });
  watch(desk.page);
  const page = desk.page;

  await check("the desktop attaches a markdown file, refuses an executable and an oversized file, and the lane receives the path", async () => {
    await page.locator("aside.side").getByRole("button", { name: /builder/ }).click();
    await page.locator("h1", { hasText: "builder" }).waitFor();
    tmux("send-keys", "-t", panes.builder ?? "", "clear", "Enter");
    const input = page.locator('.box input[type="file"]');
    await input.setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes\n") });
    const chip = page.locator(".filechip", { hasText: "notes.md" });
    await chip.waitFor({ timeout: 8000 });
    assert((await chip.innerText()).includes("MD") && (await chip.innerText()).includes("B"), "the chip doesn't show type and size");
    await input.setInputFiles({ name: "run.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
    await page.getByText("run.exe can't be attached").waitFor();
    await input.setInputFiles({ name: "big.md", mimeType: "text/markdown", buffer: Buffer.alloc(1024 * 1024 + 1, 0x61) });
    await page.getByText("big.md is over 1 MB").waitFor();
    assert(await page.locator(".filechip").count() === 1, "a refused file was kept");
    await page.locator(".box").evaluate(el => {
      const dt = new DataTransfer();
      dt.items.add(new File(["a,b\n"], "rows.csv", { type: "text/csv" }));
      el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await page.locator(".filechip", { hasText: "rows.csv" }).waitFor({ timeout: 8000 });
    await page.locator("#composer").fill("read these");
    await page.locator(".tools").getByRole("button", { name: "Send" }).click();
    await until(() => screen().includes("read these") && (screen().match(/\[The owner attached a file: /g) ?? []).length >= 2, 12_000, "the files were not typed");
    const paths = [...screen().matchAll(/\[The owner attached a file: (\/[^\]]+)\]/g)].map(m => m[1] ?? "");
    assert(paths.some(p => p.endsWith("notes.md")) && paths.some(p => p.endsWith("rows.csv")), `paths: ${paths.join(" ")}`);
  });

  await check("the desktop attaches an HTML page, script and all; the lane gets it byte for byte and the app runs none of it", async () => {
    tmux("send-keys", "-t", panes.builder ?? "", "clear", "Enter");
    // Two markers: a <script> runs if the page is loaded as a page, an onerror also if its markup is put into the app's DOM.
    const html = `<!doctype html><meta charset="utf-8"><title>Q3</title><p>Grüße</p><script>window.__ran = 1</script><img src=x onerror="window.__ran = 2">\n`;
    const input = page.locator('.box input[type="file"]');
    await input.setInputFiles({ name: "huge.html", mimeType: "text/html", buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0x61) });
    await page.getByText("huge.html is over 10 MB.").waitFor();
    await input.setInputFiles({ name: "Q3 report.html", mimeType: "text/html", buffer: Buffer.from(html) });
    const chip = page.locator(".filechip", { hasText: "Q3_report.html" });
    await chip.waitFor({ timeout: 8000 });
    assert((await chip.innerText()).includes("HTML"), `the chip doesn't say HTML: ${await chip.innerText()}`);
    assert(!(await chip.getAttribute("class"))?.includes("error"), `the page was refused: ${await chip.getAttribute("title")}`);
    await page.locator("#composer").fill("read the report");
    await page.locator(".tools").getByRole("button", { name: "Send" }).click();
    await until(() => screen().includes("read the report") && /Q3_report\.html\]/.test(screen()), 12_000, "the page was not typed");
    const path = /\[The owner attached a file: (\/[^\]]+Q3_report\.html)\]/.exec(screen())?.[1] ?? "";
    assert(readFileSync(path, "utf8") === html, `the lane's copy at ${path} differs from the page sent`);
    assert(await page.evaluate(() => (window as unknown as { __ran?: number }).__ran) === undefined, "the page's script ran in the app");
    await page.screenshot({ path: join(OUT, "html-sent.png") });
  });

  await desk.context.close();

  await check("the phone attaches a markdown file and the lane receives it", async () => {
    const phone = await pairedPage(browser, office, { width: 390, height: 844, phone: true, ready: "nav.tabbar" });
    watch(phone.page);
    const p = phone.page;
    await p.locator('[data-chat="builder"]').click();
    const convo = p.getByRole("region", { name: "Conversation with builder" });
    await convo.getByRole("textbox", { name: "Message builder" }).waitFor();
    tmux("send-keys", "-t", panes.builder ?? "", "clear", "Enter");
    await convo.locator('input[type="file"]').setInputFiles([
      { name: "phone.md", mimeType: "text/markdown", buffer: Buffer.from("# From the phone\n") },
      { name: "phone.html", mimeType: "text/html", buffer: Buffer.from("<!doctype html><p>From the phone</p>\n") },
    ]);
    await convo.locator(".chip", { hasText: "phone.md" }).waitFor({ timeout: 8000 });
    assert((await convo.locator(".chip", { hasText: "phone.md" }).innerText()).includes("MD"), "the phone chip has no type");
    await convo.locator(".chip", { hasText: "phone.html" }).waitFor({ timeout: 8000 });
    assert((await convo.locator(".chip", { hasText: "phone.html" }).innerText()).includes("HTML"), "the phone's page chip doesn't say HTML");
    await convo.getByRole("textbox", { name: "Message builder" }).fill("from the phone");
    await convo.getByRole("button", { name: "Send" }).click();
    await until(() => screen().includes("from the phone") && /phone\.md\]/.test(screen()) && /phone\.html\]/.test(screen()), 12_000, "the phone files were not typed");
    await phone.context.close();
  });

  code = finish();
} finally {
  await browser.close();
  office.stop();
}
process.exit(code);
