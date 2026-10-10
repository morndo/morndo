// End-to-end checks of the phone's catch-up (ADR-0009; the design's done criteria 1 to 20, docs/design/mobile-catchup)
// at 390 px on a synthetic office with its own hub and tmux server, in Playwright's own Chromium. A desktop at 1920 px
// is paired too, for what must show there. Nothing here reads or touches the real lanes, the real hub or its data.
// Since ADR-0011 catch-up holds decisions only: the checks of update cards are retired (listed with their reasons in
// a private QA record, not in this tree), and what they covered that still matters is checked on the chats that replaced them.
// Run: npm run build && node e2e/catchup.e2e.ts
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { chromium, type Page } from "playwright";
import { contrastProblems } from "./contrast.ts";
import { HUB_MAIN, assert, checks, outDir, pairedPage, startOffice } from "./harness.ts";

const OUT = outDir("catchup");
const office = await startOffice("catchup");
const { tmux, office: o } = office;
const { panes, ledger, writeLedger } = o;
const { check, watch, finish } = checks(OUT);
const browser = await chromium.launch();
let code = 1;

// ---- the office's side: panes, the audit, transcripts, the list, the database
const pane = (name: string) => tmux("capture-pane", "-p", "-J", "-t", panes[name] ?? "", "-S", "-300");
const audit = () => execFileSync(process.execPath, ["--no-warnings", HUB_MAIN, "audit", "500"], { env: office.env, encoding: "utf8" });
const answeredIn = (id: string) => audit().split("\n").filter(l => l.includes("EscalationAnswered") && l.includes(`"${id}"`)).length;
const transcriptOf = (name: string) => join(o.claudeDir, "projects", "-qa", `s-${name}.jsonl`);
let n = 0;
const say = (name: string, text: string) => appendFileSync(transcriptOf(name), JSON.stringify({
  type: "assistant", uuid: `e2e-${name}-${++n}`, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text }] },
}) + "\n");
// What Claude Code writes when the prompt typed into it is taken in: the principal's own line, the echo (S8).
const echo = (name: string, text: string) => appendFileSync(transcriptOf(name), JSON.stringify({
  type: "user", uuid: `e2e-echo-${++n}`, timestamp: new Date().toISOString(), origin: { kind: "human" }, message: { role: "user", content: text },
}) + "\n");
const items = ledger.needsYou as Record<string, unknown>[];
const addDecision = (id: string, question: string, extra: Record<string, unknown> = {}) => {
  items.push({ id, kind: "tap", question, default: "wait a day", deadline: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10), ts: new Date().toISOString(), ...extra });
  writeLedger(ledger);
};
const closeDecision = (id: string, answer: string) => {
  for (const i of items) if (i.id === id) Object.assign(i, { status: "closed", answer, closedAt: new Date().toISOString() });
  writeLedger(ledger);
};
// AC7: this endpoint's last passkey check, made older than the policy allows (the hub reads it on every request).
const ageVerification = (endpointId: string, minutes: number) => {
  const db = new Database(join(office.home, "morndo.db"));
  try { db.prepare("UPDATE sessions SET verified_at = ? WHERE endpoint_id = ? AND ended_at IS NULL").run(Date.now() - minutes * 60_000, endpointId); }
  finally { db.close(); }
};
// A tap where the tab bar shows (e2e/phone-chat.e2e.ts: Playwright's own click scrolls a sticky bar's static place into
// view first, where the list lies).
async function tapTab(page: Page, name: string) {
  const box = await page.locator("nav.tabbar button", { hasText: name }).boundingBox();
  if (!box) throw new Error(`no ${name} tab`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
const until = async (cond: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise(r => setTimeout(r, 150)); }
  if (!(await cond())) throw new Error(`timed out: ${what}`);
};

try {
  // The desktop opens a worker with no messages, so it marks nothing read on its own while the phone is checked.
  const desk = await pairedPage(browser, office, { init: () => localStorage.setItem("morndo.channel", JSON.stringify("worker-01")) });
  const { page, context, errors } = await pairedPage(browser, office, { width: 390, height: 844, phone: true, ready: "nav.tabbar", init: () => localStorage.setItem("morndo.tab", "today") });
  watch(page);
  const me = await page.evaluate(() => fetch("/api/me").then(r => r.json()) as Promise<{ endpoint: { id: string } }>);
  // Every frame the phone sends on its live feed, and every catch-up frame it gets.
  const sent: Record<string, unknown>[] = [], got: Record<string, unknown>[] = [];
  page.on("websocket", ws => {
    if (!ws.url().endsWith("/api/feed")) return;
    ws.on("framesent", f => { try { sent.push({ ...JSON.parse(String(f.payload)), _at: Date.now() }); } catch { /* not JSON */ } });
    ws.on("framereceived", f => { try { const m = JSON.parse(String(f.payload)); if (m.t === "catchup" || m.t === "caught_up") got.push(m); } catch { /* not JSON */ } });
  });
  const posts: string[] = [];
  page.on("request", r => { if (r.method() === "POST") posts.push(new URL(r.url()).pathname); });
  // The feed's socket opened while pairing, before these listeners: load the app again so they see its socket.
  await page.reload();
  await page.locator("nav.tabbar").waitFor();
  await until(() => sent.some(f => f.t === "hello"), 8000, "the phone's feed socket observed");
  const shot = async (name: string) => {
    await page.screenshot({ path: join(OUT, `${name}-light.png`) });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: join(OUT, `${name}-dark.png`) });
    await page.emulateMedia({ colorScheme: "light" });
  };
  const card = page.locator("article.card");
  const top = () => card.getAttribute("data-card");
  const runOrder = () => page.evaluate(() => (JSON.parse(localStorage.getItem("morndo.catchup.run") ?? "null") as { run: { order: string[] } } | null)?.run.order ?? []);
  const catchUp = page.getByRole("button", { name: /^Decide · \d+/ });
  const nOnPhone = async () => Number(/Decide · (\d+)/.exec(await catchUp.innerText())?.[1] ?? -1);
  const undoTop = page.locator(".cu-top .undo");
  const toCard = (key: string) => until(async () => (await top()) === key, 8000, `card ${key} on top`);
  const contrast: string[] = [];
  // Resting states: the pointer is moved off the page first (a hovered row's state layer is the brand test's own rule,
  // "text on hover", checked there for bg, surface and raised).
  const contrastOf = async (where: string) => {
    await page.mouse.move(0, 0);
    await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const p of await contrastProblems(page, theme)) contrast.push(`${where}, ${theme}: ${p}`);
    }
    await page.emulateMedia({ colorScheme: "light" });
  };

  await check("1. Today shows Decide · N, and N is the open decisions only: unread conversations add nothing (ADR-0011)", async () => {
    await catchUp.waitFor({ timeout: 10_000 });
    const board = await page.evaluate(() => fetch("/api/escalations").then(r => r.json()) as Promise<{ items: { id: string; status: string; need: string }[] }>);
    const open = board.items.filter(i => i.status === "open" && i.need === "decision").map(i => i.id).sort();
    assert(JSON.stringify(open) === JSON.stringify(["ny-7", "ny-8", "q-q1"]), `open decisions ${JSON.stringify(open)}`);
    await until(async () => (await nOnPhone()) === 3, 8000, "N = the 3 open decisions; manager, builder and reviewer have unread messages");
    const badge = await page.getByRole("navigation", { name: "Morndo" }).locator("button", { hasText: "Today" }).locator(".badge").innerText();
    assert(badge.trim() === "3", `Today's badge ${badge}`);
    await contrastOf("Today");
    await shot("1-today");
  });

  await check("2. decisions in order (blocking, then the earliest due time, then the oldest), and no update cards", async () => {
    await catchUp.click();
    await card.waitFor();
    await until(async () => (await runOrder()).length === 3, 5000, "a run of 3 cards");
    const order = await runOrder();
    assert(JSON.stringify(order) === JSON.stringify(["d:ny-7", "d:ny-8", "d:q-q1"]), `order ${JSON.stringify(order)}`);
    assert((await top()) === "d:ny-7", "the blocking decision isn't on top");
    await page.getByText("3 left").waitFor();
    await page.getByText("3 to decide", { exact: true }).waitFor();
    assert(await page.locator(".segments i.decide").count() === 3 && await page.locator(".segments i").count() === 3, "segments");
    await contrastOf("decision card");
    await shot("2-decision");
  });

  await check("4. a decision can't be marked read: swiping right changes nothing in the hub, and the card stays", async () => {
    const before = { sent: sent.length, posts: posts.length, audit: answeredIn("ny-7") };
    const box = await card.boundingBox();
    if (!box) throw new Error("no card");
    await page.mouse.move(box.x + 60, box.y + 40);                         // on the card's head, not a button
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 44, { steps: 12 });
    await page.mouse.up();
    await page.getByText("A decision is never marked read. Answer it, or swipe left for later.").waitFor();
    await page.locator(".hint.flash").waitFor();
    await page.waitForTimeout(6000);
    assert((await top()) === "d:ny-7", `the card changed: ${await top()}`);
    assert(sent.slice(before.sent).every(f => f.t !== "read"), "a read mark was sent");
    assert(posts.length === before.posts && answeredIn("ny-7") === before.audit, "something was answered");
  });

  await check("8a. Undo within 5 seconds brings the decision back, and no answer is sent", async () => {
    await card.getByRole("button", { name: /^Hold for a day/ }).click();
    await card.getByText("Answered: Hold for a day").waitFor();
    await shot("8-answered-undo");
    // A swipe left inside the window doesn't hide the pending answer behind another card (review, 2026-10-04).
    const box = await card.boundingBox();
    if (!box) throw new Error("no card");
    await page.mouse.move(box.x + 300, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 20, box.y + 46, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    assert((await top()) === "d:ny-7" && await card.getByText("Answered: Hold for a day").count() === 1, "the swipe moved the answering card");
    await undoTop.click();
    await card.getByRole("button", { name: /^Hold for a day/ }).waitFor();
    await page.waitForTimeout(6000);
    assert(!pane("manager").includes("[tap ny-7] hold"), "the hold answer reached the manager");
    assert(answeredIn("ny-7") === 0 && !posts.some(p => p.includes("/answer")), "an answer was sent");
  });

  await check("3. tapping an option answers through the existing path: the manager gets the tap line, and the audit has one EscalationAnswered", async () => {
    await card.getByRole("button", { name: /^Ship it/ }).click();
    await card.getByText("Answered: Ship it").waitFor();
    await toCard("d:ny-8");
    await until(() => pane("manager").includes("[tap ny-7] ship (Ship it)"), 8000, "the tap line in the manager's pane");
    assert(answeredIn("ny-7") === 1, `EscalationAnswered for ny-7: ${answeredIn("ny-7")}`);
    assert(posts.filter(p => p === "/api/escalations/ny-7/answer").length === 1, "not one answer request");
  });

  await check("5. Later leaves the decision open, takes it out of this run, and it shows on the dashboard", async () => {
    await page.getByRole("button", { name: "Later" }).click();
    await toCard("d:q-q1");
    const ny8 = await page.evaluate(() => fetch("/api/escalations").then(r => r.json()).then((b: { items: { id: string; status: string }[] }) => b.items.find(i => i.id === "ny-8")?.status));
    assert(ny8 === "open", `ny-8 is ${ny8}`);
    await card.getByRole("button", { name: "Answer on its screen" }).waitFor();          // a worker's question
    await page.getByRole("button", { name: "Later" }).click();
    await page.getByText("You're caught up.").waitFor();                                // no update cards follow (ADR-0011)
  });

  await check("13. the end screen's counts equal what was done in the run, and the hub hears it was caught up", async () => {
    await page.getByText("You're caught up.").waitFor();
    const chip = (k: string) => page.locator(`[data-count="${k}"]`).innerText();
    assert(await chip("decided") === "1 decided" && await chip("later") === "2 kept for later" && await page.locator('[data-count="read"], [data-count="kept"]').count() === 0,
      `counts ${await page.locator(".sum").innerText()}`);
    await page.getByRole("button", { name: /Kept for later: Which day should the launch post go out\?/ }).waitFor();
    await until(() => sent.some(f => f.t === "caught_up"), 3000, "caught_up sent");
    await contrastOf("end screen");
    await shot("5-caught-up");
  });

  await check("5b and 25. on the dashboard the kept decision shows, and Decide now opens its card", async () => {
    await page.getByRole("button", { name: "See your day" }).click();
    const row = page.locator('[data-row="d:ny-8"]');
    await row.getByText("You kept this for later.").waitFor();
    await row.getByRole("button", { name: "Decide now" }).click();
    await toCard("d:ny-8");
  });

  await check("12. a decision from a muted conversation still has its card", async () => {
    await desk.page.locator("aside.side").getByRole("button", { name: /reviewer/ }).first().click({ button: "right" });
    await desk.page.getByRole("menuitem", { name: "Mute conversation" }).click();
    await until(() => desk.page.locator("aside.side button.row.muted", { hasText: "reviewer" }).count().then(n => n > 0), 8000, "the reviewer muted");
    await page.waitForTimeout(1500);
    assert((await runOrder()).includes("d:q-q1"), "the reviewer's question lost its card");
  });

  await check("9. a decision settled while its answer waits shows the refusal on the card, and nothing is answered", async () => {
    await card.getByRole("button", { name: "Go with the default" }).click();
    await card.getByText("Answered: go with the default").waitFor();
    closeDecision("ny-8", "Decided on Telegram: Thursday");
    await card.getByText("The manager has already settled this.").waitFor({ timeout: 12_000 });
    await card.getByText(/Settled: Decided on Telegram: Thursday/).waitFor();
    await shot("6-refused");
    assert(answeredIn("ny-8") === 0 && !pane("manager").includes("About ny-8"), "ny-8 was answered");
    await card.getByRole("button", { name: "Next card" }).click();
    await toCard("d:q-q1");
  });

  await check("16. every gesture has a button, every button is at least 44 px high with a name; an agent's new message adds no card", async () => {
    // Measured once the card's entry animation is over (it scales the card by 0.98 while it runs).
    const small = async () => { await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {})))); return page.locator(".cu button:visible, .cu a:visible, nav.tabbar button").evaluateAll(els => els.flatMap(el => {
      const r = el.getBoundingClientRect(), name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
      return r.height < 44 || !name ? [`${name || el.outerHTML.slice(0, 60)}: ${Math.round(r.height)} px`] : [];
    })); };
    const found: string[] = [...await small()];                              // the reviewer's question
    for (const b of ["Later", "Open the chat"]) await page.getByRole("button", { name: b, exact: true }).waitFor();
    say("builder", "STATUS: DONE. The forgot-password link points at the new page now.");
    say("manager", "Night shift is queued: 3 tasks.");
    await page.waitForTimeout(4000);                                         // the hub polls every 400 ms here
    assert((await runOrder()).every(k => k.startsWith("d:")), `an update joined the run: ${JSON.stringify(await runOrder())}`);
    assert(found.length === 0, `too small or unnamed: ${found.join("; ")}`);
  });

  await check("6 (on the chats). reading a chat to its end moves the read mark to its last message, and the desktop shows it read within 2 seconds", async () => {
    await page.getByRole("button", { name: "Later", exact: true }).click();
    await page.getByText("You're caught up.").waitFor();
    await page.getByRole("button", { name: "See your day" }).click();
    await tapTab(page, "Chats");
    const b = sent.length;
    await page.locator('[data-chat="builder"]').click();
    await page.getByRole("region", { name: "Conversation with builder" }).locator(".b").last().waitFor();
    await until(() => sent.slice(b).some(f => f.t === "read" && f.conversation === "builder"), 8000, "the read mark for builder");
    const frame = sent.slice(b).find(f => f.t === "read" && f.conversation === "builder") as { at: number; _at: number };
    await desk.page.locator("aside.side button.row.unread", { hasText: "builder" }).waitFor({ state: "detached", timeout: 2500 });
    assert(Date.now() - frame._at <= 2500, `the desktop took ${Date.now() - frame._at} ms`);
  });

  await check("11 (on the chats). a reply from a chat goes through the outbox, is typed into the pane exactly once, and its echo ends it", async () => {
    const text = ": e2e-chat-reply-11";
    const convo = page.getByRole("region", { name: "Conversation with builder" });
    await convo.getByRole("textbox", { name: "Message builder" }).fill(text);
    await convo.getByRole("button", { name: "Send" }).click();
    await until(() => pane("builder").includes("e2e-chat-reply-11"), 10_000, "the reply typed into the builder's pane");
    assert(posts.some(p => /^\/api\/workers\/%\d+\/send$/.test(p)), "the reply didn't go through the send endpoint");
    echo("builder", text);                                                      // Claude Code takes it in
    await convo.locator("[data-outbox]").waitFor({ state: "detached", timeout: 10_000 });
    await convo.locator(".b.mine", { hasText: "e2e-chat-reply-11" }).waitFor();
    const typed = pane("builder").split("\n").filter(l => l.includes("e2e-chat-reply-11")).length;
    assert(typed === 1, `typed ${typed} times`);
    await shot("4-reply");
    await page.getByRole("button", { name: "Back to chats" }).click();
  });

  await check("10. with a passkey check older than his setting, deciding and replying ask for the passkey first, then complete", async () => {
    const r = await page.evaluate(() => fetch("/api/policy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stay: "7d", stepUp: "10m" }) }).then(x => x.status));
    assert(r === 200, `tightening the policy answered ${r}`);
    addDecision("ny-11", "Which logo goes on the invoice?");
    addDecision("ny-13", "Rename the demo office?");
    say("builder", "Logo options are in the design folder.");
    ageVerification(me.endpoint.id, 11);                                     // as if 11 minutes passed
    await page.reload();
    await page.locator("nav.tabbar").waitFor();
    await tapTab(page, "Today");
    const order: string[] = [];
    const onReq = (q: import("playwright").Request) => { const p = new URL(q.url()).pathname; if (p === "/api/stepup/verify" || p.endsWith("/answer") || /\/send$/.test(p)) order.push(p); };
    page.on("request", onReq);
    await until(async () => (await nOnPhone()) === 3, 10_000, "N = ny-11 + ny-13 + q-q1");
    await catchUp.click();
    await toCard("d:ny-11");
    await card.getByRole("button", { name: "Answer in my own words" }).click();
    await card.getByRole("textbox").fill("The round one");
    await card.getByRole("button", { name: "Send to Manager" }).click();
    await card.getByText("Answered: your own words").waitFor({ timeout: 10_000 });
    await until(() => pane("manager").includes("About ny-11: The round one"), 12_000, "the words in the manager's pane");
    assert(order[0] === "/api/stepup/verify" && order[1] === "/api/escalations/ny-11/answer", `asked first: ${JSON.stringify(order)}`);
    // The check went stale while the card was open (the hub judges it on arrival): the card asks, then it goes.
    await toCard("d:ny-13");
    ageVerification(me.endpoint.id, 11);
    order.length = 0;
    await card.getByRole("button", { name: "Go with the default" }).click();
    await card.getByRole("button", { name: "Confirm with passkey and send" }).click({ timeout: 12_000 });
    await until(() => pane("manager").includes("About ny-13: Go with the default"), 12_000, "ny-13's answer in the manager's pane");
    assert(JSON.stringify(order) === JSON.stringify(["/api/escalations/ny-13/answer", "/api/stepup/verify", "/api/escalations/ny-13/answer"]), `refused, verified, sent: ${JSON.stringify(order)}`);
    await toCard("d:q-q1");
    await page.getByRole("button", { name: "Later", exact: true }).click();
    await page.getByText("You're caught up.").waitFor();
    ageVerification(me.endpoint.id, 11);
    await page.reload();                                                     // the phone learns the check is stale
    await page.locator("nav.tabbar").waitFor();
    await tapTab(page, "Chats");
    await page.locator('[data-chat="builder"]').click();
    order.length = 0;
    const convo = page.getByRole("region", { name: "Conversation with builder" });
    await convo.getByRole("textbox", { name: "Message builder" }).fill(": e2e-stale-reply-10");
    await convo.getByRole("button", { name: "Send" }).click();
    await until(() => pane("builder").includes("e2e-stale-reply-10"), 12_000, "the reply typed into builder's pane");
    assert(order[0] === "/api/stepup/verify" && /\/send$/.test(order[1] ?? ""), `asked first: ${JSON.stringify(order)}`);
    page.off("request", onReq);
    await page.getByRole("button", { name: "Back to chats" }).click();
  });

  await check("15. offline: a loaded decision card stays readable and says why an answer can't go; a chat's reply queues and is typed on the next visit", async () => {
    await tapTab(page, "Today");
    addDecision("ny-12", "Archive the old demo data?");
    await until(async () => (await nOnPhone()) === 2, 10_000, "N = ny-12 + q-q1");
    await catchUp.click();
    await toCard("d:ny-12");
    try {
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    const p = posts.length;
    await card.getByRole("button", { name: "Go with the default" }).click();
    await card.getByText(/You're offline\. A decision goes only while Morndo is connected/).waitFor();
    await shot("7-offline-decision");
    await page.getByRole("button", { name: "Later", exact: true }).click();
    await toCard("d:q-q1");
    await page.getByRole("button", { name: "Later", exact: true }).click();
    await page.getByText("You're caught up.").waitFor();
    await page.getByRole("button", { name: "See your day" }).click();
    await tapTab(page, "Chats");
    await page.locator('[data-chat="builder"]').click();
    const convo = page.getByRole("region", { name: "Conversation with builder" });
    await convo.getByRole("textbox", { name: "Message builder" }).fill(": e2e-offline-reply-15");
    await convo.getByRole("button", { name: "Send" }).click();
    await convo.locator("[data-outbox]").getByText(/Queued · sends when you're back online/).waitFor();
    await shot("7-offline-reply");
    await page.waitForTimeout(3000);
    assert(posts.length === p, "something went out offline");
    await context.setOffline(false);
    await page.reload();                                                     // as if iOS had discarded the page
    await page.locator("nav.tabbar").waitFor();
    await until(() => pane("builder").includes("e2e-offline-reply-15"), 20_000, "the queued reply typed on the next visit");
    } finally {                                                               // never leave the next checks offline
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event("online"))).catch(() => {});
    }
  });

  await check("15b (on the chats). a read mark set offline is kept on the device and sent on the next visit, then cleared", async () => {
    await page.goto(office.base);
    await page.locator("nav.tabbar").waitFor();
    await tapTab(page, "Chats");
    await page.locator('[data-chat="manager"]').click();
    const convo = page.getByRole("region", { name: "Conversation with Manager" });
    const scroller = convo.locator(".scroll");
    await convo.locator(".b").last().waitFor();
    await scroller.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });   // reading far up
    const saidAt = Date.now() - 1000;
    say("manager", "e2e-offline-mark-15: the night summary is ready.");
    await convo.getByText("e2e-offline-mark-15").waitFor({ state: "attached", timeout: 10_000 });
    await page.waitForTimeout(1500);
    const markFrames = () => sent.filter(f => f.t === "read" && f.conversation === "manager" && (f.at as number) >= saidAt);
    assert(markFrames().length === 0, "marked read while reading far up");
    try {
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await page.waitForTimeout(500);
      const before = sent.length;
      await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event("scroll")); });   // read to the end, offline
      await until(() => page.evaluate(at => ((JSON.parse(localStorage.getItem("morndo.unsent-reads") ?? "{}") as Record<string, number>).manager ?? 0) >= at, saidAt), 8000, "the mark kept on the device");
      await page.waitForTimeout(1500);
      assert(sent.slice(before).every(f => f.t !== "read"), "a read mark went out offline");
      await context.setOffline(false);
      await page.reload();                                                   // the next visit
      await page.locator("nav.tabbar").waitFor();
      await until(() => markFrames().length > 0, 20_000, "the kept mark sent on the next visit");
      await until(() => page.evaluate(() => localStorage.getItem("morndo.unsent-reads") === null), 8000, "the kept mark cleared once the hub has it");
    } finally {
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event("online"))).catch(() => {});
    }
  });

  await check("14. a push about decisions opens catch-up at a decision card", async () => {
    addDecision("ny-14", "Move the demo to Friday?");
    await page.goto(`${office.base}/?view=decisions`);
    await page.locator(".cu").waitFor({ timeout: 10_000 });
    await until(async () => (await top())?.startsWith("d:") ?? false, 8000, "a decision card on top");
    assert(!page.url().includes("view="), "the address keeps ?view");
  });

  await check("leaving catch-up (or putting the phone away) sends an answer in its window at once, not hours later", async () => {
    const id = (await top())?.slice(2) ?? "";                                // ny-12 or ny-14, both answered in words
    assert(id.startsWith("ny-1"), `a list decision on top: ${id}`);
    await card.getByRole("button", { name: "Go with the default" }).click();
    await card.getByText("Answered: go with the default").waitFor();
    const left = Date.now();
    await page.locator(".cu-top .back").click();
    await until(() => pane("manager").includes(`About ${id}: Go with the default`), 4000, `${id}'s answer sent on leaving`);
    assert(Date.now() - left < 4000, "it waited for the window");
  });

  await check("19 (Status). the Status tab lists every lane in one line, and a lane's chat shows its screen read-only", async () => {
    await page.goto(office.base);
    await page.locator("nav.tabbar").waitFor();
    await tapTab(page, "Status");
    await page.locator('[data-status="builder"]').waitFor();
    await contrastOf("Status");
    await shot("8-status");
    await page.locator('[data-status="builder"]').click();
    await page.getByRole("tab", { name: "Screen" }).click();
    await until(() => page.evaluate(() => (document.querySelector("pre.screen")?.textContent ?? "").includes("e2e-offline-reply-15")), 8000, "the builder's screen");
    await shot("8-agent-screen");
    await page.getByRole("button", { name: "Back to chats" }).click();
  });

  await check("17. light and dark: every text and background pair used is one the brand's contrast test passes", async () => {
    assert(contrast.length === 0, `${contrast.length} pairs: ${contrast.slice(0, 6).join(" | ")}`);
    // Negative control: muted text planted on a tint (COLOR.md rule 8 forbids it) is caught.
    await page.evaluate(() => { const p = document.createElement("p"); p.id = "probe"; p.textContent = "probe text"; p.style.cssText = "color: var(--muted); background: var(--fill); position: fixed; top: 0; left: 0; z-index: 99"; document.body.append(p); });
    const caught = await contrastProblems(page, "light");
    await page.evaluate(() => document.getElementById("probe")?.remove());
    assert(caught.some(x => x.includes("probe text") && x.includes("textMuted") && x.includes("fill")), `the planted pair wasn't caught: ${JSON.stringify(caught)}`);
  });

  await check("18. with reduced motion set, cards change without sliding", async () => {
    const still = await pairedPage(browser, office, { width: 390, height: 844, phone: true, ready: "nav.tabbar", init: () => localStorage.setItem("morndo.tab", "today"), reducedMotion: "reduce" });
    try {
      const sp = still.page;
      await sp.getByRole("button", { name: /^Decide · \d+/ }).click();
      const c = sp.locator("article.card");
      await c.waitFor();
      const first = await c.getAttribute("data-card");
      await sp.getByRole("button", { name: "Later", exact: true }).click();
      await until(async () => (await c.getAttribute("data-card")) !== first, 3000, "the next card");
      const style = await c.evaluate(el => { const s = getComputedStyle(el); return { transition: s.transitionDuration, animation: s.animationName, transform: s.transform }; });
      assert(style.transition === "0s" && style.animation === "none" && style.transform === "none", `with reduced motion: ${JSON.stringify(style)}`);
      // The phone without reduced motion does slide its cards: the check can tell the two apart.
      await tapTab(page, "Today");
      await catchUp.click();
      await card.waitFor();
      const normal = await page.locator("article.card").evaluate(el => getComputedStyle(el).transitionDuration);
      assert(normal !== "0s", `without reduced motion the card has no transition (${normal})`);
    } finally { await still.context.close(); }
  });

  await check("turning the device across 900 px (phone, desktop, phone) keeps replies going: the outbox hands its lock on", async () => {
    say("builder", "Rotation check: one more note.");
    await page.goto(office.base);
    await page.locator("nav.tabbar").waitFor();
    await page.setViewportSize({ width: 1000, height: 844 });
    await page.locator(".desk").waitFor({ timeout: 10_000 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("nav.tabbar").waitFor({ timeout: 10_000 });
    await tapTab(page, "Chats");
    await page.locator('[data-chat="builder"]').click();
    const convo = page.getByRole("region", { name: "Conversation with builder" });
    await convo.getByRole("textbox", { name: "Message builder" }).fill(": e2e-after-rotation");
    await convo.getByRole("button", { name: "Send" }).click();
    await until(() => pane("builder").includes("e2e-after-rotation"), 15_000, "the reply typed after turning the device");
  });

  code = finish();
  // 409: the refusal check 9 provokes; 403: the stale passkey check 10 provokes.
  const unexpected = errors.filter(e => !/status of (409|403)/.test(e));
  if (unexpected.length) console.log(`page errors: ${unexpected.join(" | ")}`);
  if (contrast.length) console.log(`contrast:\n  ${contrast.join("\n  ")}`);
  void context;
} finally {
  await browser.close();
  office.stop();
}
process.exit(code);
