// Screenshots of the Engines page (ADR-0013) for the QA record, before and after a change, at phone (390 x 844) and
// desktop (1440 x 900) width, light and dark, on a synthetic office with its own hub and the engine layer's real CLI on
// a scratch settings file ($ENGINES_BIN as in engines.e2e.ts). Also writes `engines get review` before and after.
// Not a check (engines.e2e.ts is). The images are for the owner only: keep them out of the repo.
// Run: npm run build && node e2e/engines-shots.ts <output folder>
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { pairedPage, startOffice } from "./harness.ts";

const OUT = process.argv[2];
if (!OUT) { console.error("usage: node e2e/engines-shots.ts <output folder>"); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const ENGINES = process.env.ENGINES_BIN ?? join(homedir(), "code/engine-layer/bin/engines");
// Fresh settings every run, outside the output folder: a run never starts from the last run's changes.
const SCRATCH = mkdtempSync(join(tmpdir(), "morndo-engines-shots-"));
const STUBS = join(SCRATCH, "stub-bin");
mkdirSync(STUBS, { recursive: true });
for (const bin of ["claude-as", "agent", "codex", "studio"]) { writeFileSync(join(STUBS, bin), "#!/bin/sh\nexit 0\n"); chmodSync(join(STUBS, bin), 0o755); }
const enginesEnv = {
  ENGINES_CONFIG: join(SCRATCH, "engines.json"), ENGINES_STATE: join(SCRATCH, "state"), PYTHONDONTWRITEBYTECODE: "1", PATH: `${STUBS}:${process.env.PATH ?? ""}`,
};
const engines = (...args: string[]) => execFileSync(ENGINES, args, { env: { ...process.env, ...enginesEnv }, encoding: "utf8" });
engines("login", "codex", "ok");
engines("mark", "codex", "quota (QA)", "--for", "120");

const office = await startOffice("engines-shots", { MORNDO_ENGINES: ENGINES, ...enginesEnv });
const browser = await chromium.launch();
const shots: string[] = [];
async function shot(page: Page, name: string, dark = true) {
  await page.mouse.move(0, 0);
  for (const scheme of dark ? (["light", "dark"] as const) : (["light"] as const)) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    const file = join(OUT, `${name}${dark ? `-${scheme}` : ""}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
  }
  await page.emulateMedia({ colorScheme: "light" });
}
const review = (page: Page) => page.getByRole("region", { name: "Review", exact: true });
// The review card's top under the sticky header.
const toReview = (page: Page) => review(page).evaluate(el => { el.scrollIntoView({ block: "start" }); scrollBy(0, -120); });

try {
  writeFileSync(join(OUT, "engines-get-review-before.txt"), engines("get", "review"));

  // Phone: ⋯ → Devices, then Engines (main has no settings sheet; #11's port moves this link into it).
  const phone = await pairedPage(browser, office, { width: 390, height: 844, phone: true, ready: "nav.tabbar" });
  const p = phone.page;
  await p.getByRole("link", { name: "Devices and sign out" }).click();
  await p.getByRole("link", { name: /Engines/ }).waitFor();
  await shot(p, "phone-0-devices");
  await p.getByRole("link", { name: /Engines/ }).click();
  await review(p).waitFor({ timeout: 10_000 });
  await shot(p, "phone-1-before-top");
  await toReview(p);
  await shot(p, "phone-2-before-review");
  await review(p).getByRole("combobox", { name: "Model, first choice" }).selectOption("sonnet-5.5");
  await review(p).getByRole("combobox", { name: "Effort, first choice" }).selectOption("xhigh");
  await review(p).getByRole("switch", { name: /Reviewer from another provider/ }).click();
  await toReview(p);
  await shot(p, "phone-3-changed-unsaved");
  await p.getByRole("button", { name: "Save changes" }).click();
  await p.getByRole("status").getByText(/^Saved/).waitFor({ timeout: 10_000 });
  await toReview(p);
  await shot(p, "phone-4-after-saved");
  writeFileSync(join(OUT, "engines-get-review-after-phone.txt"), engines("get", "review"));
  // A refused edit: the same engine twice in one list.
  await review(p).getByRole("combobox", { name: "Provider, fallback 1" }).selectOption("claude");
  await review(p).getByRole("combobox", { name: "Model, fallback 1" }).selectOption("sonnet-5.5");
  await review(p).getByRole("combobox", { name: "Effort, fallback 1" }).selectOption("xhigh");
  await review(p).getByRole("alert").waitFor();
  await review(p).getByRole("alert").evaluate(el => { el.scrollIntoView({ block: "center" }); });
  await shot(p, "phone-5-refused-duplicate", false);
  await p.getByRole("button", { name: "Discard" }).click();
  await phone.context.close();

  // Desktop: from the sidebar to Engines; before, a change on Implement: backend, after.
  const desk = await pairedPage(browser, office, { width: 1440, height: 900 });
  const d = desk.page;
  await d.getByRole("link", { name: "Engines" }).click();
  await review(d).waitFor({ timeout: 10_000 });
  await shot(d, "desktop-1-before-top");
  const backend = d.getByRole("region", { name: "Implement: backend", exact: true });
  await backend.evaluate(el => { el.scrollIntoView({ block: "start" }); scrollBy(0, -110); });
  await shot(d, "desktop-2-before-backend");
  await backend.getByRole("button", { name: "Move fallback 1 up" }).click();
  await backend.getByRole("button", { name: "+ Add a fallback" }).click();
  await shot(d, "desktop-3-changed-unsaved");
  await d.getByRole("button", { name: "Save changes" }).click();
  await d.getByRole("status").getByText(/^Saved/).waitFor({ timeout: 10_000 });
  await shot(d, "desktop-4-after-saved");
  writeFileSync(join(OUT, "engines-get-after-desktop.txt"), engines("get"));
  console.log(`errors: phone ${phone.errors.length}, desktop ${desk.errors.length}${[...phone.errors, ...desk.errors].map(e => `\n  ${e}`).join("")}`);
  await desk.context.close();
  console.log(shots.join("\n"));
} finally {
  await browser.close();
  office.stop();
  rmSync(SCRATCH, { recursive: true, force: true });
}
