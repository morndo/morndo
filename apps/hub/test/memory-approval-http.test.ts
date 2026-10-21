// The principal's route for the console's one-time approval code (ADR-0031, docs/design/memory/README.md "App"; M8):
// POST /api/memory/notes/:id/approval-code, a Command under step-up (AC7) answered once with the code that
// `morndo memory approve <id> --code` spends. A real server on a random port, fake passkeys for a signed-in session, a
// controllable clock, synthetic notes. The code itself is said once on the wire and never logged; only its hash is kept.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/adapters/store.ts";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { loadOrCreateIdentity } from "../src/adapters/identity.ts";
import type { Passkeys } from "../src/adapters/passkeys.ts";
import { startHttp } from "../src/adapters/http.ts";
import { AccessService } from "../src/application/access-service.ts";
import { AgentAccess } from "../src/application/agent-access.ts";
import { BoardService } from "../src/application/board-service.ts";
import { EscalationService } from "../src/application/escalation-service.ts";
import { APPROVAL_CODE_TTL_MS, MemoryService } from "../src/application/memory-service.ts";
import { ObservationService } from "../src/application/observation-service.ts";
import { RemoteService } from "../src/application/remote-service.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import { MEMORY_EXIT, runMemory } from "../src/console/memory.ts";
import type { Config } from "../src/config.ts";

const ORIGIN = "https://hub.example.test";
const CODE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;   // Crockford base32, no I L O U
let now = Date.UTC(2026, 9, 21, 9);

type Hub = { base: string; dir: string; access: AccessService; agents: AgentAccess; close(): Promise<void> };
const open: Hub[] = [];
afterEach(async () => { for (const h of open.splice(0)) await h.close(); });

// Like memory-http.test.ts's hub, but no proxy identity (the principal's own routes) and fake passkeys, as
// inprocess-hub.ts signs a session in with, so a step-up session exists on a clock the test moves.
async function hub(): Promise<Hub> {
  const dir = mkdtempSync(join(tmpdir(), "morndo-memory-code-"));
  const web = join(dir, "web");
  mkdirSync(web);
  writeFileSync(join(web, "200.html"), "<!doctype html><html><body>shell</body></html>");
  const store = new Store(dir);
  const memoryStore = new MemoryStore(dir);
  const config: Config = {
    dataDir: dir, port: 0, origin: ORIGIN, rpId: "hub.example.test", rpName: "Morndo",
    requireProxyIdentity: false, principalLogin: null, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null,
    pollMs: 1000, quietAfterMs: 1000, managerWindow: "manager", ledgerPath: null, paneLock: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
  let n = 0;
  const passkeys: Passkeys = {
    registrationOptions: async () => ({ challenge: `reg-${++n}` }) as never,
    verifyRegistration: async () => ({ credential: { id: `cred-${++n}`, publicKey: new Uint8Array([1]), counter: 1, transports: [] }, userVerified: true }),
    authenticationOptions: async () => ({ challenge: `auth-${++n}` }) as never,
    verifyAuthentication: async () => ({ userVerified: true, newCounter: ++n }),
  };
  const access = new AccessService(store, passkeys, () => now);
  const tmux = { listWorkers: async () => [], capture: async () => null, captureMany: async () => new Map<string, string | null>(), send: async () => ({ problem: null, typedAt: Date.now() }) };
  const escalations = new EscalationService({
    watch: { workers: () => [], history: () => [], openQuestions: () => [], screen: () => undefined },
    ledger: null, store, managerName: "manager", send: async () => ({ problem: null, typedAt: 0 }), now: () => now,
  });
  const remote = new RemoteService({ store, terminal: { frame: async () => null, keys: async () => false }, panes: () => [], desktop: () => null });
  const agents = new AgentAccess(store, "manager");
  const memory = new MemoryService({ store: memoryStore, now: () => now, policy: () => access.policy() });
  const http = startHttp({
    config, identity: loadOrCreateIdentity(dir), access, observation: new ObservationService(tmux, 1000), steering: new SteeringService(store, tmux),
    escalations, remote, board: { service: new BoardService({ store, policy: () => access.policy() }), agents }, memory: { service: memory, agents },
    now: () => now,
  });
  await http.ready;
  const h: Hub = {
    base: `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`, dir, access, agents,
    close: async () => { await http.close(); memoryStore.close(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
  open.push(h);
  return h;
}

// A signed-in device's session secret, as inprocess-hub.ts pairs one.
async function signIn(h: Hub): Promise<string> {
  const opts = await h.access.pairOptions(h.access.issueConsoleToken().secret, "phone");
  if (!("flowId" in opts)) throw new Error(opts.refused);
  const r = await h.access.pairVerify(opts.flowId, {} as never);
  if (!("cookieSecret" in r)) throw new Error(r.refused);
  return r.cookieSecret;
}

const post = async (h: Hub, path: string, cookie?: string, headers: Record<string, string> = {}) => {
  const r = await fetch(h.base + path, { method: "POST", headers: { origin: ORIGIN, ...(cookie ? { cookie: `__Host-morndo=${cookie}` } : {}), ...headers } });
  return { status: r.status, headers: r.headers, body: (await r.json()) as Record<string, unknown> };
};
// A note planted through Memory's agent door, as a lane writes one.
const plant = async (h: Hub, over: Record<string, unknown>): Promise<string> => {
  const worker = h.agents.issue("lanes", "worker").secret;
  const r = await fetch(h.base + "/api/agent/memory/notes", {
    method: "POST", headers: { authorization: `Bearer ${worker}`, "x-morndo-lane": "api-fix", "content-type": "application/json" },
    body: JSON.stringify({ kind: "fact", scope: "repo:shop-api", title: "Ports", body: "The api listens on 8080.", ...over }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { note: { id: string } }).note.id;
};

describe("POST /api/memory/notes/:id/approval-code", () => {
  it("needs a signed-in session under step-up; a note that doesn't wait, or an unknown id, is refused; an agent token is no session", async () => {
    const h = await hub();
    const id = await plant(h, { kind: "procedure", title: "Deploy the api", body: "1. Tag.\n2. Push the tag." });
    const fact = await plant(h, { title: "The api listens on 8080" });
    const route = (note: string) => `/api/memory/notes/${note}/approval-code`;

    expect(await post(h, route(id))).toMatchObject({ status: 401, body: { error: "signed_out" } });
    const stale = await signIn(h);
    now += 2 * 3_600_000;                                       // signed in, but its step-up window (1h) is past
    expect(await post(h, route(id), stale)).toMatchObject({ status: 403, body: { error: "step_up" } });

    const fresh = await signIn(h);
    const minted = await post(h, route(id), fresh);
    expect(minted.status).toBe(200);
    expect(String(minted.body.code)).toMatch(CODE);             // the code reaches the app whole, not redacted away
    expect(minted.body.expiresAt).toBe(now + APPROVAL_CODE_TTL_MS);
    expect(minted.headers.get("cache-control")).toBe("no-store");
    expect(await post(h, route(fact), fresh)).toMatchObject({ status: 409, body: { error: "not_pending" } });
    expect(await post(h, route("N-404"), fresh)).toMatchObject({ status: 404, body: { error: "not_found" } });

    // A bearer agent token is the agents' door identity, not a session: it never reaches a principal route's code.
    const worker = h.agents.issue("lanes", "worker").secret;
    const manager = h.agents.issue("manager", "manager").secret;
    for (const bearer of [worker, manager]) {
      const r = await post(h, route(id), undefined, { authorization: `Bearer ${bearer}`, ...(bearer === worker ? { "x-morndo-lane": "api-fix" } : {}) });
      expect(r).toMatchObject({ status: 401, body: { error: "signed_out" } });
      expect(r.body.code).toBeUndefined();
    }
  });

  it("a code from the route approves at the console, once (M8)", async () => {
    const h = await hub();
    const id = await plant(h, { kind: "procedure", title: "Deploy the api", body: "1. Tag.\n2. Push the tag." });
    const minted = await post(h, `/api/memory/notes/${id}/approval-code`, await signIn(h));
    expect(minted.status).toBe(200);
    const code = String(minted.body.code);
    const said: string[] = [];
    const io = { env: { HOME: h.dir }, out: async (t: string) => { said.push(t); }, err: async (t: string) => { said.push(t); } };
    expect(await runMemory(["approve", id, "--code", code], io, { dataDir: h.dir, now: () => now })).toBe(MEMORY_EXIT.ok);
    expect(said.join("\n")).toContain(`approved ${id}`);
    expect(await runMemory(["approve", id, "--code", code], io, { dataDir: h.dir, now: () => now })).toBe(MEMORY_EXIT.refused);
    expect(said.join("\n")).toContain("that code is wrong, already used or expired");
  });
});
