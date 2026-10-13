// A synthetic office: a temp data dir, a temp port, a fake manager pane. The CLI files the guide's example; it shows
// on GET /api/escalations; an answer is typed into the pane as a tap line. Never a live hub, never ports 8790 or 8791.
//   node --experimental-strip-types apps/hub/scripts/synthetic-office-brief.ts
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ORIGIN, startInProcessHub } from "../test/inprocess-hub.ts";
import { run } from "../../board-cli/src/decide.ts";

const NOW = new Date(2026, 9, 1, 12).getTime();
const doc = readFileSync(fileURLToPath(new URL("../../../docs/agents/decision-requests.md", import.meta.url)), "utf8");
const at = doc.indexOf("## An example");
const open = doc.indexOf("```markdown\n", at);
const close = doc.indexOf("\n```", open + 12);
const example = doc.slice(open + "```markdown\n".length, close + 1);

const sent: { pane: string; text: string }[] = [];
const hub = await startInProcessHub({
  now: () => NOW,
  watch: { workers: () => [{ id: "%1", name: "manager" }], history: () => [], openQuestions: () => [], screen: () => undefined },
  send: async (pane, text) => { sent.push({ pane, text }); return { problem: null, typedAt: NOW }; },
});

try {
  const token = hub.agents.issue("manager", "manager").secret;
  const lines: string[] = [];
  const code = await run(["new", "-"], { MORNDO_HUB: hub.base, MORNDO_AGENT_TOKEN: token }, {
    fetch, lane: async () => null, now: () => NOW, read: async () => example,
    out: l => lines.push(l), err: l => lines.push(l),
  });
  if (code !== 0) throw new Error(`morndo-decide new exited ${code}: ${lines.join(" | ")}`);
  const cookie = await hub.cookie();
  const headers = { cookie: `__Host-morndo=${cookie}`, origin: ORIGIN, "content-type": "application/json" };
  const board = await (await fetch(`${hub.base}/api/escalations`, { headers })).json() as { items: { id: string; status: string; version: string; brief: { topic: string } | null }[] };
  const item = board.items[0];
  if (!item) throw new Error("GET /api/escalations has no items");
  const answer = await fetch(`${hub.base}/api/escalations/${item.id}/answer`, {
    method: "POST", headers, body: JSON.stringify({ key: "b", requestId: randomUUID(), seen: item.version }),
  });
  if (answer.status !== 200) throw new Error(`answer ${answer.status}: ${await answer.text()}`);
  console.log(`filed ${lines.join(" ")}`);
  console.log(`GET /api/escalations: ${item.id} ${item.status} ${item.brief?.topic ?? ""}`);
  console.log(`pane: ${sent.map(s => s.text).join(" | ") || "(nothing typed)"}`);
} finally {
  await hub.close();
}
