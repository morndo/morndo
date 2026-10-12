// #refresh must not store a temporary board status. A ref the list does not have yet is "missing"; past the grace
// window the board calls that settled, but that is not a decision. Only a real terminal state (the list closed it,
// or the ask expired for a reason other than "missing") is written on the row. The ny-401 sequence from review #45.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LEDGER_GRACE_MS } from "@morndo/domain";
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

async function boot(ledger: string) {
  now = NOW;
  hub = await startInProcessHub({ now: () => now, watch, ledger: ledgerReader(ledger, () => now) });
}
afterEach(async () => {
  await hub?.close();
  for (const d of extras.splice(0)) rmSync(d, { recursive: true, force: true });
});

const manager = () => hub.agents.issue("manager", "manager").secret;
const call = (method: string, path: string, body?: { markdown?: string }) => {
  const headers: Record<string, string> = { authorization: `Bearer ${manager()}`, ...(body ? { "content-type": "text/markdown" } : {}) };
  return fetch(hub.base + path, { method, headers, ...(body ? { body: body.markdown } : {}) });
};
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;

describe("refreshing a ref the list does not have yet", () => {
  it("does not store the grace window's temporary settled status, so the ask reopens when the list has it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-brief-ledger-"));
    extras.push(dir);
    const path = join(dir, "ledger.json");
    writeFileSync(path, JSON.stringify({ needsYou: [], needsYouClosed: [] }));
    await boot(path);
    const token = manager();
    const headers = { authorization: `Bearer ${token}` };
    const filed = await call("POST", "/api/agent/decisions", { markdown: withRef("ny-401") });
    expect(filed.status).toBe(201);

    now += 60_000;
    expect((await call("GET", "/api/agent/decisions/ny-401")).status).toBe(200);
    expect(hub.store.brief("ny-401")?.state).toBe("open");

    now += LEDGER_GRACE_MS;
    expect((await fetch(`${hub.base}/api/agent/decisions/ny-401`, { headers })).status).toBe(200);
    expect(hub.store.brief("ny-401")?.state).toBe("open");

    writeFileSync(path, JSON.stringify({ needsYou: [{ id: "ny-401", kind: "tap", question: "How should triage work?" }], needsYouClosed: [] }));
    const cookie = await hub.cookie();
    const board = await json(await fetch(`${hub.base}/api/escalations`, { headers: { cookie: `__Host-morndo=${cookie}`, origin: ORIGIN } }));
    expect((board.items as { id: string; status: string }[]).find(i => i.id === "ny-401")).toMatchObject({ status: "open" });
    const restated = await call("PUT", "/api/agent/decisions/ny-401", { markdown: withRef("ny-401") });
    expect(restated.status).toBe(201);
    expect((await json(restated)).version).toBe(2);
  });
});
