// The fleet's two-node e2e (spec §9 "Two nodes (CI)", §12.1; ADR-0012). It runs:
// - one real fleet service;
// - two real agents (n1, n2) on two isolated tmux servers;
// - the real hub in fleet mode (MORNDO_FLEET_SOCKET), serving the built web app, in headless Chromium paired through a
//   virtual passkey.
// The hub lists both nodes' lanes and steers each. A third node (n3) joined and was revoked before it ever ran. Its lane
// never appears: not in the app, the hub's feed or the fleet's lane registry.
// Child processes with temporary HOMEs and random ports (test/fleet-harness.ts). The lanes are
// test/fixtures/fake-claude-pane.ts, which records every submit.
// Run: npm run build (once), then: node e2e/fleet-two-node.e2e.ts
// Screenshots go to $E2E_OUT (default: a temp dir). Exit code 0 only if every check passed. About 30 s.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { assert, checks, outDir, pairedPage } from "./harness.ts";
import { fakeLane, joinAgent, sleep, startFleet, startHub, stopAll, tmuxServer, until } from "../test/fleet-harness.ts";

const OUT = outDir("fleet-two-node");
assert(existsSync(join(import.meta.dirname, "../apps/web/build/200.html")), "build the web app first: npm run build");
const { check, watch, finish } = checks(OUT);
const POLL = 400;
let code = 1;
const browser = await chromium.launch();
try {
  const fleet = await startFleet();
  const [t1, t2, t3] = [tmuxServer(), tmuxServer(), tmuxServer()];
  const n1 = await joinAgent(fleet, "n1", { tmux: t1 });
  const n2 = await joinAgent(fleet, "n2", { tmux: t2 });
  const n3 = await joinAgent(fleet, "n3", { tmux: t3 });
  const alpha = await fakeLane(t1, { window: "alpha", prose: "alpha on n1", claudeHome: n1.home });
  const beta = await fakeLane(t2, { window: "beta", prose: "beta on n2", claudeHome: n2.home });
  await fakeLane(t3, { window: "gamma", prose: "gamma on n3", claudeHome: n3.home });
  fleet.revoke("n3");                                                  // joined, then revoked before it ever ran
  const hub = await startHub(fleet, { web: "build", pollMs: POLL });
  const feed = await hub.feed();                                        // watching before any agent runs
  await Promise.all([n1.run(), n2.run(), n3.run()]);
  await Promise.all([n1.waitOnline(), n2.waitOnline()]);
  const { page } = await pairedPage(browser, hub);
  watch(page);
  const side = page.locator("aside.side");

  await check("the hub lists both nodes' lanes, each worker on its own node", async () => {
    await until("alpha and beta in the hub's feed", () => feed.names.has("alpha") && feed.names.has("beta"), 15_000);
    const workers = feed.workers();
    assert(workers.some(w => w.name === "alpha" && w.id.startsWith("n1.")), `alpha isn't n1's: ${JSON.stringify(workers)}`);
    assert(workers.some(w => w.name === "beta" && w.id.startsWith("n2.")), `beta isn't n2's: ${JSON.stringify(workers)}`);
    await side.getByRole("button", { name: /alpha/ }).first().waitFor({ timeout: 10_000 });
    await side.getByRole("button", { name: /beta/ }).first().waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(OUT, "1-both-nodes.png") });
  });

  await check("a revoked node never appears: not in the app, the hub's feed or the fleet's lanes", async () => {
    await sleep(5 * POLL + 2000);                                       // several polls after n3's refused attempts
    assert(![...feed.seen].some(id => id.startsWith("n3.")) && !feed.names.has("gamma"), `the hub listed n3: ${JSON.stringify([...feed.seen])}`);
    const lanes = await fleet.client.lanes();
    assert(!lanes.some(l => l.node === "n3" || l.name === "gamma"), `the fleet registered n3's lane: ${JSON.stringify(lanes)}`);
    assert((await fleet.client.nodes()).find(n => n.name === "n3")?.status !== "online", "n3 is online");
    assert(await side.getByRole("button", { name: /gamma/ }).count() === 0, "the app lists gamma");
  });

  for (const [lane, box, other, node] of [["alpha", alpha, beta, "n1"], ["beta", beta, alpha, "n2"]] as const) {
    await check(`steering ${lane} types into ${node}'s pane once, and nowhere else`, async () => {
      const text = `hello ${lane} on ${node}, from the hub`;
      await side.getByRole("button", { name: new RegExp(lane) }).first().click();
      await page.locator("h1", { hasText: lane }).waitFor();
      await page.locator("#composer").fill(text);
      await page.keyboard.press("Enter");
      await until(`the text in ${lane}`, () => box.submitted().includes(text), 10_000);
      await sleep(800);
      const times = box.submitted().filter(t => t === text).length;
      assert(times === 1, `typed ${times} times`);
      assert(!other.submitted().includes(text), "it reached the other node's pane");
      await page.screenshot({ path: join(OUT, `2-steer-${lane}.png`) });
    });
  }

  await check("the Terminal tab shows n2's pane, drawn on n2 and carried by the fleet", async () => {
    await side.getByRole("button", { name: /beta/ }).first().click();
    await page.locator("h1", { hasText: "beta" }).waitFor();
    await page.locator(".chan .tabs").getByRole("tab", { name: "Terminal" }).click();
    await page.getByRole("region", { name: "Terminal of #beta" }).locator(".xterm-rows", { hasText: "beta on n2" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(OUT, "3-terminal-n2.png") });
  });
  code = finish();
} finally {
  await browser.close();
  await stopAll();
}
process.exit(code);
