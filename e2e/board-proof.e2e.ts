// End-to-end check of proof in the desktop task panel (ADR-0035 step 5): a stand-in forge, the real morndo-board CLI,
// and the principal in Chromium. Run: npm run build && node e2e/board-proof.e2e.ts
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { chromium } from "playwright";
import { startFakeForge } from "../apps/hub/test/fake-forge.ts";
import { HUB_MAIN, assert, checks, outDir, pairedPage, startOffice } from "./harness.ts";

const OUT = outDir("board-proof");
const CLI = join(import.meta.dirname, "../apps/board-cli/src/main.ts");
const PR = "morndo/morndo#42@3e9d1a7";
const CI = "morndo/morndo@3e9d1a7:ci,lint";
const FULL = "3e9d1a7c5b2f4a8e9d0c1b2a3f4e5d6c7b8a9f01";
const RUN = "https://github.com/morndo/morndo/actions/runs/9";
const { check, watch, finish } = checks(OUT);
let code = 1;
let office: Awaited<ReturnType<typeof startOffice>> | null = null;
let fakeForge: Awaited<ReturnType<typeof startFakeForge>> | null = null;
const browser = await chromium.launch();

const mint = (env: NodeJS.ProcessEnv, name: string, role: "manager" | "worker") =>
  execFileSync(process.execPath, ["--no-warnings", HUB_MAIN, "agent-token", "new", name, "--role", role], { env, encoding: "utf8" }).split("\n")[0]?.trim() ?? "";
const cliAs = (env: NodeJS.ProcessEnv) => (...args: string[]) => {
  try { return { code: 0, out: execFileSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd() }; }
  catch (e) { const x = e as { status: number; stderr: string }; return { code: x.status, out: String(x.stderr).trim() }; }
};
const column = (page: import("playwright").Page, status: string) => page.locator(`[data-column="${status}"]`);
const cardOf = (page: import("playwright").Page, key: string) => page.locator(`[data-task="${key}"]`);

const waitFor = async (fn: () => boolean, ms: number, step = 500) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, step));
  }
  throw new Error("timed out waiting");
};

try {
  fakeForge = await startFakeForge();
  fakeForge.pr("morndo/morndo", 42, { head: FULL });
  fakeForge.runs("morndo/morndo", FULL, [
    { id: 1, name: "ci", status: "completed", conclusion: "success" },
    { id: 2, name: "lint", status: "completed", conclusion: "failure", url: RUN },
  ]);
  office = await startOffice("board-proof", {
    MORNDO_FORGE_URL: fakeForge.base,
    MORNDO_PROOF_REPOS: "morndo/morndo",
    MORNDO_PROOF_GATE: "on",
  });
  const managerSecret = mint(office.env, "manager", "manager");
  const workerSecret = mint(office.env, "lanes", "worker");
  assert(managerSecret.startsWith("mat_") && workerSecret.startsWith("mat_"), "the console didn't print the tokens");
  const base = { ...process.env, MORNDO_HUB: office.base };
  const manager = cliAs({ ...base, MORNDO_AGENT_TOKEN: managerSecret });
  const builder = cliAs({ ...base, MORNDO_AGENT_TOKEN: workerSecret, MORNDO_LANE: "builder" });

  const paired = await pairedPage(browser, office);
  const { page } = paired;
  watch(page);

  let proofLine = "";

  await check("a task in review shows the brief and one line per reference, with a red one marked, the Done refused for the manager and accepted anyway by the principal", async () => {
    assert(manager("new", "Ship the totals row", "--assign", "builder").code === 0, "new failed");
    assert(builder("start", "T-1").code === 0, "start failed");
    assert(builder("brief", "T-1",
      "--pr", PR,
      "--ci", CI,
      "--test", "npm test: 48 passed",
      "--ui", "the totals row renders",
      "--summary", "Totals row rounds to cents",
      "--left-out", "nothing",
      "--limit", "locale formats not covered",
    ).code === 0, "brief failed");
    assert(builder("review", "T-1").code === 0, "review failed");

    await waitFor(() => {
      const shown = manager("show", "T-1");
      if (shown.code !== 0 || !shown.out.includes("✗")) return false;
      const m = shown.out.match(/Proof: (proof: .+)/);
      if (!m) return false;
      proofLine = m[1]!.trim();
      return true;
    }, 20_000);

    await page.locator(".rail").getByRole("button", { name: "Board" }).click();
    await column(page, "review").locator('[data-task="T-1"]').waitFor({ timeout: 10_000 });
    await cardOf(page, "T-1").click();
    const panel = page.locator('[data-task-panel="T-1"]');
    await panel.locator("[data-proof-line]").waitFor({ timeout: 10_000 });
    assert((await panel.locator("[data-proof-line]").innerText()) === proofLine, "the panel line differs from the CLI");
    assert((await panel.locator("[data-proof-standin]").innerText()) === "Read from a stand-in forge, not GitHub", "a stand-in forge should be marked in the panel");
    const refs = panel.locator("[data-proof-ref]");
    assert(await refs.count() === 2, "expected two reference rows");
    assert(await panel.locator('[data-proof-ref][data-state="red"]').count() === 1, "expected one red reference");
    const attested = panel.locator("[data-proof-attested] li").first();
    await attested.waitFor();
    assert((await attested.innerText()).includes("Attested (tests): npm test: 48 passed"), "attested tests missing");
    assert((await attested.innerText()).includes("the lane's word, not checked"), "attested label missing");
    const accept = panel.getByRole("button", { name: "Accept anyway" });
    await accept.waitFor();
    assert((await accept.getAttribute("title"))?.includes("proof is not green"), `unexpected accept title: ${await accept.getAttribute("title")}`);

    const refused = manager("done", "T-1", "--why", "read the diff");
    assert(refused.code === 1 && refused.out.includes("done is held"), `manager done: ${refused.out}`);
    assert(manager("show", "T-1").out.includes("In review"), "T-1 should stay in review");

    await accept.click();
    await column(page, "done").locator('[data-task="T-1"]').waitFor({ timeout: 10_000 });
    await panel.getByText("Proof when accepted:").waitFor({ timeout: 5000 });
    assert((await panel.innerText()).includes(`Proof when accepted: ${proofLine}`), "the record should name what was accepted");
    // The record of what was accepted stays on the card: a Done task keeps the brief it was accepted on.
    assert((await panel.locator("[data-proof-line]").innerText()) === proofLine, "a done task should keep its proof line");
    assert(await panel.locator("[data-proof-ref]").count() === 2, "a done task should keep its reference rows");
    await page.screenshot({ path: join(OUT, "board-proof-done.png") });
  });

  code = finish();
} catch (e) {
  console.log(`FAIL  setup: ${(e as Error).message}`);
} finally {
  await browser.close();
  office?.stop();
  await fakeForge?.close();
  process.exit(code);
}
