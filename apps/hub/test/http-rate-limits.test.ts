// Rate limits at the hub's edge (ADR-0008, A6): pairing and login per caller (the proxy's identity header, else the
// remote address) under a looser global ceiling, so nobody can spend the owner's attempts; sends, answers and uploads
// per Endpoint; feed frames per connection; Link requests and their polls per caller. A refusal is 429 with
// Retry-After. Real server on a random port, small limits, fake passkeys; synthetic data only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Limits } from "../src/adapters/http.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

const SMALL: Limits = {
  passkeyPerCaller: { capacity: 3, refillPerSecond: 0.01 },
  passkeyGlobal: { capacity: 5, refillPerSecond: 0.01 },
  commands: { capacity: 2, refillPerSecond: 0.01 },
  uploads: { capacity: 2, refillPerSecond: 0.01 },
  feedFrames: { capacity: 5, refillPerSecond: 0.01 },
  linkRequests: { capacity: 2, refillPerSecond: 0.01 },
  linkPolls: { capacity: 3, refillPerSecond: 0.01 },
  engineReads: { capacity: 2, refillPerSecond: 0.01 },
  agentCalls: { capacity: 3, refillPerSecond: 0.01 },
  agentRefusals: { capacity: 2, refillPerSecond: 0.01 },
  transcriptions: { capacity: 2, refillPerSecond: 0.01 },
};
let hub: InProcessHub;
beforeEach(async () => { hub = await startInProcessHub({ limits: SMALL }); });
afterEach(async () => { await hub.close(); });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => hub.post(path, body, headers);
const cookie = () => hub.cookie();
const pairAs = (login?: string) => post("/api/pair/options", { token: "not-a-token" }, login ? { "tailscale-user-login": login } : {});

describe("pairing and login, per caller", () => {
  it("a caller who spends its attempts gets 429 with Retry-After; another caller is still served", async () => {
    for (let i = 0; i < 3; i++) expect((await pairAs("intruder@example.test")).status).toBe(400);   // a bad token, but served
    const refused = await pairAs("intruder@example.test");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(Number(refused.headers.get("retry-after")))).toBe(true);
    expect(await refused.json()).toEqual({ error: "rate_limited" });
    expect((await pairAs("owner@example.test")).status).toBe(400);                                   // the owner isn't locked out
  });
  it("the pairing page's look at its link is limited like a poll, and spends no passkey attempt", async () => {
    const check = () => post("/api/pair/check", { token: "not-a-token" }, { "tailscale-user-login": "new@example.test" });
    for (let i = 0; i < 3; i++) expect((await check()).status).toBe(400);
    expect((await check()).status).toBe(429);                                                       // the poll bucket
    for (let i = 0; i < 3; i++) expect((await pairAs("new@example.test")).status).toBe(400);       // passkey attempts intact
  });
  it("without an identity header, the caller is its remote address", async () => {
    for (let i = 0; i < 3; i++) await pairAs();
    expect((await pairAs()).status).toBe(429);
    expect((await pairAs("someone@example.test")).status).toBe(400);
  });
  it("a looser global ceiling still holds across callers", async () => {
    for (const who of ["a", "a", "a", "b", "b"]) expect((await pairAs(`${who}@example.test`)).status).toBe(400);
    expect((await pairAs("c@example.test")).status).toBe(429);
  });
  it("login counts the same way", async () => {
    for (let i = 0; i < 3; i++) expect((await post("/api/login/options", {}, { "tailscale-user-login": "x@example.test" })).status).toBe(200);
    expect((await post("/api/login/options", {}, { "tailscale-user-login": "x@example.test" })).status).toBe(429);
  });
});

describe("Link requests, per caller (phase E)", () => {
  const ask = (login: string) => post("/api/link", {}, { "tailscale-user-login": login });
  it("asking to be added: past the caller's bucket, 429 with Retry-After; another caller is still served", async () => {
    for (let i = 0; i < 2; i++) expect((await ask("new@example.test")).status).toBe(200);
    const refused = await ask("new@example.test");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await ask("other@example.test")).status).toBe(200);
  });
  it("asking whether it was added has its own bucket", async () => {
    const id = crypto.randomUUID();
    const poll = () => fetch(`${hub.base}/api/link/${id}`, { headers: { "tailscale-user-login": "new@example.test", "x-morndo-link-secret": "s" } });
    for (let i = 0; i < 3; i++) expect((await poll()).status).toBe(404);
    expect((await poll()).status).toBe(429);
  });
});

describe("per Endpoint", () => {
  it("sends and answers share a bucket: past it, 429 with Retry-After", async () => {
    const c = await cookie();
    const h = { cookie: `__Host-morndo=${c}` };
    expect((await post("/api/workers/%251/send", { text: "a", requestId: crypto.randomUUID(), seen: "none" }, h)).status).toBe(200);
    expect((await post("/api/escalations/ny-1/answer", { key: "x", requestId: crypto.randomUUID() }, h)).status).not.toBe(429);
    const r = await post("/api/workers/%251/send", { text: "c", requestId: crypto.randomUUID(), seen: "none" }, h);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });
  it("uploads have their own bucket", async () => {
    const c = await cookie();
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
    const up = () => fetch(hub.base + "/api/uploads", { method: "POST", headers: { origin: "https://hub.example.test", cookie: `__Host-morndo=${c}`, "content-type": "image/png" }, body: png });
    expect((await up()).status).toBe(200);
    expect((await up()).status).toBe(200);
    const r = await up();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
  });
  it("transcription requests have their own bucket, spent even when the feature is off", async () => {
    const c = await cookie();
    const ask = () => post("/api/transcriptions", { id: "v1", recording: { kind: "upload", id: "nope" }, language: "auto" }, { cookie: `__Host-morndo=${c}` });
    expect((await ask()).status).toBe(404);   // no plugin on this install, but the ask is still an ask
    expect((await ask()).status).toBe(404);
    const r = await ask();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});

describe("feed frames, per connection", () => {
  it("a flood closes the connection with 1008", async () => {
    const c = await cookie();
    const ws = await hub.socket("/api/feed", c);
    const closed = new Promise<number>(r => ws.on("close", code => r(code)));
    for (let i = 0; i < 20; i++) ws.send(JSON.stringify({ t: "watch", worker: null }));
    expect(await closed).toBe(1008);
  });
});
