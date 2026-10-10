// AccessService with a real SQLite store in a temp dir and a fake passkey adapter (the WebAuthn crypto is the
// library's job; here we test our orchestration: tokens, limits, sessions, revocation).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, PAIRING_TOKEN_TTL_MS, POLICY_CHANGE_FRESHNESS_MS, SESSION_IDLE_MS, STAY_CHOICES } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { AccessService } from "../src/application/access-service.ts";
import type { Passkeys } from "../src/adapters/passkeys.ts";

let dir: string;
let store: Store;
let now: number;
let nextCred: number;
let signIns: number;
let access: AccessService;

// Test doubles: `{ ok: false }` makes the registration check fail, `{ uv: false }` an assertion without user verification.
const fakePasskeys = (): Passkeys => ({
  registrationOptions: async () => ({ challenge: `reg-${Math.random()}` }) as never,
  verifyRegistration: async (response: unknown) =>
    (response as { ok?: boolean }).ok === false ? null
      : { credential: { id: `cred-${++nextCred}`, publicKey: new Uint8Array([1]), counter: 1, transports: [] }, userVerified: true },
  authenticationOptions: async () => ({ challenge: `auth-${Math.random()}` }) as never,
  verifyAuthentication: async (response: unknown) => ({ userVerified: (response as { uv?: boolean }).uv !== false, newCounter: ++signIns + 1 }),
});

async function pairDevice(name = "iPhone") {
  const { secret } = access.issueConsoleToken();
  const opts = await access.pairOptions(secret, name);
  if (!("flowId" in opts)) throw new Error(`refused: ${opts.refused}`);
  return { secret, result: await access.pairVerify(opts.flowId, {} as never) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-test-"));
  store = new Store(dir);
  now = Date.UTC(2026, 8, 30, 21, 0, 0);
  nextCred = 0;
  signIns = 0;
  access = new AccessService(store, fakePasskeys(), () => now);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("pairing (AC1, AC2)", () => {
  it("pairs a device with a fresh console token and starts a session", async () => {
    const { result } = await pairDevice();
    expect("cookieSecret" in result).toBe(true);
    if (!("cookieSecret" in result)) return;
    expect(access.authenticate(result.cookieSecret)?.endpoint.name).toBe("iPhone");
    expect(store.audit().map(a => a.type).reverse()).toEqual(["PairingTokenIssued", "EndpointPaired", "SessionStarted"]);
  });
  it("refuses an unknown or already used token", async () => {
    expect(await access.pairOptions("nope", "x")).toEqual({ refused: "unknown_token" });
    const { secret } = await pairDevice();
    expect(await access.pairOptions(secret, "again")).toEqual({ refused: "used" });
  });
  it("refuses an expired token", async () => {
    const { secret } = access.issueConsoleToken();
    now += PAIRING_TOKEN_TTL_MS;
    expect(await access.pairOptions(secret, "late")).toEqual({ refused: "expired" });
  });
  it("uses a token only once even when two flows race for it", async () => {
    const { secret } = access.issueConsoleToken();
    const a = await access.pairOptions(secret, "a");
    const b = await access.pairOptions(secret, "b");
    if (!("flowId" in a) || !("flowId" in b)) throw new Error("setup");
    const first = await access.pairVerify(a.flowId, {} as never);
    const second = await access.pairVerify(b.flowId, {} as never);
    expect("cookieSecret" in first).toBe(true);
    expect(second).toEqual({ refused: "used" });
  });
  it("refuses a seventh active device, and allows it again after a revoke", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { result } = await pairDevice(`d${i}`);
      if ("endpoint" in result) ids.push(result.endpoint.id);
    }
    const { secret } = access.issueConsoleToken();
    expect(await access.pairOptions(secret, "d7")).toEqual({ refused: "too_many_endpoints" });
    access.revoke(ids[0] ?? "");
    expect("flowId" in (await access.pairOptions(secret, "d7"))).toBe(true);
  });
  it("a flow ID works once, and a failed passkey check doesn't redeem the token", async () => {
    const { secret } = access.issueConsoleToken();
    const opts = await access.pairOptions(secret, "x");
    if (!("flowId" in opts)) throw new Error("setup");
    expect(await access.pairVerify(opts.flowId, { ok: false } as never)).toEqual({ refused: "not_verified" });
    expect(await access.pairVerify(opts.flowId, {} as never)).toEqual({ refused: "bad_flow" });
    expect("flowId" in (await access.pairOptions(secret, "x"))).toBe(true);
  });
});

describe("login and sessions (AC3, AC5)", () => {
  it("logs in with a paired credential and refuses unknown ones or missing user verification", async () => {
    await pairDevice();
    const o1 = await access.loginOptions();
    const ok = await access.loginVerify(o1.flowId, { id: "cred-1" } as never);
    expect("cookieSecret" in ok).toBe(true);
    const o2 = await access.loginOptions();
    expect(await access.loginVerify(o2.flowId, { id: "cred-999" } as never)).toEqual({ refused: "unknown_device" });
    const o3 = await access.loginOptions();
    expect(await access.loginVerify(o3.flowId, { id: "cred-1", uv: false } as never)).toEqual({ refused: "no_user_verification" });
  });
  it("a session expires after the idle limit of the chosen policy", async () => {
    const { result } = await pairDevice();
    if (!("cookieSecret" in result)) throw new Error("setup");
    const a0 = access.authenticate(result.cookieSecret);
    if (!a0) throw new Error("setup");
    expect(access.setPolicy(a0, { stay: "12h", stepUp: "10m" })).toEqual({ policy: { stay: "12h", stepUp: "10m" } });   // tightening: no check needed
    now += SESSION_IDLE_MS - 1;
    expect(access.authenticate(result.cookieSecret)).not.toBeNull();
    now += SESSION_IDLE_MS - 1;
    expect(access.authenticate(result.cookieSecret)).not.toBeNull();   // the previous call touched it
    now += SESSION_IDLE_MS;
    expect(access.authenticate(result.cookieSecret)).toBeNull();
  });
  it("sign out ends the session", async () => {
    const { result } = await pairDevice();
    if (!("cookieSecret" in result)) throw new Error("setup");
    const a = access.authenticate(result.cookieSecret);
    if (!a) throw new Error("setup");
    access.signOut(a.session);
    expect(access.authenticate(result.cookieSecret)).toBeNull();
  });
});

describe("revocation (AC4)", () => {
  it("ends the device's sessions at once, tells listeners, and blocks its passkey", async () => {
    const { result } = await pairDevice();
    if (!("cookieSecret" in result)) throw new Error("setup");
    const told: string[] = [];
    access.onRevoked(id => told.push(id));
    expect(access.revoke(result.endpoint.id)).toBe(true);
    expect(told).toEqual([result.endpoint.id]);
    expect(access.authenticate(result.cookieSecret)).toBeNull();
    const o = await access.loginOptions();
    expect(await access.loginVerify(o.flowId, { id: "cred-1" } as never)).toEqual({ refused: "revoked" });
    expect(access.revoke(result.endpoint.id)).toBe(false);
  });
});

describe("the access policy (AC5, AC7, AC8)", () => {
  it("defaults to 7 days signed in and an hourly check; loosening needs a fresh check; it is audited", async () => {
    const { result } = await pairDevice();
    if (!("cookieSecret" in result)) throw new Error("setup");
    expect(access.policy()).toEqual(DEFAULT_POLICY);
    now += STAY_CHOICES["12h"].absolute;                      // past the old 12 h limit: still signed in by default
    const a = access.authenticate(result.cookieSecret);
    expect(a).not.toBeNull();
    if (!a) return;
    expect(access.setPolicy(a, { stay: "30d", stepUp: "signin" })).toEqual({ refused: "step_up" });
    const o = await access.stepUpOptions(a);
    expect(await access.stepUpVerify(a, o.flowId, { id: "cred-1" } as never)).toEqual({ ok: true });
    const fresh = access.authenticate(result.cookieSecret);
    if (!fresh) throw new Error("setup");
    expect(access.setPolicy(fresh, { stay: "30d", stepUp: "signin" })).toEqual({ policy: { stay: "30d", stepUp: "signin" } });
    expect(store.audit(1)[0]?.type).toBe("PolicyChanged");
    now += POLICY_CHANGE_FRESHNESS_MS;
    expect(access.setPolicy(fresh, { stay: "nope", stepUp: "1h" } as never)).toEqual({ refused: "invalid" });
  });
});
