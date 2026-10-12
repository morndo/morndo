// A dry run runs the same checks as filing (bad ref, a ref changed on restate, ref_taken, too_many_open) and
// reports them. It stores nothing: no row, no counter, no audit.
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

const token = () => hub.agents.issue("manager", "manager").secret;
const call = (method: string, path: string, body: { markdown?: string; json?: unknown }) => {
  const headers: Record<string, string> = { authorization: `Bearer ${token()}` };
  let payload: string;
  if (body.markdown !== undefined) { headers["content-type"] = "text/markdown"; payload = body.markdown; }
  else { headers["content-type"] = "application/json"; payload = JSON.stringify(body.json); }
  return fetch(hub.base + path, { method, headers, body: payload });
};
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const brief = () => {
  const lint = lintBrief(parseBriefMarkdown(example()).draft, NOW);
  if (!lint.brief) throw new Error("example");
  return lint.brief;
};

describe("a dry run", () => {
  it("reports a bad ref, a changed ref, and a taken ref, and stores nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-brief-ledger-"));
    extras.push(dir);
    const path = join(dir, "ledger.json");
    writeFileSync(path, JSON.stringify({
      needsYou: [
        { id: "ny-400", kind: "tap", question: "How should triage work?" },
        { id: "ny-402", kind: "tap", question: "The other ask?" },
      ],
      needsYouClosed: [],
    }));
    await boot(path);
    const bad = await call("POST", "/api/agent/decisions?dry=1", { markdown: withRef("T-12") });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toBe("bad_ref");
    expect(hub.store.currentBriefs()).toEqual([]);
    expect(hub.store.audit().some(a => String(a.type).startsWith("Brief"))).toBe(false);

    expect((await call("POST", "/api/agent/decisions", { markdown: withRef("ny-400") })).status).toBe(201);
    const changed = await call("PUT", "/api/agent/decisions/ny-400?dry=1", { markdown: withRef("ny-402") });
    expect(changed.status).toBe(400);
    expect((await json(changed)).error).toBe("bad_ref");
    expect(hub.store.brief("ny-400")?.version).toBe(1);

    const taken = await call("POST", "/api/agent/decisions?dry=1", { markdown: withRef("ny-400") });
    expect(taken.status).toBe(409);
    expect((await json(taken)).error).toBe("ref_taken");
    expect(hub.store.currentBriefs()).toHaveLength(1);
  });

  it("reports too_many_open and does not take a number", async () => {
    await boot();
    const body = brief();
    for (let n = 0; n < 20; n++) expect((await call("POST", "/api/agent/decisions", { json: body })).status).toBe(201);
    const next = hub.store.peekBriefNumber();
    const dry = await call("POST", "/api/agent/decisions?dry=1", { json: body });
    expect(dry.status).toBe(409);
    expect((await json(dry)).error).toBe("too_many_open");
    expect(hub.store.currentBriefs()).toHaveLength(20);
    expect(hub.store.peekBriefNumber()).toBe(next);
  });
});
