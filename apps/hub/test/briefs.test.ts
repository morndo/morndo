// Decision briefs on the hub (ADR-0023 §5, §7): file markdown and JSON, refuse a vague brief, a worker's draft, a ref
// on the list, an answer through the inbox, E8, E11, E12, withdraw, settle, the open cap, an audit row with no text,
// and the decisions frame carrying the brief. A temp data dir and a temp port; never a live hub.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lintBrief } from "@morndo/domain";
import { parseBriefMarkdown } from "../src/adapters/brief-template.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { EscalationService, type Watch } from "../src/application/escalation-service.ts";
import { ORIGIN, startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import type { RawData, WebSocket } from "ws";

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
let sent: { pane: string; text: string }[];
const extras: string[] = [];
const watch: Watch = { workers: () => [{ id: "%1", name: "manager" }], history: () => [], openQuestions: () => [], screen: () => undefined };

async function boot(o: { inbox?: boolean; ledger?: string } = {}) {
  now = NOW;
  sent = [];
  hub = await startInProcessHub({
    now: () => now, watch, withInbox: o.inbox ?? false,
    ...(o.ledger ? { ledger: ledgerReader(o.ledger, () => now) } : {}),
    send: async (pane, text) => { sent.push({ pane, text }); return { problem: null, typedAt: now }; },
  });
}
afterEach(async () => {
  await hub?.close();
  for (const d of extras.splice(0)) rmSync(d, { recursive: true, force: true });
});

const manager = () => hub.agents.issue("manager", "manager").secret;
const worker = () => hub.agents.issue("lanes", "worker").secret;
const agent = (token: string, lane?: string) => ({
  call: (method: string, path: string, body?: { markdown?: string; json?: unknown }) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(lane ? { "x-morndo-lane": lane } : {}) };
    let payload: string | undefined;
    if (body?.markdown !== undefined) { headers["content-type"] = "text/markdown"; payload = body.markdown; }
    else if (body?.json !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body.json); }
    return fetch(hub.base + path, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
  },
});

function frames(ws: WebSocket) {
  const seen: Record<string, unknown>[] = [];
  const waiters: { t: string; resolve: (m: Record<string, unknown>) => void }[] = [];
  ws.on("message", (d: RawData) => {
    const text = Array.isArray(d) ? Buffer.concat(d).toString("utf8") : Buffer.from(d).toString("utf8");
    const m = JSON.parse(text) as Record<string, unknown>;
    seen.push(m);
    const i = waiters.findIndex(w => w.t === m.t);
    if (i !== -1) { waiters[i]?.resolve(m); waiters.splice(i, 1); }
  });
  const next = (t: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const had = seen.find(m => m.t === t);
    if (had) return resolve(had);
    waiters.push({ t, resolve });
    setTimeout(() => reject(new Error(`no ${t} frame`)), 3000);
  });
  return { next };
}

const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const briefJson = () => {
  const parsed = parseBriefMarkdown(example());
  const lint = lintBrief(parsed.draft, NOW);
  if (!lint.brief) throw new Error(lint.problems.map(p => p.code).join(","));
  return lint.brief;
};

describe("filing a brief", () => {
  it("accepts the guide's markdown and the same brief as JSON, and a dry run stores nothing", async () => {
    await boot();
    const token = manager();
    const api = agent(token);
    const filed = await api.call("POST", "/api/agent/decisions", { markdown: example() });
    expect(filed.status).toBe(201);
    const body = await json(filed);
    expect(body.id).toBe("d-1");
    expect(body.version).toBe(1);
    expect(body.warnings).toEqual([]);
    const again = await api.call("POST", "/api/agent/decisions?dry=1", { markdown: example() });
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ dry: true, warnings: [] });
    expect(hub.store.currentBriefs()).toHaveLength(1);
    const asJson = await api.call("POST", "/api/agent/decisions", { json: briefJson() });
    expect(asJson.status).toBe(201);
    expect((await json(asJson)).id).toBe("d-2");
  });

  it("a vague brief is 422 with the problem codes and nothing is stored", async () => {
    await boot();
    const vague = example().replace("recommend: b\n", "").replace(" | C · Buy a hosted add-on", "");
    const res = await agent(manager()).call("POST", "/api/agent/decisions", { markdown: vague });
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error).toBe("brief_refused");
    const codes = (body.problems as { code: string }[]).map(p => p.code);
    expect(codes).toContain("no_recommendation");
    expect(codes).toContain("table_columns");
    expect(hub.store.currentBriefs()).toEqual([]);
    expect(hub.store.audit().some(a => a.type.startsWith("Brief"))).toBe(false);
  });

  it("a worker's brief is a draft the principal does not see until the manager forwards it", async () => {
    await boot();
    const lane = worker();
    const filed = await agent(lane, "builder").call("POST", "/api/agent/decisions", { markdown: example() });
    expect(filed.status).toBe(201);
    const id = (await json(filed)).id as string;
    const cookie = await hub.cookie();
    const board = await json(await fetch(`${hub.base}/api/escalations`, { headers: { cookie: `__Host-morndo=${cookie}`, origin: ORIGIN } }));
    expect(board.items).toEqual([]);
    const hidden = await agent(manager()).call("GET", "/api/agent/decisions");
    expect((await json(hidden)).requests).toEqual([]);
    const drafts = await agent(manager()).call("GET", "/api/agent/decisions?drafts=1");
    expect((await json(drafts)).requests).toMatchObject([{ id, status: "draft" }]);
    const forwarded = await agent(manager()).call("POST", `/api/agent/decisions/${id}/forward`);
    expect(forwarded.status).toBe(200);
    const shown = await json(await fetch(`${hub.base}/api/escalations`, { headers: { cookie: `__Host-morndo=${cookie}`, origin: ORIGIN } }));
    expect(shown.items).toMatchObject([{ id, draftedBy: "builder", asker: { kind: "manager" }, brief: { topic: "Support inbox triage" } }]);
    expect((await agent(lane, "builder").call("POST", `/api/agent/decisions/${id}/forward`)).status).toBe(403);
  });

  it("a ref is the list item, and the list decides whether it is open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-brief-ledger-"));
    extras.push(dir);
    const path = join(dir, "ledger.json");
    writeFileSync(path, JSON.stringify({ needsYou: [{ id: "ny-400", kind: "tap", question: "How should triage work?" }], needsYouClosed: [] }));
    await boot({ ledger: path });
    const markdown = example().replace("project: support\n", "project: support\nref: ny-400\n");
    const filed = await agent(manager()).call("POST", "/api/agent/decisions", { markdown });
    expect(filed.status).toBe(201);
    expect((await json(filed)).id).toBe("ny-400");
    const cookie = await hub.cookie();
    const open = await json(await fetch(`${hub.base}/api/escalations`, { headers: { cookie: `__Host-morndo=${cookie}`, origin: ORIGIN } }));
    expect(open.items).toMatchObject([{ id: "ny-400", tracking: "ledger", status: "open", brief: { recommend: "b" } }]);
    writeFileSync(path, JSON.stringify({ needsYou: [], needsYouClosed: [{ id: "ny-400", question: "How should triage work?", answer: "kept manual triage", closedAt: new Date(now).toISOString() }] }));
    hub.escalations.poll();
    const closed = await json(await fetch(`${hub.base}/api/escalations`, { headers: { cookie: `__Host-morndo=${cookie}`, origin: ORIGIN } }));
    expect(closed.items).toMatchObject([{ id: "ny-400", status: "settled" }]);
    const taken = await agent(manager()).call("POST", "/api/agent/decisions", { markdown });
    expect(taken.status).toBe(409);
    expect((await json(taken)).error).toBe("ref_taken");
  });
});

describe("an answer", () => {
  it("goes to the manager's inbox as a tap line, a second answer is refused, and a restate refuses the old version", async () => {
    await boot({ inbox: true });
    const token = manager();
    const api = agent(token);
    expect((await api.call("POST", "/api/agent/decisions", { markdown: example() })).status).toBe(201);
    const cookie = await hub.cookie();
    const headers = { cookie: `__Host-morndo=${cookie}`, origin: ORIGIN, "content-type": "application/json" };
    const before = await json(await fetch(`${hub.base}/api/escalations`, { headers }));
    const version = (before.items as { version: string }[])[0]?.version ?? "";
    const answer = (key: string, seen: string, requestId: string) =>
      hub.post("/api/escalations/d-1/answer", { key, requestId, seen }, { cookie: `__Host-morndo=${cookie}` });
    const first = await answer("b", version, randomUUID());
    expect(first.status).toBe(200);
    expect(sent).toEqual([]);
    const [msg] = readdirSync(join(hub.dir, "manager-inbox", "msg")).map(f => JSON.parse(readFileSync(join(hub.dir, "manager-inbox", "msg", f), "utf8")) as { text: string });
    expect(msg?.text).toBe("[tap d-1] b (Extend the triage script)");
    expect((await answer("a", version, randomUUID())).status).toBe(409);
    now += 60_000;
    const restated = await api.call("PUT", "/api/agent/decisions/d-1", { markdown: example() });
    expect(restated.status).toBe(201);
    expect((await json(restated)).version).toBe(2);
    const stale = await answer("b", version, randomUUID());
    expect(stale.status).toBe(409);
    expect((await json(stale)).error).toBe("changed");
  });

  it("a decision on v1 does not answer v2 after a restart, and the decisions frame carries the brief", async () => {
    await boot();
    const api = agent(manager());
    expect((await api.call("POST", "/api/agent/decisions", { markdown: example() })).status).toBe(201);
    const cookie = await hub.cookie();
    const headers = { cookie: `__Host-morndo=${cookie}`, origin: ORIGIN };
    const before = await json(await fetch(`${hub.base}/api/escalations`, { headers }));
    const version = (before.items as { version: string }[])[0]?.version ?? "";
    expect((await hub.post("/api/escalations/d-1/answer", { key: "b", requestId: randomUUID(), seen: version }, { cookie: `__Host-morndo=${cookie}` })).status).toBe(200);
    expect(sent).toEqual([{ pane: "%1", text: "[tap d-1] b (Extend the triage script)" }]);
    now += 60_000;
    expect((await api.call("PUT", "/api/agent/decisions/d-1", { markdown: example() })).status).toBe(201);
    const restarted = new EscalationService({
      watch, ledger: null, store: hub.store, managerName: "manager", now: () => now,
      send: async () => ({ problem: null, typedAt: now }),
      briefs: () => hub.briefs.sightings(),
    });
    restarted.poll();
    expect(restarted.board().items.find(i => i.id === "d-1")).toMatchObject({ status: "open", decision: null, briefVersion: 2 });
    const ws = await hub.socket("/api/feed", cookie);
    const feed = frames(ws);
    ws.send(JSON.stringify({ t: "hello" }));
    const frame = await feed.next("decisions");
    const item = (frame.items as { id: string; brief: { topic: string } | null }[]).find(i => i.id === "d-1");
    expect(item?.brief?.topic).toBe("Support inbox triage");
    ws.close();
  });
});

describe("closing a brief", () => {
  it("withdraw and settle leave the list, and the twenty-first open brief is refused", async () => {
    await boot();
    const api = agent(manager());
    const filed = await api.call("POST", "/api/agent/decisions", { markdown: example() });
    expect((await api.call("POST", "/api/agent/decisions/d-1/withdraw", { json: { why: "the slot was cancelled" } })).status).toBe(200);
    const cookie = await hub.cookie();
    const gone = await json(await fetch(`${hub.base}/api/escalations`, { headers: { cookie: `__Host-morndo=${cookie}`, origin: ORIGIN } }));
    expect(gone.items).toMatchObject([{ id: "d-1", status: "settled", resolution: "the slot was cancelled" }]);
    expect(filed.status).toBe(201);
    const body = briefJson();
    for (let n = 0; n < 20; n++) expect((await api.call("POST", "/api/agent/decisions", { json: body })).status).toBe(201);
    const cap = await api.call("POST", "/api/agent/decisions", { json: body });
    expect(cap.status).toBe(409);
    expect((await json(cap)).error).toBe("too_many_open");
  });

  it("the audit row names the id, version, asker and token, and not the brief's text", async () => {
    await boot();
    expect((await agent(manager()).call("POST", "/api/agent/decisions", { markdown: example() })).status).toBe(201);
    const row = hub.store.audit().find(a => a.type === "BriefFiled");
    expect(row?.body).toMatchObject({ type: "BriefFiled", id: "d-1", version: 1, asker: { kind: "manager", name: "manager" } });
    const text = JSON.stringify(row?.body);
    expect(text).not.toContain("Support inbox triage");
    expect(text).not.toContain("$2,400");
    expect(text).not.toContain("contractor");
  });
});
