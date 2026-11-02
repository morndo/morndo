// GET /api/signins/accounts spends the same read bucket as the Engines page (ADR-0039, ADR-0008).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Limits } from "../src/adapters/http.ts";
import { SignInService, type SignInFleet } from "../src/application/signin-service.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

const SMALL: Limits = {
  passkeyPerCaller: { capacity: 10, refillPerSecond: 1 },
  passkeyGlobal: { capacity: 10, refillPerSecond: 1 },
  commands: { capacity: 10, refillPerSecond: 1 },
  uploads: { capacity: 10, refillPerSecond: 1 },
  feedFrames: { capacity: 10, refillPerSecond: 1 },
  linkRequests: { capacity: 10, refillPerSecond: 1 },
  linkPolls: { capacity: 10, refillPerSecond: 1 },
  engineReads: { capacity: 2, refillPerSecond: 0.01 },
  agentCalls: { capacity: 10, refillPerSecond: 1 },
  agentRefusals: { capacity: 10, refillPerSecond: 1 },
  transcriptions: { capacity: 10, refillPerSecond: 1 },
};

const fleet: SignInFleet = {
  nodes: async () => ["n1"],
  op: (async () => ({ ok: true, result: { accounts: [{ name: "a1", signedIn: "ok" as const, retired: false, plan: null }] } })) as SignInFleet["op"],
};

let hub: InProcessHub;
beforeEach(async () => {
  hub = await startInProcessHub({
    limits: SMALL,
    signin: new SignInService({ fleet, now: Date.now, audit: () => {} }),
  });
});
afterEach(async () => { await hub.close(); });

describe("sign-in accounts listing", () => {
  it("is limited like an engines read: past the bucket, 429 with Retry-After", async () => {
    const c = await hub.cookie();
    const h = { cookie: `__Host-morndo=${c}` };
    const q = "/api/signins/accounts?node=n1&runtime=claude";
    expect((await fetch(`${hub.base}${q}`, { headers: h })).status).toBe(200);
    expect((await fetch(`${hub.base}${q}`, { headers: h })).status).toBe(200);
    const refused = await fetch(`${hub.base}${q}`, { headers: h });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await refused.json()).toEqual({ error: "rate_limited" });
  });
});
