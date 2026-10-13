// A ref brief needs a ledger. Without one it can never be answered (cant_check, and it never expires), so filing
// and a dry run refuse it and store nothing.
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

let hub: InProcessHub;
const watch: Watch = { workers: () => [{ id: "%1", name: "manager" }], history: () => [], openQuestions: () => [], screen: () => undefined };
afterEach(async () => { await hub?.close(); });

describe("a ref with no ledger", () => {
  it("is refused, and nothing is stored", async () => {
    hub = await startInProcessHub({ now: () => NOW, watch });
    const token = hub.agents.issue("manager", "manager").secret;
    const markdown = example().replace("project: support\n", "project: support\nref: ny-5\n");
    const res = await fetch(`${hub.base}/api/agent/decisions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/markdown" },
      body: markdown,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("no_ledger");
    expect(hub.store.currentBriefs()).toEqual([]);
    expect(hub.store.openBriefCount("manager", "manager")).toBe(0);
  });
});
