// too_many_open counts the way the board does. Ref briefs the list has already settled do not keep the cap full,
// and the check refreshes before it counts, so a refusal is not stuck on rows the list has closed.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lintBrief } from "@morndo/domain";
import { parseBriefMarkdown } from "../src/adapters/brief-template.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
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
const extras: string[] = [];
const watch: Watch = { workers: () => [{ id: "%1", name: "manager" }], history: () => [], openQuestions: () => [], screen: () => undefined };
afterEach(async () => {
  await hub?.close();
  for (const d of extras.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the open cap", () => {
  it("does not count ref briefs the list has already settled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-brief-ledger-"));
    extras.push(dir);
    const path = join(dir, "ledger.json");
    const open = Array.from({ length: 20 }, (_, i) => ({ id: `ny-${i + 1}`, kind: "tap", question: "How should triage work?" }));
    writeFileSync(path, JSON.stringify({ needsYou: open, needsYouClosed: [] }));
    now = NOW;
    hub = await startInProcessHub({ now: () => now, watch, ledger: ledgerReader(path, () => now) });
    const lint = lintBrief(parseBriefMarkdown(example()).draft, NOW);
    if (!lint.brief) throw new Error("example");
    const token = hub.agents.issue("manager", "manager").secret;
    const post = (body: unknown) => fetch(`${hub.base}/api/agent/decisions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    for (let i = 0; i < 20; i++) expect((await post({ ...lint.brief, ref: `ny-${i + 1}` })).status).toBe(201);
    writeFileSync(path, JSON.stringify({
      needsYou: [],
      needsYouClosed: open.map(i => ({ ...i, answer: "done", closedAt: new Date(now).toISOString() })),
    }));
    const next = await post(lint.brief);
    expect(next.status).toBe(201);
  });
});
