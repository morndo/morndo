// E8: one answer only. A tap line the manager pane already parsed in this poll answers a hub brief, the same way
// it answers a list item. A second answer from the phone is refused.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "@morndo/domain";
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

let now = NOW;
let hub: InProcessHub;
const history: Message[] = [];
const watch: Watch = { workers: () => [{ id: "%1", name: "manager" }], history: () => history, openQuestions: () => [], screen: () => undefined };
afterEach(async () => { history.splice(0); await hub?.close(); });

describe("a tap already in the manager pane", () => {
  it("answers the hub brief, and the phone cannot answer it again", async () => {
    now = NOW;
    hub = await startInProcessHub({ now: () => now, watch });
    const token = hub.agents.issue("manager", "manager").secret;
    const filed = await fetch(`${hub.base}/api/agent/decisions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/markdown" },
      body: example(),
    });
    expect(filed.status).toBe(201);
    history.push({
      id: "m-tap", at: now, author: { kind: "principal", name: "You" }, kind: "text",
      text: "[tap d-1] b (Extend the triage script)",
    });
    hub.escalations.poll();
    const cookie = await hub.cookie();
    const headers = { cookie: `__Host-morndo=${cookie}`, origin: ORIGIN };
    const board = await (await fetch(`${hub.base}/api/escalations`, { headers })).json() as { items: { id: string; status: string; version: string; decision: { via: string } | null }[] };
    const item = board.items.find(i => i.id === "d-1");
    expect(item).toMatchObject({ status: "answered", decision: { via: "elsewhere" } });
    const again = await hub.post("/api/escalations/d-1/answer", { key: "a", requestId: randomUUID(), seen: item?.version ?? "" }, { cookie: `__Host-morndo=${cookie}` });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("already_answered");
  });
});
