// AC5 + AC8 (F9): once a Session is past the limits of the policy in force, it is over for good. Loosening the policy
// later applies to live sessions only; it never revives one that already expired (safe default: end rather than
// revive). AccessService with a real SQLite store, fake passkeys and a fake clock, as in access-service.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionState } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { AccessService, hashSecret } from "../src/application/access-service.ts";
import type { Passkeys } from "../src/adapters/passkeys.ts";

const HOUR = 60 * 60_000;
let dir: string;
let store: Store;
let now: number;
let nextCred: number;
let signIns: number;
let access: AccessService;

const fakePasskeys = (): Passkeys => ({
  registrationOptions: async () => ({ challenge: `reg-${Math.random()}` }) as never,
  verifyRegistration: async () => ({ credential: { id: `cred-${++nextCred}`, publicKey: new Uint8Array([1]), counter: 1, transports: [] }, userVerified: true }),
  authenticationOptions: async () => ({ challenge: `auth-${Math.random()}` }) as never,
  verifyAuthentication: async () => ({ userVerified: true, newCounter: ++signIns + 1 }),
});

async function pairDevice(name: string) {
  const { secret } = access.issueConsoleToken();
  const opts = await access.pairOptions(secret, name);
  if (!("flowId" in opts)) throw new Error(`refused: ${opts.refused}`);
  const r = await access.pairVerify(opts.flowId, {} as never);
  if (!("cookieSecret" in r)) throw new Error(`refused: ${r.refused}`);
  return r.cookieSecret;
}

const signedIn = (cookie: string) => {
  const a = access.authenticate(cookie);
  if (!a) throw new Error("setup: not signed in");
  return a;
};

// The laptop proves presence again (AC8 wants a check from the last 5 minutes before loosening), then loosens.
async function loosen(cookie: string, next: Parameters<AccessService["setPolicy"]>[1]) {
  const o = await access.stepUpOptions(signedIn(cookie));
  if (!("ok" in (await access.stepUpVerify(signedIn(cookie), o.flowId, { id: "cred-1" } as never)))) throw new Error("setup: step-up");
  if (!("policy" in access.setPolicy(signedIn(cookie), next))) throw new Error("setup: loosen");
}

// What the hub holds for this cookie right now, read without touching it.
const stateOf = (cookie: string) => {
  const s = store.session(hashSecret(cookie));
  if (!s) throw new Error("setup: no session");
  return sessionState(s, now, access.policy());
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-expired-"));
  store = new Store(dir);
  now = Date.UTC(2026, 9, 1, 9, 0, 0);
  nextCred = 0;
  signIns = 0;
  access = new AccessService(store, fakePasskeys(), () => now);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("an expired session stays expired when the policy is loosened later", () => {
  it("a device that idle-expired under 7 days isn't signed in again by a switch to 30 days", async () => {
    const laptop = await pairDevice("Laptop");                // cred-1
    const tablet = await pairDevice("Tablet");                // then left unused
    for (let i = 0; i < 6; i++) { now += 12 * HOUR; signedIn(laptop); }   // the laptop is used twice a day
    expect(stateOf(tablet)).toBe("idle_expired");             // 3 days unused under 7d (1 day idle)
    await loosen(laptop, { stay: "30d", stepUp: "signin" });
    expect(access.authenticate(tablet)).toBeNull();
    expect(access.authenticate(laptop)).not.toBeNull();        // the live session does get the looser policy
  });
  it("a device cut by tightening to 12 hours isn't signed in again when the principal loosens back", async () => {
    const laptop = await pairDevice("Laptop");                // cred-1
    if (!("policy" in access.setPolicy(signedIn(laptop), { stay: "30d", stepUp: "1h" }))) throw new Error("setup");   // the pairing's own check is fresh
    const tablet = await pairDevice("Tablet");
    now += HOUR; signedIn(tablet);                            // last used an hour after pairing
    for (let i = 0; i < 4; i++) { now += 12 * HOUR; signedIn(laptop); }
    access.setPolicy(signedIn(laptop), { stay: "12h", stepUp: "1h" });   // tightening: no check needed
    expect(stateOf(tablet)).toBe("absolute_expired");         // 2 days old under 12h
    now += HOUR;
    const o = await access.loginOptions();                    // the laptop's own 2-day-old session is cut too: sign in again
    const again = await access.loginVerify(o.flowId, { id: "cred-1" } as never);
    if (!("cookieSecret" in again)) throw new Error(`setup: ${again.refused}`);
    await loosen(again.cookieSecret, { stay: "30d", stepUp: "1h" });
    expect(access.authenticate(tablet)).toBeNull();
    expect(access.authenticate(again.cookieSecret)).not.toBeNull();
  });
});
