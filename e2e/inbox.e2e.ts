// End-to-end checks of ADR-0010 (answers and messages for the manager go through its inbox) on a synthetic office
// with its own hub, in Playwright's own Chromium: the app shows "Queued, it will be delivered", then "Delivered", and
// never the old "unsent text in its input box" refusal. The inbox's deliverer (tested outside this tree on its own
// tmux replay) is played here by writing its state files, the on-disk contract the hub reads.
// Run: npm run build && node e2e/inbox.e2e.ts
import { mkdirSync, readFileSync, readdirSync, appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { assert, checks, outDir, pairedPage, startOffice } from "./harness.ts";

const OUT = outDir("inbox");
const INBOX = join(OUT, "manager-inbox");
rmSync(INBOX, { recursive: true, force: true });   // a reused E2E_OUT must not see the last run's messages (review #15)
const office = await startOffice("inbox", { MORNDO_MANAGER_INBOX: INBOX, MORNDO_POLL_MS: "500" });
// The deliverer's heartbeat (it writes one every 10 s): without one the hub types directly.
mkdirSync(INBOX, { recursive: true });
const beat = () => writeFileSync(join(INBOX, "deliverer.json"), JSON.stringify({ pid: 1, at: Date.now() }));
beat();
const beating = setInterval(beat, 10_000);
const { tmux, panes, claudeDir, line } = office.office;
const { check, watch, finish } = checks(OUT);
const browser = await chromium.launch();
let code = 1;

const messages = () => { try { return readdirSync(join(INBOX, "msg")).map(f => JSON.parse(readFileSync(join(INBOX, "msg", f), "utf8"))); } catch { return []; } };
const deliverer = (key: string, state: Record<string, unknown>) => {
  mkdirSync(join(INBOX, "state"), { recursive: true });
  writeFileSync(join(INBOX, "state", `${key}.json`), JSON.stringify({ v: 1, key, attempts: 1, updatedAt: Date.now(), ...state }));
};
const managerScreen = () => tmux("capture-pane", "-p", "-J", "-t", panes.manager ?? "", "-S", "-50");
const until = async (cond: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise(r => setTimeout(r, 150)); }
  if (!(await cond())) throw new Error(`timed out: ${what}`);
};

try {
  const { page } = await pairedPage(browser, office);
  watch(page);
  await page.locator("aside.side").getByRole("button", { name: /Manager/ }).first().click();
  await page.locator(".rail").getByRole("button", { name: /Decisions/ }).click();
  const panel = page.getByRole("complementary", { name: "Decisions" });
  await panel.waitFor();

  await check("someone's half-typed text sits in the manager's input box (today's incident): the answer is queued, not refused", async () => {
    tmux("send-keys", "-t", panes.manager ?? "", "-l", "half a thought of the owner's");
    const card = page.locator('.pane [data-decision="ny-7"]');
    await card.getByRole("button", { name: /^Ship it/ }).click();
    await card.getByRole("button", { name: "Send answer" }).click();
    await card.getByText("Queued, it will be delivered").waitFor({ timeout: 8000 });
    assert(!(await page.getByText("unsent text in its input box").count()), "the old draft_present refusal is shown");
    const m = messages();
    assert(m.length === 1 && m[0].text === "[tap ny-7] ship (Ship it)" && m[0].kind === "tap" && m[0].sender === "morndo-hub", `inbox holds ${JSON.stringify(m)}`);
    assert(!managerScreen().includes("[tap ny-7]"), "the hub typed into the manager's pane");
    await page.screenshot({ path: join(OUT, "1-queued.png") });
  });

  await check("while it waits, the card says why, in words (the inbox: someone else's text in the box)", async () => {
    deliverer(messages()[0].key, { status: "held", reason: "foreign_text" });
    const card = page.locator('.pane [data-decision="ny-7"]');
    await card.getByText(/input box has text that isn't from Morndo/).waitFor({ timeout: 8000 });
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(OUT, "2-queued-why.png") });
  });

  await check("on the phone, Today says the answer is queued and will be delivered", async () => {
    const phone = await pairedPage(browser, office, { width: 390, height: 844, phone: true, ready: "nav.tabbar", init: () => localStorage.setItem("morndo.tab", "today") });
    try {
      await phone.page.getByText(/Queued, it will be delivered/).first().waitFor({ timeout: 10_000 });
      await phone.page.screenshot({ path: join(OUT, "2b-phone-today-queued.png") });
    } finally { await phone.context.close(); }
  });

  await check("a second answer while it waits is refused (E8): still one message in the inbox", async () => {
    const r = await page.evaluate(() => fetch("/api/escalations/ny-7/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "hold", requestId: crypto.randomUUID() }) }).then(async x => ({ status: x.status, body: await x.json() })));
    assert(r.status === 409 && r.body.error === "already_answered", `second answer: ${JSON.stringify(r)}`);
    assert(messages().length === 1, "a second message was queued");
  });

  await check("the inbox reports it in the manager's conversation: the card says Delivered, and the record is made then", async () => {
    tmux("send-keys", "-t", panes.manager ?? "", "C-u");                // the owner cleared the box; the deliverer typed it
    deliverer(messages()[0].key, { status: "delivered", deliveredAt: Date.now() });
    const card = page.locator('.pane [data-decision="ny-7"]');
    await card.getByText(/^Delivered/).waitFor({ timeout: 8000 });
    const item = await page.evaluate(() => fetch("/api/escalations").then(r => r.json()).then((b: { items: { id: string; decision: unknown; inbox: unknown }[] }) => b.items.find(i => i.id === "ny-7")));
    assert((item?.decision as { delivery?: { state: string } })?.delivery?.state === "delivered" && item?.inbox === null, `board: ${JSON.stringify(item)}`);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(OUT, "3-delivered.png") });
  });

  await check("a message to the manager from the composer: Queued, it will be delivered, until its echo ends it", async () => {
    const box = page.getByRole("textbox", { name: /Message/ }).first();
    await box.fill("Make sure the queue holds");
    await box.press("Enter");
    await page.getByText("Queued, it will be delivered").first().waitFor({ timeout: 8000 });
    const m = messages().find(x => x.kind === "owner");
    assert(m?.text === "Make sure the queue holds", `inbox: ${JSON.stringify(messages())}`);
    assert(!managerScreen().includes("Make sure the queue holds"), "the hub typed the message into the manager's pane");
    await page.screenshot({ path: join(OUT, "4-message-queued.png") });
    // The deliverer types it with its visible id; the transcript shows the line; the conversation shows it without the id.
    appendFileSync(join(claudeDir, "projects", "-qa", "s-manager.jsonl"), line({ type: "user", uuid: "inbox-echo", timestamp: new Date().toISOString(), origin: { kind: "human" }, message: { role: "user", content: `Make sure the queue holds ⟨m:${String(m.key).slice(0, 6)}⟩` } }) + "\n");
    deliverer(m.key, { status: "delivered", deliveredAt: Date.now() });
    await until(async () => (await page.getByText("Queued, it will be delivered").count()) === 0, 10_000, "the queued entry ends with its echo");
    const shown = await page.locator(".pane").innerText();
    assert(shown.includes("Make sure the queue holds") && !shown.includes("⟨m:"), "the echo is missing, or shows the inbox's id");
    await page.screenshot({ path: join(OUT, "5-message-delivered.png") });
  });

  await check("the kill switch (`manager-inbox disable`): the hub types directly again, as before", async () => {
    writeFileSync(join(INBOX, "disabled"), "");
    const card = page.locator('.pane [data-decision="ny-8"]').first();
    const r = await page.evaluate(() => fetch("/api/escalations/ny-8/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Thursday morning works", requestId: crypto.randomUUID() }) }).then(async x => ({ status: x.status, body: await x.json() })));
    assert(r.status === 200, `answer: ${JSON.stringify(r)}`);
    await until(() => managerScreen().includes("About ny-8: Thursday morning works"), 8000, "the words in the manager's pane");
    assert(messages().length === 2, "queued although the inbox is switched off");
    void card;
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
