// POST /api/policy with a choice that is an inherited object key ("constructor", "toString") against a real server on a
// random port: refused like any unknown choice, so it can't skip AC8's step-up, make sessions endless (AC5) or block
// every send (AC7). Fake passkeys and a fake clock as in access-service.test.ts; synthetic data only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, POLICY_CHANGE_FRESHNESS_MS, STAY_CHOICES } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { loadOrCreateIdentity } from "../src/adapters/identity.ts";
import { startHttp } from "../src/adapters/http.ts";
import type { Passkeys } from "../src/adapters/passkeys.ts";
import { AccessService } from "../src/application/access-service.ts";
import { ObservationService } from "../src/application/observation-service.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import { EscalationService } from "../src/application/escalation-service.ts";
import { RemoteService } from "../src/application/remote-service.ts";
import type { Config } from "../src/config.ts";

const LOGIN = "principal@example.test";
const ORIGIN = "https://hub.example.test";
let dir: string;
let store: Store;
let now: number;
let nextCred: number;
let access: AccessService;
let http: Awaited<ReturnType<typeof startHttp>>;
let base: string;

const fakePasskeys = (): Passkeys => ({
  registrationOptions: async () => ({ challenge: `reg-${Math.random()}` }) as never,
  verifyRegistration: async () => ({ credential: { id: `cred-${++nextCred}`, publicKey: new Uint8Array([1]), counter: 1, transports: [] }, userVerified: true }),
  authenticationOptions: async () => ({ challenge: `auth-${Math.random()}` }) as never,
  verifyAuthentication: async () => ({ userVerified: true, newCounter: 2 }),
});

async function pairDevice(name = "Laptop") {
  const { secret } = access.issueConsoleToken();
  const opts = await access.pairOptions(secret, name);
  if (!("flowId" in opts)) throw new Error(`refused: ${opts.refused}`);
  const r = await access.pairVerify(opts.flowId, {} as never);
  if (!("cookieSecret" in r)) throw new Error(`refused: ${r.refused}`);
  return r.cookieSecret;
}

const call = (cookie: string, path: string, body?: unknown) => fetch(base + path, {
  method: body === undefined ? "GET" : "POST",
  headers: { "tailscale-user-login": LOGIN, origin: ORIGIN, cookie: `__Host-morndo=${cookie}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-policy-http-"));
  const web = join(dir, "web");
  mkdirSync(web);
  writeFileSync(join(web, "200.html"), "<!doctype html><html><body>shell</body></html>");
  store = new Store(dir);
  now = Date.UTC(2026, 9, 1, 9, 0, 0);
  nextCred = 0;
  const config: Config = {
    dataDir: dir, port: 0, origin: ORIGIN, rpId: "hub.example.test", rpName: "Morndo",
    requireProxyIdentity: true, principalLogin: LOGIN, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 1000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
  access = new AccessService(store, fakePasskeys(), () => now);
  const tmux = { listWorkers: async () => [], capture: async () => null, captureMany: async () => new Map<string, string | null>(), send: async () => ({ problem: null, typedAt: Date.now() }) };
  const escalations = new EscalationService({
    watch: { workers: () => [], history: () => [], openQuestions: () => [], screen: () => undefined },
    ledger: null, store, managerName: "manager", send: async () => ({ problem: null, typedAt: 0 }), policy: () => access.policy(),
  });
  const remote = new RemoteService({ store, terminal: { frame: async () => null, keys: async () => false }, panes: () => [], desktop: () => null, policy: () => access.policy(), now: () => now });
  http = startHttp({
    config, identity: loadOrCreateIdentity(dir), access, observation: new ObservationService(tmux, 1000),
    steering: new SteeringService(store, tmux, () => now, () => access.policy()), escalations, remote,
  });
  await http.ready;
  base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
}, 20_000);                                    // starting a server can take a while on a loaded box
afterEach(async () => { await http.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("POST /api/policy accepts only the listed choices (F1)", () => {
  it("a stay of \"constructor\" is refused without a fresh passkey check, and sessions still expire", async () => {
    const cookie = await pairDevice();
    now += POLICY_CHANGE_FRESHNESS_MS + 60_000;              // the sign-in's passkey check is now 6 minutes old
    const real = await call(cookie, "/api/policy", { stay: "30d", stepUp: "1h" });
    expect(real.status).toBe(403);                           // negative control: loosening a real choice needs the check
    const res = await call(cookie, "/api/policy", { stay: "constructor", stepUp: "1h" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid" });
    expect(((await (await call(cookie, "/api/policy")).json()) as { policy: unknown }).policy).toEqual(DEFAULT_POLICY);
    now += STAY_CHOICES["7d"].absolute;                      // a week unused: past both limits of the policy in force
    expect((await call(cookie, "/api/me")).status).toBe(401);
  });
  it("a step-up of \"toString\" is refused, and sending still works", async () => {
    const cookie = await pairDevice();
    now += 60_000;
    const res = await call(cookie, "/api/policy", { stay: "7d", stepUp: "toString" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid" });
    const sent = await call(cookie, "/api/workers/%251/send", { text: "hi", requestId: crypto.randomUUID(), seen: "none" });
    expect(sent.status).toBe(200);                           // the sign-in's check is a minute old: inside the default hour
  });
});
