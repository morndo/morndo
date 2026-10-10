// Edge cases of the phone's catch-up that the review of PR #7 found (ADR-0009), each a check that failed before its
// fix: at 390 px on a synthetic office with its own hub and tmux server, in Playwright's own Chromium. Nothing here reads
// or touches the real lanes, the real hub or its data. Run: npm run build && node e2e/catchup-edges.e2e.ts
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { HUB_MAIN, assert, checks, outDir, pairedPage, startOffice } from "./harness.ts";

const OUT = outDir("catchup-edges");
const office = await startOffice("edges");
const { tmux, office: o } = office;
const { panes } = o;
const { check, watch, finish } = checks(OUT);
const browser = await chromium.launch();
let code = 1;

const pane = (name: string) => tmux("capture-pane", "-p", "-J", "-t", panes[name] ?? "", "-S", "-300");
const audit = () => execFileSync(process.execPath, ["--no-warnings", HUB_MAIN, "audit", "500"], { env: office.env, encoding: "utf8" });
const transcriptOf = (name: string) => join(o.claudeDir, "projects", "-qa", `s-${name}.jsonl`);
let n = 0;
const put = (name: string, line: Record<string, unknown>) => appendFileSync(transcriptOf(name), JSON.stringify(line) + "\n");
const say = (name: string, text: string) => put(name, {
  type: "assistant", uuid: `edge-${name}-${++n}`, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text }] },
});
const until = async (cond: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise(r => setTimeout(r, 150)); }
  if (!(await cond())) throw new Error(`timed out: ${what}`);
};

try {
  const { page, context, errors, cdp } = await pairedPage(browser, office, { width: 390, height: 844, phone: true, ready: "nav.tabbar", init: () => localStorage.setItem("morndo.tab", "today"), serviceWorkers: "block" });
  watch(page);
  const card = page.locator("article.card");
  // The card on top, or null once the run is over (decisions only since ADR-0011: the end comes sooner).
  const top = async () => ((await card.count()) ? card.getAttribute("data-card") : null);
  const toCard = (key: string) => until(async () => (await top()) === key, 8000, `card ${key} on top`);
  const later = () => page.getByRole("button", { name: "Later", exact: true }).click();
  // A tap where the tab bar shows (e2e/phone-chat.e2e.ts: Playwright's own click scrolls a sticky bar's static place
  // into view first, where the list lies).
  const tapTab = async (pg: import("playwright").Page, name: string) => {
    const box = await pg.locator("nav.tabbar button", { hasText: name }).boundingBox();
    if (!box) throw new Error(`no ${name} tab`);
    await pg.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  // Since ADR-0011 replies are written in a lane's chat (the update cards are gone).
  const openChat = async (pg: import("playwright").Page, name: string) => {
    if (await pg.locator(".cu-top .back").count()) await pg.locator(".cu-top .back").click();
    if (await pg.getByRole("button", { name: "Back to chats" }).count()) await pg.getByRole("button", { name: "Back to chats" }).click();
    await tapTab(pg, "Chats");
    await pg.locator(`[data-chat="${name}"]`).click();
    return pg.getByRole("region", { name: `Conversation with ${name}` });
  };
  void context;

  await check("#1 a reply written while an agent waited on a question is refused as stale once the question closed", async () => {
    const convo = await openChat(page, "reviewer");
    await convo.locator(".sub.waits").waitFor();                                                  // reviewer waits on its question (q1)
    await convo.getByRole("textbox", { name: "Message reviewer" }).fill(": e2e-stale-reply-1 keep the old endpoint");
    // The question is answered at the terminal while the reply is still being written.
    put("reviewer", { type: "user", uuid: `edge-answer-${++n}`, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "q1", content: "Keep it" }] } });
    await convo.locator(".sub.waits").waitFor({ state: "detached", timeout: 10_000 });
    await convo.getByRole("button", { name: "Send" }).click();
    await convo.locator("[data-outbox]", { hasText: "e2e-stale-reply-1" }).getByText("The question changed: review before sending.").waitFor({ timeout: 10_000 });
    assert(!pane("reviewer").includes("e2e-stale-reply-1"), "the stale reply was typed into the agent");
    await convo.locator("[data-outbox]", { hasText: "e2e-stale-reply-1" }).getByRole("button", { name: "Discard" }).click();
    await page.getByRole("button", { name: "Back to chats" }).click();
    await tapTab(page, "Today");
  });

  await check("#5 an answer waiting out its 5 s doesn't answer the question if it was asked again meanwhile", async () => {
    await page.locator('li.ev[data-row="d:ny-7"]').getByRole("button", { name: "Decide now" }).click();
    await toCard("d:ny-7");
    await card.getByRole("button", { name: /^Ship it/ }).click();
    await card.getByText("Answered: Ship it").waitFor();
    // The manager restates ny-7 (CI went red) with the same buttons, inside the window.
    put("manager", { type: "assistant", uuid: `edge-reask-${++n}`, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "**Demo release:** CI is red now.\n\n[buttons ny-7] ship=Ship it | hold=Hold for a day" }] } });
    await card.getByText(/The question changed while your answer waited/).waitFor({ timeout: 15_000 });
    assert(!pane("manager").includes("[tap ny-7]"), "the old answer was typed for the restated question");
    assert(!audit().includes('"ny-7"'), "an EscalationAnswered was recorded for ny-7");
    await card.getByRole("button", { name: /^Hold for a day/ }).waitFor();             // he can answer the new one
  });

  const items = o.ledger.needsYou as Record<string, unknown>[];
  const runState = () => page.evaluate(() => (JSON.parse(localStorage.getItem("morndo.catchup.run") ?? "null") as { run: { done: Record<string, string> } } | null)?.run.done ?? {});
  const decideNow = async (id: string) => {
    if (await page.locator(".cu-top .back").count()) await page.locator(".cu-top .back").click();
    await page.locator(`li.ev[data-row="d:${id}"]`).getByRole("button", { name: "Decide now" }).click();
    await toCard(`d:${id}`);
  };

  await check("#6a an answer the hub typed but whose reply was lost is not called unanswered: it counts once the board shows it, typed once", async () => {
    await toCard("d:ny-7");
    let first = true;
    await page.route("**/api/escalations/ny-7/answer", async route => {
      if (!first) return route.continue();
      first = false;
      await route.fetch().catch(() => {});                                   // the hub gets it and types it
      await route.abort("connectionreset");                                  // the phone never hears back
    });
    await card.getByRole("button", { name: /^Hold for a day/ }).click();
    let saidUnanswered = false;
    await until(async () => {
      if (await card.getByText(/Nothing was answered/).count()) saidUnanswered = true;
      if ((await top()) !== "d:ny-7") return true;
      if (await card.getByRole("button", { name: "Try again" }).count()) await card.getByRole("button", { name: "Try again" }).click();
      return false;
    }, 30_000, "ny-7 settled as answered");
    await page.unroute("**/api/escalations/ny-7/answer");
    assert(!saidUnanswered, "said nothing was answered while the hub typed it");
    const typed = pane("manager").split("\n").filter(l => l.includes("[tap ny-7] hold")).length;
    const audited = audit().split("\n").filter(l => l.includes("EscalationAnswered") && l.includes('"ny-7"')).length;
    assert(typed === 1 && audited === 1, `typed ${typed}, audited ${audited}`);
    assert((await runState())["d:ny-7"] === "answered", `the run counts it as ${(await runState())["d:ny-7"]}`);
  });

  await check("#6b a stalled answer gives up within seconds: the run isn't locked, and Try again sends it once", async () => {
    await decideNow("ny-8");
    await page.route("**/api/escalations/ny-8/answer", () => { /* never answered: the hub never gets it */ });
    await card.getByRole("button", { name: "Go with the default" }).click();
    await card.getByText(/Not sure it went/).waitFor({ timeout: 30_000 });
    assert(await page.getByRole("button", { name: "Later", exact: true }).isEnabled(), "the run stays locked");
    await page.unroute("**/api/escalations/ny-8/answer");
    await card.getByRole("button", { name: "Try again" }).click();
    await until(async () => (await top()) !== "d:ny-8", 15_000, "ny-8 answered after Try again");
    assert(pane("manager").split("\n").filter(l => l.includes("About ny-8: Go with the default")).length === 1, "not typed exactly once");
  });

  await check("#6c an answer still in its window when the page closes goes (keepalive) and is typed once; the card never shows it unanswered", async () => {
    items.push({ id: "ny-60", kind: "tap", question: "Turn on the nightly backup?", default: "leave it off", deadline: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), ts: new Date().toISOString() });
    o.writeLedger(o.ledger);
    await page.locator(".cu-top .back").click();
    await page.locator('li.ev[data-row="d:ny-60"]').waitFor({ timeout: 10_000 });
    await decideNow("ny-60");
    await card.getByRole("button", { name: "Go with the default" }).click();
    await card.getByText("Answered: go with the default").waitFor();
    await page.reload();                                                     // leaving: what was pending goes now
    await until(() => pane("manager").includes("About ny-60: Go with the default"), 10_000, "the pending answer sent on leaving");
    await page.goto(`${office.base}/?view=decisions`);                     // catch-up again (a push's way in)
    await page.waitForTimeout(3000);
    // Gone from the run, or still on top saying it was answered; never offering its options again.
    const onTop = (await top()) === "d:ny-60";
    assert(!onTop || ((await card.getByText(/^Answered/).count()) > 0 && (await card.getByRole("button", { name: "Go with the default" }).count()) === 0),
      "ny-60's card is back, as if unanswered");
    const status = await page.evaluate(() => fetch("/api/escalations").then(r => r.json()).then((b: { items: { id: string; status: string }[] }) => b.items.find(i => i.id === "ny-60")?.status));
    assert(status === "answered", `ny-60 is ${status}`);
    assert(pane("manager").split("\n").filter(l => l.includes("About ny-60")).length === 1, "not typed exactly once");
  });

  await check("#7 a decision brought back with Decide now isn't 'kept for later' on Today any more", async () => {
    items.push({ id: "ny-70", kind: "tap", question: "Archive last quarter's logs?", default: "keep them", deadline: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), ts: new Date().toISOString() });
    o.writeLedger(o.ledger);
    if (await page.locator(".cu-top .back").count()) await page.locator(".cu-top .back").click();
    await page.locator('li.ev[data-row="d:ny-70"]').waitFor({ timeout: 10_000 });
    await decideNow("ny-70");
    await later();
    await page.locator(".cu-top .back").click();
    await page.locator('li.ev[data-row="d:ny-70"]').getByText("You kept this for later.").waitFor();
    await decideNow("ny-70");                                               // back on top: not set aside any more
    await page.locator(".cu-top .back").click();
    await page.locator('li.ev[data-row="d:ny-70"]').getByRole("button", { name: "Decide now" }).waitFor();
    assert(await page.locator('li.ev[data-row="d:ny-70"]').getByText("You kept this for later.").count() === 0, "still called kept for later after Decide now");
  });

  // A real finger: touch events through CDP (Input.dispatchTouchEvent), as a phone's browser gets them.
  const touchSwipe = async (x0: number, y: number, dx: number) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
    for (let i = 1; i <= 12; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + (dx * i) / 12, y: y + i * 0.3 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };

  await check("#3 a touch swipe that starts on the card's body (not only its head) sets a decision aside for later", async () => {
    items.push({ id: "ny-71", kind: "tap", question: "Rotate the staging keys?", default: "next week", deadline: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), ts: new Date().toISOString() });
    o.writeLedger(o.ledger);
    if (await page.locator(".cu-top .back").count()) await page.locator(".cu-top .back").click();
    await page.locator('li.ev[data-row="d:ny-71"]').waitFor({ timeout: 10_000 });
    await decideNow("ny-71");
    const h = await card.locator(".card-body h2").boundingBox();             // the question, in the card's body
    if (!h) throw new Error("no question");
    await touchSwipe(h.x + h.width - 20, h.y + h.height / 2, -260);
    await until(async () => (await top()) !== "d:ny-71", 5000, "the card swiped away by touch");
    const done = (await runState())["d:ny-71"];
    assert(done === "later", `the swiped card is ${done}`);
  });

  await check("#12 a reply the hub refuses says why in words, one held behind it says so, and both can be discarded", async () => {
    say("builder", "About to change the deploy script.");
    // A menu on builder's screen (as Claude Code draws a permission prompt), and the command still running under it.
    tmux("send-keys", "-t", panes.builder ?? "", "printf 'Do you want to proceed?\\n> 1. Yes\\n  2. No\\nEsc to cancel\\n'; sleep 600", "Enter");
    await until(() => page.evaluate(() => fetch("/api/escalations").then(r => r.json()).then((b: { items: { id: string; status: string }[] }) => b.items.some(i => i.id.startsWith("menu-") && i.status === "open"))), 15_000, "the hub sees builder's menu");
    const convo = await openChat(page, "builder");
    await convo.locator(".sub.waits").waitFor({ timeout: 10_000 });
    const box = convo.getByRole("textbox", { name: "Message builder" });
    await box.fill(": e2e-menu-reply-12");
    await convo.getByRole("button", { name: "Send" }).click();
    const first = convo.locator("[data-outbox]", { hasText: "e2e-menu-reply-12" });
    await first.getByText(/builder is showing a menu/).waitFor({ timeout: 15_000 });
    assert(!(await first.innerText()).includes("menu_open"), "the raw code shows");
    await box.fill(": e2e-held-reply-12");
    await convo.getByRole("button", { name: "Send" }).click();
    const held = convo.locator("[data-outbox]", { hasText: "e2e-held-reply-12" });
    await held.getByText("Waiting for the message above").waitFor();
    await held.getByRole("button", { name: "Discard" }).click();
    await held.waitFor({ state: "detached" });
    await first.getByRole("button", { name: "Discard" }).click();
    await first.waitFor({ state: "detached" });
    tmux("send-keys", "-t", panes.builder ?? "", "C-c", "");
    await page.getByRole("button", { name: "Back to chats" }).click();
    await tapTab(page, "Today");
  });

  await check("#13 an answer in his own words that doesn't start (offline) keeps the words in the box", async () => {
    await decideNow("ny-70");
    await card.getByRole("button", { name: "Answer in my own words" }).click();
    const words = "Archive them, but keep the last two weeks where the support team can search them.";
    await card.getByRole("textbox").fill(words);
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    try {
      await card.getByRole("button", { name: /^Send to Manager/ }).click();
      await card.getByText(/You're offline/).waitFor();
      assert(await card.getByRole("textbox").count() === 1, "the box closed");
      assert(await card.getByRole("textbox").inputValue() === words, "the words are gone");
    } finally {
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
    }
    await page.locator(".conn.live, .cu-top").first().waitFor();
  });


  // A second phone whose feed socket the test can cut: `cut()` closes it and keeps every new one silent (connected for
  // the page, never to the hub, as a half-open network looks); `restore()` lets the next one through.
  const addDecision = (id: string, question: string) => {
    items.push({ id, kind: "tap", question, default: "wait a day", deadline: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10), ts: new Date().toISOString() });
    o.writeLedger(o.ledger);
  };
  async function gatedPhone(open: boolean) {
    const p = await pairedPage(browser, office, { width: 390, height: 844, phone: true, ready: "nav.tabbar", init: () => localStorage.setItem("morndo.tab", "today"), serviceWorkers: "block" });
    let allow = open;
    const live = new Set<import("playwright").WebSocketRoute>();
    await p.page.routeWebSocket(/\/api\/feed$/, ws => { live.add(ws); if (allow) ws.connectToServer(); });
    await p.page.reload();
    await p.page.locator("nav.tabbar").waitFor();
    const drop = async () => { for (const w of live) await w.close().catch(() => {}); live.clear(); };
    return { ...p, cut: async () => { allow = false; await drop(); }, restore: async () => { allow = true; await drop(); } };
  }
  // Into catch-up from a row of Today, which still shows what was last known while the feed is away.
  const tabCatchUp = (p: import("playwright").Page) => p.locator('li.ev[data-kind="decision"]').first().getByRole("button", { name: "Decide now" }).click();

  await check("#14 Today makes no claim (nothing needs you) before the feed has said what waits", async () => {
    const g = await gatedPhone(false);
    try {
      await g.page.waitForTimeout(3000);
      const hero = await g.page.locator(".hero").innerText();
      assert(!/Nothing needs you/i.test(hero), `the hero claims, with no word from the hub: ${JSON.stringify(hero)}`);
      await g.page.locator(".hero").getByText(/Waiting for the hub/).waitFor();
    } finally { await g.context.close(); }
  });

  await check("#15 after the feed drops, catch-up waits for fresh data instead of opening on what the phone knew before", async () => {
    const g = await gatedPhone(true);
    try {
      await g.page.getByRole("button", { name: /^Decide · \d+/ }).waitFor({ timeout: 10_000 });
      await g.cut();
      addDecision("ny-50", "Rename the staging bucket again?");
      await g.page.waitForTimeout(1500);
      await tabCatchUp(g.page);
      await g.page.waitForTimeout(2000);
      const stale = await g.page.locator("article.card").count();
      assert(stale === 0, `a run opened on stale data: ${stale ? await g.page.locator("article.card").getAttribute("data-card") : ""}`);
      await g.page.getByText("Waiting for the hub").waitFor();
      await g.restore();
      await g.page.locator("article.card").waitFor({ timeout: 20_000 });
      const order = await g.page.evaluate(() => (JSON.parse(localStorage.getItem("morndo.catchup.run") ?? "null") as { run: { order: string[] } } | null)?.run.order ?? []);
      assert(order.includes("d:ny-50"), `the fresh decision isn't in the run: ${JSON.stringify(order)}`);
    } finally { await g.context.close(); }
  });

  await check("#8 a run kept on the device isn't shown or acted on before the feed has said what waits", async () => {
    const g = await gatedPhone(true);
    try {
      await g.page.getByRole("button", { name: /^Decide · \d+/ }).click();
      await g.page.locator('article.card[data-card^="d:"]').waitFor();
      await g.page.locator(".cu-top .back").click();
      await g.cut();
      await g.page.goto(`${office.base}/?view=decisions`);                 // a push's tap, the hub not reachable yet
      await g.page.waitForTimeout(3000);
      assert(await g.page.getByText("isn't on the hub's list anymore").count() === 0, "a still-open decision is called gone before the hub said anything");
      assert(await g.page.locator("article.card").count() === 0, "the kept run is shown before the hub said anything");
      await g.page.getByText("Waiting for the hub").waitFor();
    } finally { await g.context.close(); }
  });

  await check("#10 a read mark the hub never got (a socket that took it and lost it) is sent again after the reconnect", async () => {
    const p = await pairedPage(browser, office, { width: 390, height: 844, phone: true, ready: "nav.tabbar", init: () => localStorage.setItem("morndo.tab", "today"), serviceWorkers: "block" });
    try {
      let drop = true;
      const live = new Set<import("playwright").WebSocketRoute>();
      await p.page.routeWebSocket(/\/api\/feed$/, ws => {
        live.add(ws);
        const server = ws.connectToServer();
        // Page to hub: everything but read marks while `drop` holds, as a half-open socket would lose them.
        ws.onMessage(m => { if (!(drop && String(m).includes('"t":"read"'))) server.send(m); });
      });
      await p.page.reload();
      await p.page.locator("nav.tabbar").waitFor();
      const name = "builder";
      say(name, "Deploy script changed; one more test to write.");             // something unread in builder's chat
      const markOf = () => { const db = new Database(join(office.home, "morndo.db"), { readonly: true }); try { return (db.prepare("SELECT at FROM read_marks WHERE conversation = ?").get(name) as { at: number } | undefined)?.at ?? null; } finally { db.close(); } };
      const before = markOf();
      const convo = await openChat(p.page, name);                           // read to its end: the mark "goes"
      await convo.getByText("Deploy script changed").waitFor({ timeout: 10_000 });
      await p.page.waitForTimeout(3000);
      assert(markOf() === before, "the hub got the mark through the dropping socket");
      drop = false;
      for (const w of live) await w.close().catch(() => {});                 // the connection is found dead; a new one opens
      await until(() => (markOf() ?? 0) > (before ?? 0), 20_000, `the hub has ${name}'s mark after the reconnect`);
    } finally { await p.context.close(); }
  });

  await check("#10b a pending read mark isn't dropped because the hub has an older one (only a mark at or after it confirms it)", async () => {
    const dbPath = join(office.home, "morndo.db");
    const markOf = (c: string) => { const db = new Database(dbPath, { readonly: true }); try { return (db.prepare("SELECT at FROM read_marks WHERE conversation = ?").get(c) as { at: number } | undefined)?.at ?? null; } finally { db.close(); } };
    // The hub has manager read up to a message 20 s ago (another device read it); then the manager says something new.
    const older = Date.now() - 20_000;
    { const db = new Database(dbPath); try { db.prepare("INSERT INTO read_marks (conversation, at) VALUES ('manager', ?) ON CONFLICT(conversation) DO UPDATE SET at = excluded.at").run(older); } finally { db.close(); } }
    const saidAt = Date.now();
    say("manager", "The night shift is done: 3 of 3 tasks.");
    // The suite's own phone (the hub takes at most 6 devices), its feed socket now routed through the test.
    const p = { page };
    {
      let drop = false;
      const live = new Set<import("playwright").WebSocketRoute>();
      await p.page.routeWebSocket(/\/api\/feed$/, ws => {
        live.add(ws);
        const server = ws.connectToServer();
        ws.onMessage(m => { if (!(drop && String(m).includes('"t":"read"'))) server.send(m); });
        // Hub to page: as it comes.
        server.onMessage(m => ws.send(m));
      });
      const reconnect = async () => { for (const w of live) await w.close().catch(() => {}); live.clear(); await p.page.waitForTimeout(3000); };
      await p.page.reload();
      await p.page.locator("nav.tabbar").waitFor();
      drop = true;                                                          // the mark's frames are lost from here
      const convo = await openChat(p.page, "manager");                       // read to its end
      await convo.getByText("The night shift is done").waitFor({ timeout: 10_000 });
      await p.page.waitForTimeout(3000);
      await reconnect();                                                    // the next hello's reply carries the older mark
      assert(markOf("manager") === older, "the hub moved on its own");
      drop = false;
      await reconnect();                                                    // a connection that works: the pending mark goes
      await until(() => (markOf("manager") ?? 0) >= saidAt - 1000, 15_000, "the hub has the newer mark");
    }
  });

  code = finish();
  // Provoked on purpose: 409 and 403 refusals, and the reset check 6a gives the answer's request.
  const unexpected = errors.filter(e => !/status of (409|403)|ERR_CONNECTION_RESET/.test(e));
  if (unexpected.length) { console.log(`page errors: ${unexpected.join(" | ")}`); code = 1; }
  void say;
} finally {
  await browser.close();
  office.stop();
}
process.exit(code);
