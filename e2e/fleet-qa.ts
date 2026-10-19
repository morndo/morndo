// QA helpers for the fleet runbook (docs/design/fleet-core/qa.md), on synthetic lanes only:
//   node e2e/fleet-qa.ts nodes  <fleet socket>            one line per node: name, status, agent version
//   node e2e/fleet-qa.ts lanes  <fleet socket>            one line per lane: name, node, worker id, a conflict
//   node e2e/fleet-qa.ts alerts <fleet socket>            one JSON line per alert
//   node e2e/fleet-qa.ts worker <fleet socket> <lane>     the lane's worker id (exit 1 if it has none)
//   node e2e/fleet-qa.ts agent-config <home> <tmux socket> <relay port>
//        what the test agent would run with: loads <home>/.config/morndo-node with the agent's own loadConfig and exits 1
//        unless relayPort, policy.tmuxSocket and policy.session ("qa") are the QA's (the runbook's gate before an agent starts)
//   node e2e/fleet-qa.ts send <hub port> <cookie> <worker id> <text> [request id]
//        POST /api/workers/<id>/send on 127.0.0.1:<port>, Origin http://localhost:<port>, as the device whose cookie
//        e2e/qa-session.ts printed; prints the status and the body
//   node e2e/fleet-qa.ts shots <pair url> <out dir> <action>...
//        headless Chromium paired through a virtual passkey (e2e/harness.ts pairedPage), then each action in turn:
//        list:<file> | lane:<lane>:<file> | terminal:<lane>:<file> | send:<lane>:<text>:<file>
//        The device revokes itself at the end, so repeated runs stay under the hub's 6 devices (AC2).
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { FleetClient } from "../packages/fleet-client/src/index.ts";

const [cmd = "", ...a] = process.argv.slice(2);
const say = (line: string) => process.stdout.write(`${line}\n`);
function usage(): never {
  process.stderr.write("usage: node e2e/fleet-qa.ts nodes|lanes|alerts <socket> | worker <socket> <lane> | agent-config <home> <tmux socket> <relay port> | send <port> <cookie> <worker id> <text> [request id] | shots <pair url> <dir> <action>...\n");
  process.exit(2);
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

switch (cmd) {
  case "nodes":
    for (const n of await new FleetClient(a[0] ?? usage()).nodes()) say(`${n.name}  ${n.status}  ${n.agent ?? "-"}`);
    break;
  case "lanes":
    for (const l of await new FleetClient(a[0] ?? usage()).lanes()) say(`${l.name}  ${l.node}  ${l.workerId ?? "-"}${l.conflict ? "  CONFLICT" : ""}`);
    break;
  case "alerts":
    for (const x of await new FleetClient(a[0] ?? usage()).alerts()) say(JSON.stringify(x));
    break;
  case "worker": {
    const lane = (await new FleetClient(a[0] ?? usage()).lanes()).find(l => l.name === a[1]);
    if (!lane?.workerId) { process.stderr.write(`no worker for lane ${a[1] ?? ""}\n`); process.exit(1); }
    say(lane.workerId);
    break;
  }
  case "agent-config": {
    const [home = "", socket = "", port = ""] = a;
    if (!home || !socket || !/^\d+$/.test(port)) usage();
    const { loadConfig } = await import("../apps/node-agent/src/config.ts");
    let c;
    try { c = loadConfig(home); }
    catch (e) { process.stderr.write(`REFUSED: ${(e as Error).message}\n`); process.exit(1); }
    const bad = [];
    if (c.relayPort !== Number(port)) bad.push(`relayPort is ${c.relayPort}, not ${port}`);
    if (c.policy.tmuxSocket !== socket) bad.push(`policy.tmuxSocket is ${JSON.stringify(c.policy.tmuxSocket)}, not "${socket}"`);
    if (c.policy.session !== "qa") bad.push(`policy.session is "${c.policy.session}", not "qa"`);
    if (bad.length) { process.stderr.write(`REFUSED: this config is not the QA's: ${bad.join("; ")}\n`); process.exit(1); }
    say(`agent config ok: node ${c.node}, relayPort ${c.relayPort}, tmuxSocket ${c.policy.tmuxSocket}, session ${c.policy.session}`);
    break;
  }
  case "send": {
    const [port = "", cookie = "", id = "", text = "", requestId = randomUUID()] = a;
    if (!port || !cookie || !id || !text) usage();
    const r = await fetch(`http://127.0.0.1:${port}/api/workers/${encodeURIComponent(id)}/send`, {
      method: "POST",
      headers: { origin: `http://localhost:${port}`, "content-type": "application/json", cookie: `__Host-morndo=${cookie}` },
      body: JSON.stringify({ text, requestId, seen: "none" }),
    });
    say(`${r.status} ${await r.text()}`);
    break;
  }
  case "shots": {
    const [pairUrl = "", dir = "", ...actions] = a;
    if (!pairUrl || !dir || !actions.length) usage();
    mkdirSync(dir, { recursive: true });
    const { chromium } = await import("playwright");
    const { pairedPage } = await import("./harness.ts");
    const browser = await chromium.launch();
    try {
      const { page } = await pairedPage(browser, { pairUrl: () => pairUrl });
      const side = page.locator("aside.side");
      for (const action of actions) {
        const [kind = "", ...rest] = action.split(":");
        if (!["list", "lane", "terminal", "send"].includes(kind) || !rest.length) usage();
        const file = join(dir, rest.at(-1) ?? "shot.png");
        const lane = rest[0] ?? "";
        if (kind !== "list") {
          await side.getByRole("button", { name: new RegExp(escape(lane)) }).first().click();
          await page.locator("h1", { hasText: lane }).waitFor();
        }
        // Each shot waits for what it shows, not a fixed time: the 2026-10-08 QA's PC path ran past fixed 1.5 s and 3 s
        // waits (a blank terminal, a send still "Sending…"). A shot that times out is still taken, as the evidence.
        if (kind === "terminal") {
          await page.locator(".chan .tabs").getByRole("tab", { name: "Terminal" }).click();
          const rows = page.getByRole("region", { name: `Terminal of #${lane}` }).locator(".xterm-rows");
          await rows.waitFor({ timeout: 15_000 });
          await page.waitForFunction(el => (el?.textContent ?? "").trim().length > 0, await rows.elementHandle(), { timeout: 15_000 }).catch(() => {});
        } else if (kind === "send") {
          const text = rest.slice(1, -1).join(":");
          await page.locator(".chan .tabs").getByRole("tab", { name: "Messages" }).click();   // a terminal shot before it leaves the Terminal tab open
          await page.locator("#composer").fill(text);
          await page.keyboard.press("Enter");
          await page.getByText(text).last().waitFor({ timeout: 15_000 }).catch(() => {});
          await page.getByText("Sending…").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
        } else {
          await page.waitForTimeout(1500);
        }
        await page.screenshot({ path: file });
        say(`${action} -> ${file}`);
      }
      const me = await page.evaluate(() => fetch("/api/me").then(r => r.json())) as { endpoint: { id: string } };
      const status = await page.evaluate(id => fetch(`/api/devices/${id}/revoke`, { method: "POST" }).then(r => r.status), me.endpoint.id);
      say(`this QA device revoked itself: ${status}`);
    } finally {
      await browser.close();
    }
    break;
  }
  default:
    usage();
}
process.exit(0);                                         // a FleetClient may still hold its socket
