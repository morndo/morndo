// forward() rechecks the due date at the moment of forwarding (DB3: due after the time it is filed). A draft whose
// due has passed is refused and stays a draft. The design states no lead time beyond "after now".
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import type { Watch } from "../src/application/escalation-service.ts";

const NOW = new Date(2026, 9, 1, 12).getTime();
const doc = readFileSync(new URL("../../../docs/agents/decision-requests.md", import.meta.url), "utf8");
const example = () => {
  const at = doc.indexOf("## An example");
  const open = doc.indexOf("```markdown\n", at);
  const close = doc.indexOf("\n```", open + 12);
  return doc.slice(open + "```markdown\n".length, close + 1);
};

let now = NOW;
let hub: InProcessHub;
const watch: Watch = { workers: () => [{ id: "%1", name: "manager" }], history: () => [], openQuestions: () => [], screen: () => undefined };

async function boot() {
  now = NOW;
  hub = await startInProcessHub({ now: () => now, watch });
}
afterEach(async () => { await hub?.close(); });

const call = (token: string, lane: string | undefined, method: string, path: string, body?: { markdown?: string }) => {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(lane ? { "x-morndo-lane": lane } : {}), ...(body ? { "content-type": "text/markdown" } : {}) };
  return fetch(hub.base + path, { method, headers, ...(body ? { body: body.markdown } : {}) });
};

describe("forwarding a draft", () => {
  it("refuses a draft whose due is already past and leaves it a draft", async () => {
    await boot();
    const lane = hub.agents.issue("lanes", "worker").secret;
    const filed = await call(lane, "builder", "POST", "/api/agent/decisions", { markdown: example() });
    expect(filed.status).toBe(201);
    const id = ((await filed.json()) as { id: string }).id;
    now += 30 * 24 * 60 * 60 * 1000;
    const forwarded = await call(hub.agents.issue("manager", "manager").secret, undefined, "POST", `/api/agent/decisions/${id}/forward`);
    expect(forwarded.status).toBe(400);
    expect(((await forwarded.json()) as { error: string }).error).toBe("due_past");
    expect(hub.store.brief(id)?.state).toBe("draft");
  });
});
