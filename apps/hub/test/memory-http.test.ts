// Memory's agent door (ADR-0031, docs/design/memory/README.md "Agent door"): under /api/agent/memory/, a bearer agent
// token and X-Morndo-Lane as the board has them, served whether the board is on or off, on the agent door's rate
// buckets; refusals answer 400, 403, 404 or 409 with { error }. A real server on a random port, synthetic data only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/adapters/store.ts";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { loadOrCreateIdentity } from "../src/adapters/identity.ts";
import { passkeys } from "../src/adapters/passkeys.ts";
import { LIMITS, startHttp, type Limits } from "../src/adapters/http.ts";
import { AccessService } from "../src/application/access-service.ts";
import { AgentAccess } from "../src/application/agent-access.ts";
import { BoardService } from "../src/application/board-service.ts";
import { EscalationService } from "../src/application/escalation-service.ts";
import { MemoryService } from "../src/application/memory-service.ts";
import { ObservationService } from "../src/application/observation-service.ts";
import { RemoteService } from "../src/application/remote-service.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import type { Config } from "../src/config.ts";

type Hub = { base: string; agents: AgentAccess; memory: MemoryService; close(): Promise<void> };
const open: Hub[] = [];
afterEach(async () => { for (const h of open.splice(0)) await h.close(); });

async function hub(o: { board: boolean; memory: boolean; limits?: Limits }): Promise<Hub> {
  const dir = mkdtempSync(join(tmpdir(), "morndo-memory-http-"));
  const web = join(dir, "web");
  mkdirSync(web);
  writeFileSync(join(web, "200.html"), "<!doctype html><html><body>shell</body></html>");
  const store = new Store(dir);
  const memoryStore = new MemoryStore(dir);
  const config: Config = {
    dataDir: dir, port: 0, origin: "https://hub.example.test", rpId: "hub.example.test", rpName: "Morndo",
    requireProxyIdentity: true, principalLogin: "principal@example.test", tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null,
    pollMs: 1000, quietAfterMs: 1000, managerWindow: "manager", ledgerPath: null, paneLock: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
  const access = new AccessService(store, passkeys(config));
  const tmux = { listWorkers: async () => [], capture: async () => null, captureMany: async () => new Map<string, string | null>(), send: async () => ({ problem: null, typedAt: Date.now() }) };
  const escalations = new EscalationService({
    watch: { workers: () => [], history: () => [], openQuestions: () => [], screen: () => undefined },
    ledger: null, store, managerName: "manager", send: async () => ({ problem: null, typedAt: 0 }),
  });
  const remote = new RemoteService({ store, terminal: { frame: async () => null, keys: async () => false }, panes: () => [], desktop: () => null });
  const agents = new AgentAccess(store, "manager");
  const memory = new MemoryService({ store: memoryStore });
  const http = startHttp({
    config, identity: loadOrCreateIdentity(dir), access, store, observation: new ObservationService(tmux, 1000), steering: new SteeringService(store, tmux), escalations, remote,
    board: o.board ? { service: new BoardService({ store, policy: () => access.policy() }), agents } : null,
    memory: o.memory ? { service: memory, agents } : null,
    ...(o.limits ? { limits: o.limits } : {}),
  });
  await http.ready;
  const h: Hub = {
    base: `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`, agents, memory,
    close: async () => { await http.close(); memoryStore.close(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
  open.push(h);
  return h;
}

type Body = Record<string, unknown>;
const agent = (h: Hub, token: string | null, lane?: string) => {
  const headers = (json: boolean): Record<string, string> => ({
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...(lane ? { "x-morndo-lane": lane } : {}), ...(json ? { "content-type": "application/json" } : {}),
  });
  return {
    get: async (path: string) => { const r = await fetch(h.base + path, { headers: headers(false) }); return { status: r.status, body: (await r.json()) as Body }; },
    post: async (path: string, body: unknown) => {
      const r = await fetch(h.base + path, { method: "POST", headers: headers(true), body: typeof body === "string" ? body : JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as Body };
    },
  };
};
const fact = (over: Body = {}) => ({ kind: "fact", scope: "repo:shop-api", title: "Ports", body: "The api listens on 8080.", ...over });

describe("who calls (B1, M3)", () => {
  it("needs a live token, and a worker token needs its lane; the token and lane are the provenance, never the body", async () => {
    const h = await hub({ board: true, memory: true });
    const worker = h.agents.issue("lanes", "worker").secret;
    const manager = h.agents.issue("manager", "manager").secret;
    expect((await agent(h, null).get("/api/agent/memory/search?q=x")).status).toBe(401);
    expect(await agent(h, "mat_nope", "api-fix").get("/api/agent/memory/search?q=x")).toEqual({ status: 401, body: { error: "unknown_token" } });
    expect(await agent(h, worker).get("/api/agent/memory/search?q=x")).toEqual({ status: 400, body: { error: "lane_needed" } });
    expect((await agent(h, worker, "bad lane").get("/api/agent/memory/search?q=x")).status).toBe(400);
    const made = await agent(h, worker, "api-fix").post("/api/agent/memory/notes", fact({ node: "pc" }));
    expect(made.status).toBe(201);
    expect(made.body.note).toMatchObject({ id: "N-1", provenance: { by: "lane:api-fix", node: "pc" }, tier: 3 });
    // A body that tries to say who wrote it, or to be the owner's, is not listened to.
    const claimed = await agent(h, worker, "api-fix").post("/api/agent/memory/notes", fact({ title: "Claimed", provenance: { by: "principal:console" }, tier: 1, approvedAt: 1 }));
    expect(claimed.status).toBe(201);
    expect(claimed.body.note).toMatchObject({ provenance: { by: "lane:api-fix" }, tier: 3, approvedAt: null });
    const byManager = await agent(h, manager).post("/api/agent/memory/notes", fact({ title: "Manager's" }));
    expect((byManager.body.note as Body).provenance).toMatchObject({ by: "manager:manager" });
  });

  it("spends the agent door's buckets: refused tokens per caller address", async () => {
    const h = await hub({ board: false, memory: true, limits: { ...LIMITS, agentRefusals: { capacity: 2, refillPerSecond: 0.001 } } });
    expect((await agent(h, "mat_guess1", "a").get("/api/agent/memory/search")).status).toBe(401);
    expect((await agent(h, "mat_guess2", "a").get("/api/agent/memory/search")).status).toBe(401);
    expect((await agent(h, "mat_guess3", "a").get("/api/agent/memory/search")).status).toBe(429);
    const worker = h.agents.issue("lanes", "worker").secret;
    expect((await agent(h, worker, "a").get("/api/agent/memory/search")).status).toBe(429);   // this address has spent its refusals
  });
});

describe("board on or off", () => {
  it("serves Memory with the board off, and the board's routes still say board_off", async () => {
    const h = await hub({ board: false, memory: true });
    const worker = h.agents.issue("lanes", "worker").secret;
    expect((await agent(h, worker, "api-fix").post("/api/agent/memory/notes", fact())).status).toBe(201);
    expect((await agent(h, worker, "api-fix").get("/api/agent/memory/search?q=8080")).body.notes).toHaveLength(1);
    expect(await agent(h, worker, "api-fix").get("/api/agent/board")).toEqual({ status: 404, body: { error: "board_off" } });
    expect(await agent(h, worker, "api-fix").get("/api/agent/whoami")).toEqual({ status: 404, body: { error: "board_off" } });
  });
  it("answers memory_off when Memory isn't wired, and the board serves as before", async () => {
    const h = await hub({ board: true, memory: false });
    const worker = h.agents.issue("lanes", "worker").secret;
    expect(await agent(h, worker, "api-fix").get("/api/agent/memory/search?q=x")).toEqual({ status: 404, body: { error: "memory_off" } });
    expect((await agent(h, worker, "api-fix").get("/api/agent/board")).status).toBe(200);
  });
});

describe("the routes and their refusals", () => {
  it("searches deliverable notes only, with the query's limits", async () => {
    const h = await hub({ board: false, memory: true });
    const lane = agent(h, h.agents.issue("lanes", "worker").secret, "api-fix");
    await lane.post("/api/agent/memory/notes", fact());
    await lane.post("/api/agent/memory/notes", fact({ kind: "procedure", title: "Open 8080" }));
    await lane.post("/api/agent/memory/notes", fact({ title: "From a mail about 8080", untrusted: true }));
    const r = await lane.get("/api/agent/memory/search?q=8080&scope=repo:shop-api&limit=5");
    expect(r.status).toBe(200);
    expect((r.body.notes as Body[]).map(n => n.id)).toEqual(["N-1"]);
    expect((await lane.get("/api/agent/memory/search?kind=procedure")).body.notes).toEqual([]);
    expect(await lane.get("/api/agent/memory/search?q=x&limit=99")).toEqual({ status: 400, body: { error: "bad_limit" } });
    expect(await lane.get("/api/agent/memory/search?q=x&scope=team")).toEqual({ status: 400, body: { error: "bad_scope" } });
    expect(await lane.get("/api/agent/memory/search?q=x&kind=rumour")).toEqual({ status: 400, body: { error: "bad_kind" } });
  });

  it("maps each refusal to its status: 400 bad body or field, 403 not yours, 404 not found, 409 already done or mismatched", async () => {
    const h = await hub({ board: false, memory: true });
    const secret = h.agents.issue("lanes", "worker").secret;
    const apiFix = agent(h, secret, "api-fix");
    const webFix = agent(h, secret, "web-fix");
    expect((await apiFix.post("/api/agent/memory/notes", "{not json")).status).toBe(400);
    expect(await apiFix.post("/api/agent/memory/notes", fact({ kind: "rumour" }))).toEqual({ status: 400, body: { error: "bad_request" } });
    expect(await apiFix.post("/api/agent/memory/notes", fact({ scope: "team" }))).toEqual({ status: 400, body: { error: "bad_scope" } });
    expect(await apiFix.post("/api/agent/memory/notes", fact({ title: "  " }))).toEqual({ status: 400, body: { error: "empty" } });
    const proc = (await apiFix.post("/api/agent/memory/notes", fact({ kind: "procedure", title: "Steps" }))).body.note as Body;
    const plain = (await apiFix.post("/api/agent/memory/notes", fact({ title: "Plain" }))).body.note as Body;
    // One note: the caller's own unapproved procedure, yes; another lane, 404.
    expect((await apiFix.get(`/api/agent/memory/notes/${String(proc.id)}`)).status).toBe(200);
    expect(await webFix.get(`/api/agent/memory/notes/${String(proc.id)}`)).toEqual({ status: 404, body: { error: "not_found" } });
    expect((await webFix.get(`/api/agent/memory/notes/${String(plain.id)}`)).body.note).toMatchObject({ id: plain.id });
    expect(await webFix.get("/api/agent/memory/notes/N-404")).toEqual({ status: 404, body: { error: "not_found" } });
    expect((await webFix.get("/api/agent/memory/notes/bogus")).status).toBe(404);
    // Invalidate: another lane's note is 403; twice is 409; a missing reason is a bad body.
    expect(await webFix.post(`/api/agent/memory/notes/${String(plain.id)}/invalidate`, { reason: "wrong" })).toEqual({ status: 403, body: { error: "not_yours" } });
    expect(await apiFix.post(`/api/agent/memory/notes/${String(plain.id)}/invalidate`, {})).toEqual({ status: 400, body: { error: "bad_request" } });
    const gone = await apiFix.post(`/api/agent/memory/notes/${String(plain.id)}/invalidate`, { reason: "wrong" });
    expect(gone.status).toBe(200);
    expect(gone.body.note).toMatchObject({ invalidatedBy: "lane:api-fix", invalidReason: "wrong" });
    expect(await apiFix.post(`/api/agent/memory/notes/${String(plain.id)}/invalidate`, { reason: "again" })).toEqual({ status: 409, body: { error: "invalidated" } });
    // Supersede: another kind is 409 mismatch; a superseded note is 409 invalidated; a missing one 404.
    const base = (await apiFix.post("/api/agent/memory/notes", fact({ title: "Base" }))).body.note as Body;
    expect(await apiFix.post("/api/agent/memory/notes", fact({ kind: "procedure", supersedes: base.id }))).toEqual({ status: 409, body: { error: "mismatch" } });
    const next = await apiFix.post("/api/agent/memory/notes", fact({ title: "Base", body: "Changed.", supersedes: base.id }));
    expect(next.status).toBe(201);
    expect(next.body.note).toMatchObject({ supersedes: base.id });
    expect(await apiFix.post("/api/agent/memory/notes", fact({ supersedes: base.id }))).toEqual({ status: 409, body: { error: "invalidated" } });
    expect(await apiFix.post("/api/agent/memory/notes", fact({ supersedes: "N-404" }))).toEqual({ status: 404, body: { error: "not_found" } });
    expect((await apiFix.get("/api/agent/memory/nope")).status).toBe(404);
  });
});

describe("a note's size on the wire", () => {
  it("takes a note at its character limits however the client escapes it, and refuses more", async () => {
    const h = await hub({ board: false, memory: true });
    const lane = agent(h, h.agents.issue("lanes", "worker").secret, "api-fix");
    // 20,000 CJK characters, each escaped as \uXXXX (6 bytes): about 120 KB of JSON for a body at its limit.
    const escaped = JSON.stringify(fact({ body: "記".repeat(20_000) })).replace(/[\u0080-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    expect(escaped.length).toBeGreaterThan(64 * 1024);
    expect((await lane.post("/api/agent/memory/notes", escaped)).status).toBe(201);
    const huge = JSON.stringify(fact({ body: "x".repeat(170 * 1024) }));
    expect((await lane.post("/api/agent/memory/notes", huge)).status).toBe(413);
  });
});
