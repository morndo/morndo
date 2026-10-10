// Screenshots of every phone screen (ADR-0009) at 390 x 844, light and dark, on a synthetic office with its own hub, in
// Playwright's own Chromium. For QA records and the design's comparison with its mockups; not a check (catchup.e2e.ts
// is). Run: npm run build && node e2e/phone-shots.ts <output folder>
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { pairedPage, startOffice } from "./harness.ts";

const OUT = process.argv[2];
if (!OUT) { console.error("usage: node e2e/phone-shots.ts <output folder>"); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const office = await startOffice("shots");
const browser = await chromium.launch();
const { ledger, writeLedger, claudeDir } = office.office;
const say = (name: string, text: string) => appendFileSync(join(claudeDir, "projects", "-qa", `s-${name}.jsonl`), JSON.stringify({
  type: "assistant", uuid: `shot-${name}-${Date.now()}`, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text }] },
}) + "\n");
const shots: string[] = [];
async function shot(page: Page, name: string) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    const file = join(OUT, `${name}-${scheme}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

try {
  // A time item of his own with a time today, so the dashboard has a "needs you" slot like the design's.
  const at = new Date(Date.now() + 3 * 3_600_000);
  (ledger.needsYou as Record<string, unknown>[]).push({ id: "ny-30", kind: "time", item: "Call the accountant (about 20 minutes)", default: "it moves to Monday", deadline: at.toISOString(), added: new Date().toISOString() });
  writeLedger(ledger);
  const { page, errors } = await pairedPage(browser, office, { width: 390, height: 844, phone: true, ready: "nav.tabbar", init: () => localStorage.setItem("morndo.tab", "today") });
  const card = page.locator("article.card");
  const top = () => card.getAttribute("data-card");
  const toCard = async (key: string) => { for (let i = 0; i < 60 && (await top()) !== key; i++) await page.waitForTimeout(150); };
  await page.getByRole("button", { name: /^Decide · \d+/ }).waitFor();
  await page.waitForTimeout(1500);
  await shot(page, "01-today-waiting");
  await page.getByRole("button", { name: /^Decide · \d+/ }).click();
  await toCard("d:ny-7");
  await shot(page, "02-catchup-decision");
  await card.getByRole("button", { name: "More" }).click();
  await shot(page, "03-catchup-decision-why");
  await card.getByRole("button", { name: "Less" }).click();
  await card.getByRole("button", { name: /^Ship it/ }).click();
  await card.getByText("Answered: Ship it").waitFor();
  await shot(page, "04-catchup-answered-undo");
  await toCard("d:ny-8");
  await card.getByRole("button", { name: "Answer in my own words" }).click();
  await card.getByRole("textbox").fill("Thursday morning");
  await shot(page, "05-catchup-decision-words");
  await card.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Later", exact: true }).click();
  await toCard("d:q-q1");
  await shot(page, "06-catchup-decision-on-screen");
  await page.getByRole("button", { name: "Open the chat" }).click();
  await page.locator(".chat li.focus").waitFor();
  await shot(page, "07-chat-at-the-question");
  await page.getByRole("button", { name: "Back to the card" }).click();
  await page.getByRole("button", { name: "Later", exact: true }).click();
  await toCard("u:reviewer");
  await shot(page, "08-catchup-update-needs-you");
  await page.getByRole("button", { name: "Keep unread" }).click();
  await toCard("u:builder");
  await shot(page, "09-catchup-update-says-done");
  await card.getByRole("textbox", { name: "Message builder" }).fill(": check the forgot-password link too");
  await card.getByRole("button", { name: "Send to builder" }).click();
  await card.locator("[data-outgoing]").first().waitFor();
  await page.waitForTimeout(1500);
  await shot(page, "10-catchup-update-reply");
  await page.getByRole("button", { name: "Mark as read" }).click();
  await toCard("u:manager");
  await shot(page, "11-catchup-update-undo");
  await page.getByRole("button", { name: "Mark as read" }).click();
  await page.getByText("You're caught up.").waitFor();
  await page.waitForTimeout(800);
  await shot(page, "12-caught-up");
  await page.getByRole("button", { name: "See your day" }).click();
  say("builder", "Working on the forgot-password link now.");
  await page.waitForTimeout(1500);
  await shot(page, "13-today-horizon");
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await shot(page, "14-today-horizon-scrolled");
  await page.evaluate(() => scrollTo(0, 0));
  await page.getByRole("navigation", { name: "Morndo" }).getByRole("button", { name: "Agents" }).click();
  await page.locator("li", { hasText: "builder" }).first().waitFor();
  await shot(page, "15-agents");
  await page.getByRole("button", { name: /^builder/ }).first().click();
  await page.getByText("Read-only view").waitFor();
  await page.waitForTimeout(800);
  await shot(page, "16-agents-screen");
  console.log(`${shots.length} screenshots in ${OUT}`);
  if (errors.length) console.log(`page errors: ${errors.join(" | ")}`);
} finally {
  await browser.close();
  office.stop();
}
