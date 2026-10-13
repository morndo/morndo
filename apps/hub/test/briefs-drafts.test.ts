// A worker's draft that was never forwarded is not an ask: it is not on the board, it does not settle a list item,
// and it does not hold that item's ref. Only an open brief (forwarded, or filed by the manager) claims a ref.
// Withdrawn and declined rows do not block a later filing of the same ref.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { ORIGIN, startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import type { Watch } from "../src/application/escalation-service.ts";

const NOW = new Date(2026, 9, 1, 12).getTime();
const doc = readFileSync(new URL("../../../docs/agents/decision-requests.md", import.meta.url), "utf8");
const example = () => {
  const at = doc.indexOf("## An example");
  const open = doc.indexOf("```markdown\n", at);
  const close = doc.indexOf("\n```", open + 12);
  return doc.slice(open + "```markdown\n".length, close + 1);
};
const withRef = (ref: string) => example().replace("project: support\n", `project: support\nref: ${ref}\n`);

let now = NOW;
let hub: InProcessHub;
const extras: string[] = [];
const watch: Watch = { workers: () => [{ id: "%1", name: "manager" }], history: () => [], openQuestions: () => [], screen: () => undefined };

async function boot(ledger?: string) {
  now = NOW;
  hub = await startInProcessHub({
    now: () => now, watch,
    ...(ledger ? { ledger: ledgerReader(ledger, () => now) } : {}),
  });
}
afterEach(async () => {
  await hub?.close();
  for (const d of extras.splice(0)) rmSync(d, { recursive: true, force: true });
});

const worker = () => hub.agents.issue("lanes", "worker").secret;
const manager = () => hub.agents.issue("manager", "manager").secret;
const call = (token: string, lane: string | undefined, method: string, path: string, body?: { markdown?: string; json?: unknown }) => {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(lane ? { "x-morndo-lane": lane } : {}) };
  let payload: string | undefined;
  if (body?.markdown !== undefined) { headers["content-type"] = "text/markdown"; payload = body.markdown; }
  else if (body?.json !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body.json); }
  return fetch(hub.base + path, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
};
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
async function board() {
  const cookie = await hub.cookie();
  return json(await fetch(`${hub.base}/api/escalations`, { headers: { cookie: `__Host-morndo=${cookie}`, origin: ORIGIN } }));
}

function ledger(id: string) {
  const dir = mkdtempSync(join(tmpdir(), "morndo-brief-ledger-"));
  extras.push(dir);
  const path = join(dir, "ledger.json");
  writeFileSync(path, JSON.stringify({ needsYou: [{ id, kind: "tap", question: "How should triage work?" }], needsYouClosed: [] }));
  return path;
}

describe("a draft the manager never forwarded", () => {
  it("is not on the board after the worker withdraws it", async () => {
    await boot();
    const lane = worker();
    const filed = await call(lane, "builder", "POST", "/api/agent/decisions", { markdown: example() });
    expect(filed.status).toBe(201);
    const id = (await json(filed)).id as string;
    expect((await call(lane, "builder", "POST", `/api/agent/decisions/${id}/withdraw`, { json: { why: "never mind" } })).status).toBe(200);
    const items = (await board()).items as { id: string; status: string }[];
    expect(items.find(i => i.id === id)).toBeUndefined();
  });

  it("does not settle the list item it names, and a withdrawn or declined row does not hold the ref", async () => {
    const path = ledger("ny-400");
    await boot(path);
    const lane = worker();
    const filed = await call(lane, "builder", "POST", "/api/agent/decisions", { markdown: withRef("ny-400") });
    expect(filed.status).toBe(201);
    const draftId = (await json(filed)).id as string;
    expect((await call(lane, "builder", "POST", `/api/agent/decisions/${draftId}/withdraw`, { json: { why: "never mind" } })).status).toBe(200);
    const after = (await board()).items as { id: string; status: string; brief: unknown }[];
    const item = after.find(i => i.id === "ny-400");
    expect(item?.status).not.toBe("settled");
    expect(item?.brief ?? null).toBeNull();
    const taken = await call(manager(), undefined, "POST", "/api/agent/decisions", { markdown: withRef("ny-400") });
    expect(taken.status).toBe(201);
    expect((await json(taken)).id).toBe("ny-400");

    const declined = await call(lane, "builder", "POST", "/api/agent/decisions", { markdown: withRef("ny-401") });
    expect(declined.status).toBe(201);
    const declinedId = (await json(declined)).id as string;
    writeFileSync(path, JSON.stringify({
      needsYou: [
        { id: "ny-400", kind: "tap", question: "How should triage work?" },
        { id: "ny-401", kind: "tap", question: "The other ask?" },
      ],
      needsYouClosed: [],
    }));
    expect((await call(manager(), undefined, "POST", `/api/agent/decisions/${declinedId}/decline`, { json: { why: "not this week" } })).status).toBe(200);
    const again = await call(manager(), undefined, "POST", "/api/agent/decisions", { markdown: withRef("ny-401") });
    expect(again.status).toBe(201);
    expect((await json(again)).id).toBe("ny-401");
  });
});
