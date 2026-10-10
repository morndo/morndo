// End-to-end checks of the phone's readability pass (the owner's feedback on the live app, 2026-10-04): Today's rows
// read short with the rest behind More, a task has Done and Later (never Decide now), a decision's card shows its options
// as big buttons and "Answer in my own words" as a button of its own, and nothing sits under the status bar in the
// installed app. 390 px, Playwright's own Chromium, a synthetic office with its own hub; what each check expects comes
// from the office's list, not from the app. Run: npm run build && node e2e/readability.e2e.ts
import { join } from "node:path";
import { chromium } from "playwright";
import { assert, checks, outDir, pairedPage, startOffice } from "./harness.ts";

const OUT = outDir("readability");
const office = await startOffice("readability");
const { tmux, office: o } = office;
const { ledger, writeLedger, panes } = o;
const { check, watch, finish } = checks(OUT);
const browser = await chromium.launch();
let code = 1;

const pane = (name: string) => tmux("capture-pane", "-p", "-J", "-t", panes[name] ?? "", "-S", "-300");
const until = async (cond: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise(r => setTimeout(r, 150)); }
  if (!(await cond())) throw new Error(`timed out: ${what}`);
};

// Three invented items, of the shapes the manager's list uses: a task with only its long text, a task in the list's short form, and
// a blocking decision with three options.
const RAW = "#42 is ready. Your garden check (~10 min, morning): open www.example.com/garden as gardener@example.com (the code comes by mail), /beds, pick the north bed, water it, then Log -> done; then the soil test.";
const items = ledger.needsYou as Record<string, unknown>[];
items.push(
  { id: "ny-80", kind: "time", what: RAW, default: "the beds wait for this", addedAt: new Date().toISOString() },
  { id: "ny-81", kind: "time", what: "garden shed rebuild: for the order we need from you (1) the wood sizes, (2) a delivery day, (3) the gate code, (4) a budget.",
    title: "Inputs for the shed order", summary: "Send the wood sizes, a delivery day and the gate code for the order.", minutes: 15,
    details: "(1) the wood sizes\n(2) a delivery day\n(3) the gate code\n(4) a budget", link: "https://example.com/shed", default: "the order waits", addedAt: new Date().toISOString() },
  { id: "ny-82", kind: "tap", question: "Newsletter logo: the round one, the square one, or keep the old? Printing waits for this.", title: "Pick the newsletter logo",
    summary: "Which logo goes on the spring newsletter?", blocking: true, task: "newsletter", default: "keep the old logo",
    options: [{ key: "round", label: "The round logo" }, { key: "square", label: "The square logo" }, { key: "old", label: "Keep the old logo" }], ts: new Date().toISOString() },
);
writeLedger(ledger);

try {
  const { page, cdp } = await pairedPage(browser, office, { width: 390, height: 844, phone: true, ready: "nav.tabbar", init: () => localStorage.setItem("morndo.tab", "today"), colorScheme: "dark" });
  watch(page);
  const row = (id: string) => page.locator(`li.ev[data-row="d:${id}"]`);
  const btn = (id: string, name: string) => row(id).getByRole("button", { name, exact: true });
  await row("ny-82").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, "1-today-dark.png") });

  await check("R1. a row reads short: a one-line title (the list's own, or its text's first clause), its sentence, a meta line; the long text only behind More", async () => {
    const shown = await page.locator("li.ev .t").evaluateAll(els => els.map(e => ({ text: e.textContent ?? "", h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).lineHeight) })));
    for (const s of shown) {
      assert(s.text.length <= 60, `a title of ${s.text.length} characters: ${s.text}`);
      assert(s.h <= s.lh * 1.2, `a title on more than one line (${s.h}px): ${s.text}`);
    }
    assert(await row("ny-80").locator(".t").innerText() === "#42 is ready", "the raw item's title isn't its first clause");
    assert(!(await row("ny-80").innerText()).includes("www.example.com"), "the raw text shows before More");
    assert(await row("ny-81").locator(".t").innerText() === "Inputs for the shed order", "the list's own title isn't used");
    assert(await row("ny-81").locator(".s").first().innerText() === "Send the wood sizes, a delivery day and the gate code for the order.", "the list's sentence isn't shown");
    assert(await row("ny-81").locator(".meta").innerText() === "≈15 min · only you", `meta: ${await row("ny-81").locator(".meta").innerText()}`);
    assert(await row("ny-82").locator(".meta").innerText() === "Decision · blocks newsletter", `meta: ${await row("ny-82").locator(".meta").innerText()}`);
    await btn("ny-80", "More").click();
    await row("ny-80").getByText("Your garden check (~10 min, morning): open www.example.com/garden", { exact: false }).waitFor();
    await row("ny-80").getByText("If you don't get to it: the beds wait for this.").waitFor();
    await btn("ny-81", "More").click();
    await row("ny-81").getByRole("link", { name: "Open the link" }).waitFor();
    assert(await row("ny-81").getByRole("link", { name: "Open the link" }).getAttribute("href") === "https://example.com/shed", "the link isn't the list's");
    await row("ny-81").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(OUT, "2-more-dark.png") });
    await btn("ny-80", "Less").click();
    await btn("ny-81", "Less").click();
  });

  await check("R2. a task has Done and Later, never Decide now; a decision's row has Decide now", async () => {
    for (const i of items) {
      const id = String(i.id);
      if ((i.status ?? "open") !== "open") continue;
      const r = row(id);
      if (!(await r.count())) continue;
      const names = await r.getByRole("button").allInnerTexts();
      if (i.kind === "time") assert(names.includes("Done") && names.includes("Later") && !names.includes("Decide now"), `${id}: ${JSON.stringify(names)}`);
      else assert(names.includes("Decide now") && !names.includes("Done"), `${id}: ${JSON.stringify(names)}`);
    }
  });

  await check("R3. Done waits 5 s with Undo (Undo sends nothing); then the manager gets it once, and the row says what he said", async () => {
    await btn("ny-81", "Done").click();
    await row("ny-81").getByText(/“Done” goes in \d s\./).waitFor();
    await btn("ny-81", "Undo").click();
    await page.waitForTimeout(6500);
    assert(!pane("manager").includes("About ny-81: Done"), "an undone Done was typed");
    await btn("ny-81", "Done").click();
    await until(() => pane("manager").includes("About ny-81: Done"), 15_000, "ny-81's Done in the manager's pane");
    assert(pane("manager").split("\n").filter(l => l.includes("About ny-81: Done")).length === 1, "Done typed more than once");
    await row("ny-81").getByText(/You said “Done” at \d\d:\d\d\./).waitFor({ timeout: 10_000 });
    assert(await row("ny-81").getAttribute("data-needs") === "without-you", "an answered task still needs him");
  });

  await check("R4. Later keeps a task off today on this device, also after a reload; Bring back returns it", async () => {
    await btn("ny-80", "Later").click();
    await page.locator("li.sect", { hasText: "Kept for later today" }).waitFor();
    await btn("ny-80", "Bring back").waitFor();
    await page.reload();
    await btn("ny-80", "Bring back").waitFor({ timeout: 15_000 });
    assert(!pane("manager").includes("About ny-80"), "Later told the manager something");
    await btn("ny-80", "Bring back").click();
    await btn("ny-80", "Done").waitFor();
  });

  await check("R5. his own words on a task: a button of its own behind More, then the box; the manager gets the words", async () => {
    await btn("ny-80", "More").click();
    const words = btn("ny-80", "Answer in my own words");
    const box = await words.boundingBox();
    assert(box && box.height >= 44, `the own-words button is ${box?.height}px high`);
    await words.click();
    await row("ny-80").locator("textarea").fill("Watered the north bed, all fine.");
    await btn("ny-80", "Send to the manager").click();
    await until(() => pane("manager").includes("About ny-80: Watered the north bed, all fine."), 15_000, "ny-80's words in the manager's pane");
  });

  await check("R6. a decision's card: its options as big buttons, the recommended (first) one filled; Answer in my own words a full button; a tap reaches the manager", async () => {
    await btn("ny-82", "Decide now").click();
    const card = page.locator("article.card");
    await until(async () => (await card.getAttribute("data-card")) === "d:ny-82", 8000, "ny-82's card on top");
    await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
    await card.getByRole("heading", { name: "Pick the newsletter logo" }).waitFor();
    await card.getByText("Which logo goes on the spring newsletter?").waitFor();
    const opts = await card.locator(".opts .opt").evaluateAll(els => els.map(e => ({ text: (e.querySelector("span")?.textContent ?? "").trim(), h: e.getBoundingClientRect().height, primary: e.classList.contains("primary"), bg: getComputedStyle(e).backgroundColor })));
    assert(JSON.stringify(opts.map(x => x.text)) === JSON.stringify(["The round logo", "The square logo", "Keep the old logo"]), `options ${JSON.stringify(opts.map(x => x.text))}`);
    assert(opts.every(x => x.h >= 52), `an option under 52px: ${JSON.stringify(opts.map(x => x.h))}`);
    assert(opts[0]?.primary && !opts[1]?.primary && opts[0].bg !== opts[1]?.bg, "the recommended option isn't the filled one");
    assert((await card.locator(".opts .opt").first().innerText()).includes("RECOMMENDED") || (await card.locator(".opts .opt").first().innerText()).includes("Recommended"), "no Recommended label on the first option");
    const words = card.getByRole("button", { name: "Answer in my own words" });
    const wb = await words.boundingBox(), body = await card.locator(".card-body").boundingBox();
    assert(wb && body && wb.height >= 48 && wb.width >= body.width * 0.8, `the own-words button is ${wb?.width}x${wb?.height} in a ${body?.width} body`);
    await page.screenshot({ path: join(OUT, "3-decision-dark.png") });
    await card.getByRole("button", { name: /The square logo/ }).click();
    await until(() => pane("manager").includes("[tap ny-82] square (The square logo)"), 15_000, "ny-82's tap in the manager's pane");
  });

  await check("R7. the installed app's status bar and home indicator (emulated safe areas): nothing scrolls under them, on Today, Catch up, Chats and Status", async () => {
    // A tap where the tab bar shows (e2e/phone-chat.e2e.ts: Playwright's own click scrolls a sticky bar's static place
    // into view first, where the list lies).
    const tapTab = async (name: string) => {
      const box = await page.locator("nav.tabbar button", { hasText: name }).boundingBox();
      assert(box !== null, `no ${name} tab`);
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    await page.goto(new URL("/", page.url()).href);
    await page.locator("nav.tabbar").waitFor();
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
    await page.waitForTimeout(300);
    const underStatusBar = () => page.evaluate(() => [40, 120, 200, 300, 370].map(x => {
      const e = document.elementFromPoint(x, 30);
      return e && !e.closest("header") ? (e.textContent ?? e.tagName).slice(0, 40) : null;
    }).filter(Boolean));
    const logo = await page.locator("header.top .mark").boundingBox();
    assert(logo && logo.y >= 47, `the bar's content starts at ${logo?.y}px, under the status bar`);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(300);
    assert((await underStatusBar()).length === 0, `under the status bar after a scroll: ${JSON.stringify(await underStatusBar())}`);
    const tab = await page.locator("nav.tabbar button").first().boundingBox();
    assert(tab && tab.y + tab.height <= 844 - 34 + 0.5, `a tab ends at ${tab ? tab.y + tab.height : "?"}px, under the home indicator`);
    await page.screenshot({ path: join(OUT, "4-safe-area-dark.png") });
    // ADR-0011: the Agents tab became Chats and Status.
    for (const [tab, region] of [["Chats", "Chats"], ["Status", "Status"]] as const) {
      await tapTab(tab);
      const title = await page.getByRole("region", { name: region }).locator("h1").boundingBox();
      assert(title !== null && title.y >= 47, `the ${tab} bar starts at ${title?.y}px`);
    }
    await tapTab("Today");
    await btn("ny-7", "Decide now").click();
    await until(async () => (await page.locator("article.card").getAttribute("data-card")) === "d:ny-7", 8000, "ny-7's card on top");
    const cuTop = await page.locator(".cu-top").boundingBox();
    const cuRow = await page.locator(".cu-top .row").first().boundingBox();
    assert(cuTop && cuRow && cuRow.y >= 47, `catch-up's bar starts at ${cuRow?.y}px`);
    // A decision's card with its three options, under the status bar and above the home indicator: the options and the
    // own-words button show without scrolling the card.
    const card = page.locator("article.card");
    await card.getByRole("button", { name: "Answer in my own words" }).waitFor();
    await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
    const body = await card.locator(".card-body").boundingBox(), words = await card.getByRole("button", { name: "Answer in my own words" }).boundingBox();
    assert(body && words && words.y + words.height <= body.y + body.height, `the own-words button ends at ${words ? words.y + words.height : "?"}px, the card's body at ${body ? body.y + body.height : "?"}px`);
    await page.screenshot({ path: join(OUT, "4b-card-safe-area-dark.png") });
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  });

  await check("R8. light: Today and a decision's card read the same", async () => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(new URL("/", page.url()).href);
    await page.locator("nav.tabbar").waitFor();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, "5-today-light.png") });
    await btn("ny-7", "Decide now").click();
    await page.locator("article.card").getByRole("button", { name: "Answer in my own words" }).waitFor();
    await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
    await page.screenshot({ path: join(OUT, "6-decision-light.png") });
  });

  code = finish();
} finally {
  await browser.close();
  office.stop();
}
process.exit(code);
