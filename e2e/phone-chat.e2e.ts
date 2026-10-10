// End-to-end checks of ADR-0011 (the phone as a chat app) at 390 px on a synthetic office with its own hub, in
// Playwright's Chromium, both themes: the digest after a long absence and not after a short one (or a day on another
// device), the chat list, the status view, a message to the manager (Queued, then Delivered, with a fake inbox), a
// message to a lane (Delivered by the steering service), the offline queue, and the composer above the keyboard and the
// home indicator. The inbox's deliverer is played by writing its state files, as e2e/inbox.e2e.ts does.
// Run: npm run build && node e2e/phone-chat.e2e.ts
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { assert, checks, outDir, pairedPage, startOffice } from "./harness.ts";
import { contrastProblems } from "./contrast.ts";

const OUT = outDir("phone-chat");
const INBOX = join(OUT, "manager-inbox");
const office = await startOffice("phonechat", { MORNDO_MANAGER_INBOX: INBOX, MORNDO_POLL_MS: "500" });
mkdirSync(INBOX, { recursive: true });
const beat = () => writeFileSync(join(INBOX, "deliverer.json"), JSON.stringify({ pid: 1, at: Date.now() }));
beat();
const beating = setInterval(beat, 10_000);
const { tmux, panes, claudeDir, line } = office.office;
const { check, watch, finish } = checks(OUT);
const browser = await chromium.launch();
let code = 1;
const H = 3_600_000;

const inbox = () => { try { return readdirSync(join(INBOX, "msg")).map(f => JSON.parse(readFileSync(join(INBOX, "msg", f), "utf8"))); } catch { return []; } };
const deliverer = (key: string, state: Record<string, unknown>) => {
  mkdirSync(join(INBOX, "state"), { recursive: true });
  writeFileSync(join(INBOX, "state", `${key}.json`), JSON.stringify({ v: 1, key, attempts: 1, updatedAt: Date.now(), ...state }));
};
const echo = (who: string, id: string, text: string) =>
  appendFileSync(join(claudeDir, "projects", "-qa", `s-${who}.jsonl`), line({ type: "user", uuid: id, timestamp: new Date().toISOString(), origin: { kind: "human" }, message: { role: "user", content: text } }) + "\n");
const screen = (w: string) => tmux("capture-pane", "-p", "-J", "-t", panes[w] ?? "", "-S", "-50");
const until = async (cond: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise(r => setTimeout(r, 150)); }
  if (!(await cond())) throw new Error(`timed out: ${what}`);
};
const contrast: string[] = [];
async function shot(page: Page, name: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(OUT, `${name}-${theme}.png`) });
    for (const p of await contrastProblems(page, theme)) contrast.push(`${name}, ${theme}: ${p}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
}
// A tap where the tab bar shows: Playwright's own click scrolls a sticky bar's static place into view first, where the
// list lies (its call log: "<ul> … intercepts pointer events"), while at the bar's visible centre the hit test finds the
// button itself, as a finger does.
async function tapTab(page: Page, name: string) {
  const box = await page.locator("nav.tabbar button", { hasText: name }).boundingBox();
  assert(box !== null, `no ${name} tab`);
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("button")?.textContent ?? "", [box.x + box.width / 2, box.y + box.height / 2]);
  assert(hit.includes(name), `the ${name} tab isn't what a tap there hits: ${hit}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
const digest = (page: Page) => page.getByRole("region", { name: "While you were away" });
// His last activity on this device, as the app keeps it, then a fresh load: the app decides on its start. Set by the
// init script on the new page, since leaving the old one rightly counts as activity (it writes "now" when hidden).
async function cameBackAfter(page: Page, ms: number) {
  await page.evaluate(at => sessionStorage.setItem("comeback", String(at)), Date.now() - ms);
  await page.reload();
  await page.locator("nav.tabbar").waitFor();
  await page.locator("[data-chat]").first().waitFor({ timeout: 10_000 });
}

try {
  // His last activity here was 9 hours ago (set once, before the app's first start on this device).
  const { page, context, cdp, errors } = await pairedPage(browser, office, {
    width: 390, height: 844, phone: true, ready: "nav.tabbar",
    init: () => {
      if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("morndo.lastActive", String(Date.now() - 9 * 3_600_000)); }
      const back = sessionStorage.getItem("comeback");
      if (back) { localStorage.setItem("morndo.lastActive", back); sessionStorage.removeItem("comeback"); }
    },
  });
  watch(page);

  await check("after 9 hours away, a digest sums up each lane in a line or two: manager first, then needs you, blocked, finished", async () => {
    await digest(page).waitFor({ timeout: 15_000 });
    await page.locator("[data-digest]").first().waitFor({ timeout: 10_000 });
    const names = await page.locator("[data-digest]").evaluateAll(els => els.map(e => `${e.getAttribute("data-digest")}:${e.className.split(" ").find(c => c !== "line")}`));
    assert(names[0] === "manager:working" || names[0]?.startsWith("manager:"), `manager isn't first: ${names.join(", ")}`);
    assert(names.includes("reviewer:needs_you") && names.includes("builder:finished"), `lines: ${names.join(", ")}`);
    assert(names.indexOf("reviewer:needs_you") < names.indexOf("builder:finished"), `order: ${names.join(", ")}`);
    const builder = await page.locator('[data-digest="builder"]').innerText();
    assert(/login page is built/i.test(builder) && !/STATUS/.test(builder), `builder's line: ${builder}`);
    assert(await page.getByRole("button", { name: /decisions? waits? for you · Decide/ }).isVisible(), "no way to the decision cards");
    await shot(page, "4-digest");
    await page.getByRole("button", { name: "Later" }).click();
    await page.getByRole("button", { name: /While you were away/ }).waitFor();   // kept on the chat list
  });

  await check("after a short absence (20 min) no digest shows; after 5 hours it does (the check's own control)", async () => {
    await cameBackAfter(page, 20 * 60_000);
    await page.waitForTimeout(2500);
    assert(!(await digest(page).isVisible()), "the digest showed after 20 minutes away");
    await cameBackAfter(page, 5 * H);
    await digest(page).waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Later" }).click();
  });

  await check("the chat list: the manager pinned first, the newest activity next, counts only for messages that matter", async () => {
    const rows = await page.locator("[data-chat]").evaluateAll(els => els.map(e => e.getAttribute("data-chat")));
    assert(rows[0] === "manager", `first row: ${rows[0]}`);
    assert(rows.indexOf("reviewer") < rows.indexOf("builder") && rows.indexOf("builder") < rows.indexOf("worker-01"), `order: ${rows.slice(0, 5).join(", ")}`);
    // The manager wrote 70 progress notes in one turn: they are one unread, not seventy.
    const manager = page.locator('[data-chat="manager"]');
    const count = Number(await manager.locator(".count").innerText());
    assert(count >= 1 && count <= 3, `manager's count: ${count}`);
    assert(!(await page.locator('[data-chat="worker-01"] .count').count()), "a lane that never spoke has a count");
    assert(/waits for you/i.test(await page.locator('[data-chat="reviewer"]').innerText()), "the reviewer's question isn't shown as waiting");
    await shot(page, "1-chats");
  });

  await check("the status view: every lane in one line, who waits for him first, then who works", async () => {
    await tapTab(page, "Status");
    await page.locator("[data-status]").first().waitFor();
    const order = await page.locator("[data-status]").evaluateAll(els => els.map(e => `${e.getAttribute("data-status")}:${e.className.split(" ").find(c => c !== "row")}`));
    assert(order[0]?.startsWith("manager:"), `first: ${order[0]}`);
    assert(order[1] === "reviewer:waits", `second: ${order[1]}`);
    const line = await page.locator('[data-status="reviewer"]').innerText();
    assert(/Waits for you: Keep the old endpoint/.test(line) && /Waits \d/.test(line), `reviewer: ${line}`);
    assert(/Finished: .*login page/i.test(await page.locator('[data-status="builder"]').innerText()), "builder's line");
    await shot(page, "5-status");
    await tapTab(page, "Chats");
  });

  await check("a message to the manager: Queued in its inbox, then Delivered once it reached the manager", async () => {
    await page.locator('[data-chat="manager"]').click();
    const convo = page.getByRole("region", { name: "Conversation with Manager" });
    await convo.locator(".day").first().waitFor();
    assert(await convo.locator(".b:not(.mine)").count() > 5, "the manager's messages aren't bubbles");
    await convo.getByRole("textbox", { name: "Message Manager" }).fill("Hold the release until the reviewer is done");
    await convo.getByRole("button", { name: "Send" }).click();
    const pending = convo.locator("[data-outbox]");
    await until(async () => (await pending.getAttribute("data-delivery")) === "queued" && /Queued for the manager/.test(await pending.innerText()), 10_000, "queued for the manager");
    const m = inbox().find(x => x.kind === "owner");
    assert(m?.text === "Hold the release until the reviewer is done", `inbox: ${JSON.stringify(inbox())}`);
    assert(!screen("manager").includes("Hold the release"), "the hub typed into the manager's pane");
    await shot(page, "2-manager-chat-queued");
    echo("manager", "phone-echo-1", `Hold the release until the reviewer is done ⟨m:${String(m.key).slice(0, 6)}⟩`);
    deliverer(m.key, { status: "delivered", deliveredAt: Date.now() });
    await until(async () => (await pending.count()) === 0, 10_000, "the queued entry ends with its echo");
    const last = convo.locator(".b.mine").last();
    assert(/Hold the release until the reviewer is done/.test(await last.innerText()) && !(await last.innerText()).includes("⟨m:"), "the delivered message");
    assert(await last.getByLabel("Delivered").count() === 1, "no Delivered mark on his message");
    await shot(page, "2-manager-chat");
  });

  await check("reading a chat to its end marks it read: the manager's count is gone from the list", async () => {
    await page.getByRole("button", { name: "Back to chats" }).click();
    await until(async () => (await page.locator('[data-chat="manager"] .count').count()) === 0, 8000, "the manager's count cleared");
  });

  await check("a message to a lane: typed into its pane by the steering service, Delivered", async () => {
    await page.locator('[data-chat="builder"]').click();
    const convo = page.getByRole("region", { name: "Conversation with builder" });
    await convo.getByRole("textbox", { name: "Message builder" }).fill("Add a test for the empty form");
    await convo.getByRole("button", { name: "Send" }).click();
    await until(() => screen("builder").includes("Add a test for the empty form"), 10_000, "typed into the builder's pane");
    const pending = convo.locator("[data-outbox]");
    await until(async () => (await pending.count()) === 0 || (await pending.getAttribute("data-delivery")) === "delivered", 10_000, "delivered");
    echo("builder", "phone-echo-2", "Add a test for the empty form");
    await until(async () => (await pending.count()) === 0, 10_000, "its echo ends the entry");
    assert(await convo.locator(".b.mine").last().getByLabel("Delivered").count() === 1, "no Delivered mark");
    await shot(page, "3-lane-chat");
  });

  await check("offline, a message queues on the phone and goes once it is back online: never a silent drop", async () => {
    const convo = page.getByRole("region", { name: "Conversation with builder" });
    try {                                                                     // never leave the next checks offline
    await context.setOffline(true);
    await page.evaluate(() => dispatchEvent(new Event("offline")));
    await convo.getByRole("textbox", { name: "Message builder" }).fill("Written on the train");
    await convo.getByRole("button", { name: "Send" }).click();
    const pending = convo.locator("[data-outbox]");
    await until(async () => /Queued · sends when you're back online/.test(await pending.innerText().catch(() => "")), 8000, "queued offline");
    await shot(page, "3-lane-chat-offline");
    await context.setOffline(false);
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await until(() => screen("builder").includes("Written on the train"), 20_000, "sent once online");
    } finally {
      await context.setOffline(false);
      await page.evaluate(() => dispatchEvent(new Event("online"))).catch(() => {});
    }
  });

  await check("keyboard and safe areas: the composer clears the home indicator, and stays above the keyboard", async () => {
    const convo = page.getByRole("region", { name: "Conversation with builder" });
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
    await page.waitForTimeout(200);
    const composer = convo.locator(".composer");
    const pad = await composer.evaluate(e => parseFloat(getComputedStyle(e).paddingBottom));
    const top = await convo.locator(".bar").evaluate(e => parseFloat(getComputedStyle(e).paddingTop));
    assert(pad >= 34 && top >= 47, `insets not cleared: composer ${pad}px, header ${top}px`);
    // The on-screen keyboard (iOS shrinks the visual viewport; Chromium has no soft keyboard): 336 px of it.
    await convo.getByRole("textbox", { name: "Message builder" }).focus();
    await page.evaluate(() => {
      const vv = window.visualViewport as VisualViewport;
      Object.defineProperty(vv, "height", { configurable: true, get: () => window.innerHeight - 336 });
      Object.defineProperty(vv, "offsetTop", { configurable: true, get: () => 0 });
      vv.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(200);
    const box = await composer.boundingBox();
    const inner = await page.evaluate(() => innerHeight);
    assert(box !== null && box.y + box.height <= inner - 336 + 1, `the composer is under the keyboard: bottom ${box ? box.y + box.height : "?"}, keyboard from ${inner - 336}`);
    const padOpen = await composer.evaluate(e => parseFloat(getComputedStyle(e).paddingBottom));
    assert(padOpen < 34, `with the keyboard up the home-indicator padding stays: ${padOpen}px`);
    const header = await convo.locator(".bar").boundingBox();
    assert(header !== null && header.y >= 0, "the header left the screen");
    await page.screenshot({ path: join(OUT, "6-keyboard-light.png") });
    await page.evaluate(() => {
      const vv = window.visualViewport as VisualViewport;
      delete (vv as unknown as Record<string, unknown>).height;
      delete (vv as unknown as Record<string, unknown>).offsetTop;
      vv.dispatchEvent(new Event("resize"));
    });
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
    await page.getByRole("button", { name: "Back to chats" }).click();
  });

  await check("the digest's Mark all read moves each lane's read mark: their counts go from the chat list, and the digest from it", async () => {
    const before = await page.locator('[data-chat="reviewer"] .count').count();
    assert(before === 1, "the reviewer has no count to clear (the check's control)");
    await cameBackAfter(page, 9 * H);
    await digest(page).waitFor({ timeout: 10_000 });
    await page.locator("[data-digest]").first().waitFor({ timeout: 10_000 });
    const lanes = await page.locator("[data-digest]").evaluateAll(els => els.map(e => e.getAttribute("data-digest") ?? ""));
    assert(lanes.includes("reviewer") && lanes.includes("builder"), `lines: ${lanes.join(", ")}`);
    await page.getByRole("button", { name: "Mark all read" }).click();
    await digest(page).waitFor({ state: "detached" });
    for (const l of lanes) await page.locator(`[data-chat="${l}"] .count`).waitFor({ state: "detached", timeout: 10_000 });
    assert(!(await page.getByRole("button", { name: /While you were away/ }).count()), "the digest is still offered");
    await page.reload();                                                     // the hub has the marks, not just this page
    await page.locator("[data-chat]").first().waitFor();
    await page.waitForTimeout(2500);
    for (const l of lanes) assert(!(await page.locator(`[data-chat="${l}"] .count`).count()), `${l} has a count again after a reload`);
  });

  await check("a day on another device is no absence: no digest, though this phone was idle 9 hours", async () => {
    const desk = await pairedPage(browser, office);
    await desk.page.mouse.click(400, 300);                    // his input there: attending
    await desk.page.waitForTimeout(600);
    await cameBackAfter(page, 9 * H);
    await page.waitForTimeout(2500);
    assert(!(await digest(page).isVisible()), "the digest showed although he was active on the desktop");
    await desk.context.close();
  });

  await check("the settings: how long away before a digest, 4 hours by default, kept on the device", async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    const sheet = page.getByRole("dialog", { name: "Settings" });
    assert((await sheet.getByRole("radio", { checked: true }).innerText()) === "After 4 hours away", "default isn't 4 hours");
    await sheet.getByRole("radio", { name: "Only after a night" }).click();
    assert(await page.evaluate(() => localStorage.getItem("morndo.awayAfter")) === "overnight", "not kept");
    await shot(page, "7-settings");
    await sheet.getByRole("button", { name: "Done" }).click();
  });

  await check("never good forever without its echo: a lane message not seen after 10 min warns; a manager message the inbox hasn't delivered in 60 min says so, never Not sent while the inbox holds it; Check never doubles it; a draft survives leaving the chat", async () => {
    // A second phone on a fake clock (Playwright's clock): the page's time jumps, the hub's doesn't.
    const ph = await pairedPage(browser, office, { width: 390, height: 844, phone: true, ready: "nav.tabbar" });
    try {
      await ph.context.clock.install();
      await ph.page.reload();
      await ph.page.locator("[data-chat]").first().waitFor({ timeout: 15_000 });
      await ph.page.locator('[data-chat="builder"]').click();
      const lane = ph.page.getByRole("region", { name: "Conversation with builder" });
      await lane.getByRole("textbox", { name: "Message builder" }).fill("Typed but never echoed");
      await lane.getByRole("button", { name: "Send" }).click();
      await until(() => screen("builder").includes("Typed but never echoed"), 10_000, "typed into builder");
      const typed = lane.locator("[data-outbox]", { hasText: "Typed but never echoed" });
      await until(async () => (await typed.getAttribute("data-delivery")) === "delivered", 10_000, "delivered");
      await ph.page.clock.fastForward("11:00");
      await until(async () => (await typed.getAttribute("data-delivery")) === "unseen", 20_000, "the unseen warning");
      assert(/not seen in its conversation after 10 min/.test(await typed.innerText()), `lane bubble: ${await typed.innerText()}`);
      await ph.page.screenshot({ path: join(OUT, "8-unseen-light.png") });
      await ph.page.getByRole("button", { name: "Back to chats" }).click();
      await ph.page.locator('[data-chat="manager"]').click();
      const mgr = ph.page.getByRole("region", { name: "Conversation with Manager" });
      await mgr.getByRole("textbox", { name: "Message Manager" }).fill("Lost in the inbox");
      await mgr.getByRole("button", { name: "Send" }).click();
      const queued = mgr.locator("[data-outbox]", { hasText: "Lost in the inbox" });
      await until(async () => (await queued.getAttribute("data-delivery")) === "queued", 10_000, "queued for the manager");
      await ph.page.clock.fastForward("01:01:00");
      await until(async () => (await queued.getAttribute("data-delivery")) === "late", 20_000, "late after 60 minutes");
      // With no inbox word yet the bubble says "Not delivered after 60 min". The spool poll asks again after two
      // minutes, so a jump of an hour usually already has the inbox's word: still waiting, never Not sent (review #2).
      const bubble = await queued.innerText();
      assert((/Not delivered after 60 min/.test(bubble) || /Still waiting in the manager's inbox/.test(bubble)) && !/Not sent/.test(bubble), `manager bubble: ${bubble.replace(/\s+/g, " ")}`);
      await ph.page.screenshot({ path: join(OUT, "8-late-light.png") });
      const lost = () => inbox().filter(x => x.text === "Lost in the inbox");
      // Check while the first may still arrive (the inbox still holds it): the same request id, nothing new queued, and the
      // bubble says it is still in the inbox (review #2, the team's call A).
      await queued.getByRole("button", { name: "Check" }).click();
      await until(async () => /inbox/.test(await queued.innerText()), 15_000, "the check reports where it stands");
      assert(lost().length === 1, `a second message was queued while the first can still arrive: ${JSON.stringify(lost())}`);
      assert((await queued.getAttribute("data-delivery")) === "late", "a status check must not send the message again");
      // The inbox gives the first up. Check only reads that; Send again queues it once more, and only once.
      deliverer(lost()[0].key, { status: "expired" });
      await queued.getByRole("button", { name: "Check" }).click();
      await until(async () => (await queued.getAttribute("data-delivery")) === "lost", 15_000, "lost once the inbox gave it up");
      assert(lost().length === 1, `Check queued a second copy: ${JSON.stringify(lost())}`);
      await queued.getByRole("button", { name: "Send again" }).click();
      await until(() => lost().length === 2, 10_000, "queued once more after the first was given up");
      assert(lost().some(x => String(x.id).endsWith(":again")), `ids: ${JSON.stringify(lost().map(x => x.id))}`);
      await until(async () => (await queued.getAttribute("data-delivery")) === "queued", 10_000, "queued after Send again");
      // Its echo ends it, as any other.
      echo("manager", "phone-echo-again", "Lost in the inbox");
      await queued.waitFor({ state: "detached", timeout: 10_000 });
      // A draft survives leaving the chat.
      await mgr.getByRole("textbox", { name: "Message Manager" }).fill("A thought for later");
      await ph.page.waitForTimeout(600);
      await ph.page.getByRole("button", { name: "Back to chats" }).click();
      await ph.page.locator('[data-chat="manager"]').click();
      assert((await mgr.getByRole("textbox", { name: "Message Manager" }).inputValue()) === "A thought for later", "the draft is gone");
    } finally { await ph.context.close(); }
  });

  await check("both themes: every text and background pair on these screens meets the brand's contrast targets", async () => {
    assert(!contrast.length, contrast.slice(0, 8).join("\n      "));
  });
  await check("no console errors", async () => {
    assert(!errors.filter(e => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|WebSocket/.test(e)).length, errors.join(" | "));
  });
  code = finish();
} catch (e) {
  console.log(`FAIL  setup: ${(e as Error).message}`);
} finally {
  clearInterval(beating);
  await browser.close();
  office.stop();
  process.exit(code);
}
