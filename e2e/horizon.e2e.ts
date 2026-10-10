// End-to-end checks of Horizon, the phone's dashboard (ADR-0009; the design's done criteria 22 to 25) at 390 px on a
// synthetic office with its own hub, in Playwright's own Chromium. What it must show is computed here from the hub's
// own board, not from the app. Run: npm run build && node e2e/horizon.e2e.ts
import { join } from "node:path";
import { chromium } from "playwright";
import { assert, checks, outDir, pairedPage, startOffice } from "./harness.ts";

const OUT = outDir("horizon");
const office = await startOffice("horizon");
const { ledger, writeLedger } = office.office;
const { check, watch, finish } = checks(OUT);
const browser = await chromium.launch();
let code = 1;

const items = ledger.needsYou as Record<string, unknown>[];
const H = 3_600_000;
// His own slot in 3 hours, a decision due in 5, and a time item an hour overdue.
const slot = new Date(Date.now() + 3 * H), due = new Date(Date.now() + 5 * H), late = new Date(Date.now() - H);
items.push(
  { id: "ny-40", kind: "time", item: "Call the accountant (about 20 minutes)", default: "it moves to Monday", deadline: slot.toISOString(), added: new Date().toISOString() },
  { id: "ny-41", kind: "tap", question: "Switch the demo to the new pricing page?", default: "keep the old one", deadline: due.toISOString(), ts: new Date().toISOString() },
  { id: "ny-42", kind: "time", item: "Approve the invoice run", default: "it waits", deadline: late.toISOString(), added: new Date().toISOString() },
);
writeLedger(ledger);

type Item = { id: string; status: string; need: string; deadline: number | null; asker: { workerId: string | null } };
const until = async (cond: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise(r => setTimeout(r, 150)); }
  if (!(await cond())) throw new Error(`timed out: ${what}`);
};

try {
  const { page } = await pairedPage(browser, office, { width: 390, height: 844, phone: true, ready: "nav.tabbar", init: () => localStorage.setItem("morndo.tab", "today") });
  watch(page);
  const board = () => page.evaluate(() => fetch("/api/escalations").then(r => r.json()).then((b: { items: Item[] }) => b.items));
  const rows = () => page.locator("li.ev").evaluateAll(els => els.map(el => ({
    key: el.getAttribute("data-row") ?? "", needs: el.getAttribute("data-needs"), at: el.querySelector("time")?.getAttribute("datetime") ?? null,
    ready: !!el.querySelector(".time.ready"), said: el.querySelector(".sr")?.textContent ?? "", decide: !!el.querySelector("button"),
  })));
  await until(async () => (await board()).some(i => i.id === "ny-42"), 10_000, "the list read");
  await page.waitForTimeout(1500);

  await check("22a. with something waiting, the headline says how many wait now: open decisions, and anything overdue", async () => {
    const b = await board();
    const expected = b.filter(i => i.status === "open" && (i.need === "decision" || (i.deadline !== null && i.deadline <= Date.now()))).length;
    await page.locator(`[data-waiting="${expected}"]`).waitFor({ timeout: 8000 });
    await page.getByText("waiting now").first().waitFor();
    await page.screenshot({ path: join(OUT, "1-waiting-now.png") });
  });

  await check("23. every time shown comes from a record; an item without one sits under when ready", async () => {
    const b = await board();
    const shown = await rows();
    assert(shown.length > 0, "no rows");
    for (const r of shown) {
      const id = r.key.slice(2);
      if (r.key.startsWith("w:")) { assert(r.ready && r.at === null, `${r.key}: a working agent with a time`); continue; }
      const item = b.find(i => i.id === id);
      assert(item, `${r.key}: no such item on the board`);
      if (item.deadline === null) assert(r.ready && r.at === null, `${r.key} has no deadline but shows a time`);
      else assert(r.at === new Date(item.deadline).toISOString(), `${r.key}: shows ${r.at}, the record says ${new Date(item.deadline).toISOString()}`);
    }
    assert(shown.some(r => r.ready) && shown.some(r => r.at !== null), "both kinds of row expected in this office");
  });

  await check("24. every row is marked: needs you (a filled dot) or happens without you (an open one), in words too", async () => {
    const b = await board();
    for (const r of await rows()) {
      assert(r.needs === "you" || r.needs === "without-you", `${r.key}: ${r.needs}`);
      assert(r.said === (r.needs === "you" ? "Needs you." : "Happens without you."), `${r.key}: says "${r.said}"`);
      const item = b.find(i => i.id === r.key.slice(2));
      if (item) assert((r.needs === "you") === (item.status === "open"), `${r.key}: ${r.needs} but ${item.status}`);
    }
    const dots = await page.locator("li.ev .mk").evaluateAll(els => els.map(e => [e.classList.contains("you"), getComputedStyle(e).backgroundColor] as const));
    const filled = new Set(dots.filter(d => d[0]).map(d => d[1])), open = new Set(dots.filter(d => !d[0]).map(d => d[1]));
    assert([...filled].every(c => !open.has(c)), "a needs-you dot looks like an open one");
  });

  await check("25. Decide now on a row opens that decision's card", async () => {
    const row = page.locator('li.ev[data-row="d:ny-41"]');
    await row.getByRole("button", { name: "Decide now" }).click();
    await until(async () => (await page.locator("article.card").getAttribute("data-card")) === "d:ny-41", 8000, "ny-41's card on top");
    await page.locator("article.card").getByText("Switch the demo to the new pricing page?").waitFor();
  });

  await check("22b. with nothing waiting, the headline is the earliest open item that needs him, at its own time", async () => {
    // Every decision kept for later, every update left unread, then the overdue item and the blocking decision done on the list.
    for (let i = 0; i < 12; i++) {
      const later = page.getByRole("button", { name: "Later", exact: true }), keep = page.getByRole("button", { name: "Keep unread", exact: true });
      if (await later.isVisible()) await later.click(); else if (await keep.isVisible()) await keep.click(); else break;
      await page.waitForTimeout(250);
    }
    await page.getByText("You're caught up.").waitFor();
    // A blocking decision kept for later still waits now (product lane, 2026-10-04): ny-7 blocks, so the headline counts
    // it and its row says so, until it is closed on the list.
    await page.getByRole("button", { name: "See your day" }).click();
    const waitingNow = (await board()).filter(i => i.status === "open" && ((i.deadline !== null && i.deadline <= Date.now()) || (i.need === "decision" && (i as Item & { blocking?: boolean }).blocking))).length;
    assert(waitingNow >= 1, "no blocking or overdue item open in this office");
    await page.locator(`[data-waiting="${waitingNow}"]`).waitFor({ timeout: 8000 });
    await page.locator('li.ev[data-row="d:ny-7"]').getByText(/it blocks work until you answer/).waitFor();
    for (const i of items) if (i.id === "ny-42" || i.id === "ny-7") Object.assign(i, { status: "closed", answer: "Done", closedAt: new Date().toISOString() });
    writeLedger(ledger);
    await until(async () => !(await board()).some(i => (i.id === "ny-42" || i.id === "ny-7") && i.status === "open"), 10_000, "ny-42 and ny-7 closed on the board");
    const b = await board();
    const next = b.filter(i => i.status === "open" && i.deadline !== null && i.deadline > Date.now()).sort((x, y) => (x.deadline ?? 0) - (y.deadline ?? 0))[0];
    assert(next, "nothing timed is open");
    await page.getByText("Nothing needs you until").waitFor({ timeout: 8000 });
    const shown = await page.locator(".hero time").getAttribute("datetime");
    assert(shown === new Date(next.deadline ?? 0).toISOString(), `headline ${shown}, the earliest open item ${next.id} at ${new Date(next.deadline ?? 0).toISOString()}`);
    assert(await page.locator(".hero time").getAttribute("data-row") === `d:${next.id}`, "the headline names another item");
    await page.screenshot({ path: join(OUT, "2-nothing-until.png") });
  });

  code = finish();
} finally {
  await browser.close();
  office.stop();
}
process.exit(code);
