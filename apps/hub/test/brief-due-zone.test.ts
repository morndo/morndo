// A date-only due is the end of that day in one zone: the principal's time_zone setting, UTC when unset.
// Lint and filing use that same rule. The CLI sends the date unchanged.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import type { Watch } from "../src/application/escalation-service.ts";

const NOW = new Date(2026, 9, 1, 12).getTime();
const UTC_END = Date.parse("2026-10-14T23:59:59.000Z");
const BERLIN_END = Date.parse("2026-10-14T21:59:59.000Z");
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

async function file(zone?: string) {
  hub = await startInProcessHub({ now: () => NOW, watch });
  if (zone) hub.store.saveSetting("time_zone", zone);
  const token = hub.agents.issue("manager", "manager").secret;
  const res = await fetch(`${hub.base}/api/agent/decisions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/markdown" },
    body: example(),
  });
  expect(res.status).toBe(201);
  return hub.store.brief("d-1")?.brief.due;
}

describe("a date-only due", () => {
  it("is the end of that day in UTC when no zone is set, and in the configured zone when one is", async () => {
    expect(await file()).toBe(UTC_END);
    await hub.close();
    expect(await file("Europe/Berlin")).toBe(BERLIN_END);
  });
});
