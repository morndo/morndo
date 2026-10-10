// Adding a device from a signed-in one (ADR-0008 phase E; AC10–AC13), at the hub's HTTP edge: "Add a device" needs a
// passkey check from the last 5 minutes and gives a token with a 6-digit code; a Link request from a device not yet
// paired lives 10 minutes, at most 3 at once, is answered once (approve with a fresh check, or deny), and only its own
// secret collects the token; a device added this way can't send before its own passkey check (AC12); every live feed
// is told (AC13). Real server, fake passkeys, a test clock; synthetic data only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LINK_TTL_MS, MAX_ACTIVE_ENDPOINTS } from "@morndo/domain";
import { linkTokenSecret } from "../src/application/access-service.ts";
import { frameText } from "./http-crash-fixture.ts";
import { ORIGIN, startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

let hub: InProcessHub;
let now = Date.UTC(2026, 9, 2, 12);
beforeEach(async () => { now = Date.UTC(2026, 9, 2, 12); hub = await startInProcessHub({ now: () => now }); });
afterEach(async () => { await hub.close(); });

const as = (cookie: string) => ({ cookie: `__Host-morndo=${cookie}` });
const get = (path: string, headers: Record<string, string> = {}) => fetch(hub.base + path, { headers });
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
type Request = { requestId: string; secret: string; code: string; expiresAt: number };
const poll = (id: string, secret: string) => get(`/api/link/${id}`, { "x-morndo-link-secret": secret });
const audit = () => hub.store.audit().map(a => a.type);
// Pairs a new device with a token secret, as the pair page does (typing the code, for a token that has one); returns
// its session's cookie.
async function pairWith(secret: string, name = "laptop", code?: string) {
  const options = await json<{ flowId: string }>(hub.post("/api/pair/options", { token: secret, name, ...(code ? { code } : {}) }));
  const r = await hub.post("/api/pair/verify", { flowId: options.flowId, response: { id: "x", type: "public-key", response: {} } });
  expect(r.status).toBe(200);
  return /__Host-morndo=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1] ?? "";
}

describe("Add a device (AC10)", () => {
  it("issues a token with a 6-digit code within 5 minutes of a passkey check, and audits this device as the issuer", async () => {
    const phone = await hub.cookie();
    const r = await json<{ secret: string; code: string; expiresAt: number }>(hub.post("/api/devices/add", {}, as(phone)));
    expect(r.code).toMatch(/^\d{6}$/);
    expect(r.expiresAt).toBe(now + 10 * 60_000);
    const issued = hub.store.audit().find(a => a.type === "PairingTokenIssued" && (a.body as { issuedBy: { kind: string } }).issuedBy.kind === "endpoint");
    expect(issued).toBeDefined();
    expect(await json(hub.post("/api/pair/check", { token: r.secret }))).toEqual({ needsCode: true, expiresAt: r.expiresAt });   // never the code
  });
  it("asks for a fresh passkey check after 5 minutes, whatever the step-up policy", async () => {
    const phone = await hub.cookie();
    now += 5 * 60_000 + 1;
    const r = await hub.post("/api/devices/add", {}, as(phone));
    expect([r.status, await r.json()]).toEqual([403, { error: "step_up" }]);
  });
  it("not while 6 devices are active (AC2)", async () => {
    const cookies = [];
    for (let i = 0; i < MAX_ACTIVE_ENDPOINTS; i++) cookies.push(await hub.cookie());
    const r = await hub.post("/api/devices/add", {}, as(cookies[0] ?? ""));
    expect([r.status, await r.json()]).toEqual([409, { error: "too_many_endpoints" }]);
  });
  it("the new device can't send before its own passkey check (AC12), and every live feed hears it was added (AC13)", async () => {
    const phone = await hub.cookie();
    const feed = await hub.socket("/api/feed", phone);
    const heard = new Promise<unknown>(resolve => feed.on("message", raw => { const m = JSON.parse(frameText(raw)) as { t: string }; if (m.t === "linked") resolve(m); }));
    const { secret, code } = await json<{ secret: string; code: string }>(hub.post("/api/devices/add", {}, as(phone)));
    const laptop = await pairWith(secret, "laptop", code);
    expect(await heard).toEqual({ t: "linked", name: "laptop", at: now, by: "phone" });
    const me = await json<{ session: { verifiedAt: number } }>(get("/api/me", as(laptop)));
    expect(me.session.verifiedAt).toBe(0);
    const send = await hub.post("/api/workers/%251/send", { text: "hi", requestId: crypto.randomUUID(), seen: "none" }, as(laptop));
    expect([send.status, await send.json()]).toEqual([403, { error: "step_up" }]);
    feed.close();
  });
  it("a console token keeps its credit and has no code", async () => {
    const { secret } = hub.access.issueConsoleToken();
    expect(await json(hub.post("/api/pair/check", { token: secret }))).toMatchObject({ needsCode: false });
    const console = await pairWith(secret, "desk");
    expect((await json<{ session: { verifiedAt: number } }>(get("/api/me", as(console)))).session.verifiedAt).toBe(now);
    const send = await hub.post("/api/workers/%251/send", { text: "hi", requestId: crypto.randomUUID(), seen: "none" }, as(console));
    expect(send.status).not.toBe(403);                                // whatever the pane says, not "verify first"
  });
  it("6 devices active is said before any passkey check (no prompt for nothing)", async () => {
    const cookies = [];
    for (let i = 0; i < 6; i++) cookies.push(await hub.cookie());
    now += 60 * 60_000;                                               // no fresh verification on any of them
    const r = await hub.post("/api/devices/add", {}, as(cookies[0] ?? ""));
    expect([r.status, await r.json()]).toEqual([409, { error: "too_many_endpoints" }]);
  });
  it("the issuing device asks, without counting as use, whether its own token was used, and by which device (review M3)", async () => {
    const phone = await hub.cookie();
    const issued = await json<{ tokenId: string; secret: string; code: string }>(hub.post("/api/devices/add", {}, as(phone)));
    const ask = (cookie: string) => fetch(`${hub.base}/api/devices/add/${issued.tokenId}`, { headers: { ...as(cookie), "x-morndo-background": "1" } });
    expect(await json(ask(phone))).toEqual({ name: null });
    const other = await hub.cookie();                                 // a device paired from the console meanwhile isn't it
    expect(await json(ask(phone))).toEqual({ name: null });
    expect((await ask(other)).status).toBe(404);                      // not that device's token
    await pairWith(issued.secret, "laptop", issued.code);
    expect(await json(ask(phone))).toEqual({ name: "laptop" });
    const seen = () => hub.store.endpoints().find(e => e.name === "phone")?.lastSeenAt;
    const was = seen();
    now += 5 * 60_000;
    await ask(phone);
    expect(seen()).toBe(was);                                         // a background check isn't use (AC5)
    await get("/api/devices", as(phone));
    expect(seen()).toBe(now);                                         // the principal's own request is
  });
  it("Cancel on the issuing device withdraws its token; no other device can (review L6)", async () => {
    const phone = await hub.cookie(), other = await hub.cookie();
    const issued = await json<{ tokenId: string; secret: string }>(hub.post("/api/devices/add", {}, as(phone)));
    expect((await hub.post(`/api/devices/add/${issued.tokenId}/cancel`, {}, as(other))).status).toBe(409);
    expect((await hub.post(`/api/devices/add/${issued.tokenId}/cancel`, {}, as(phone))).status).toBe(200);
    const check = await hub.post("/api/pair/check", { token: issued.secret });
    expect([check.status, await check.json()]).toEqual([400, { error: "expired" }]);
    expect(audit()).toContain("PairingTokenWithdrawn");
  });
  it("a device that wasn't open hears of the addition at its next hello, until it says it has seen it (review M2)", async () => {
    const phone = await hub.cookie();
    now += 60_000;
    const { secret, code } = await json<{ secret: string; code: string }>(hub.post("/api/devices/add", {}, as(phone)));
    await pairWith(secret, "laptop", code);
    const linkedOnHello = async () => {
      const feed = await hub.socket("/api/feed", phone);
      const frames: { t: string }[] = [];
      feed.on("message", raw => frames.push(JSON.parse(frameText(raw)) as { t: string }));
      feed.send(JSON.stringify({ t: "hello" }));
      await new Promise(r => setTimeout(r, 300));
      return { feed, linked: frames.filter(f => f.t === "linked") };
    };
    const first = await linkedOnHello();
    expect(first.linked).toEqual([{ t: "linked", name: "laptop", at: now, by: "phone" }]);
    first.feed.send(JSON.stringify({ t: "linked_seen", at: now }));
    await new Promise(r => setTimeout(r, 100));
    first.feed.close();
    const second = await linkedOnHello();
    expect(second.linked).toEqual([]);
    second.feed.close();
  });
});

describe("Link requests (AC11)", () => {
  const ask = (login?: string) => hub.post("/api/link", {}, login ? { "tailscale-user-login": login } : {});
  it("a device asks, a signed-in one sees the code and who asked, approves with a fresh check, and the device collects its token", async () => {
    const phone = await hub.cookie();
    const req = await json<Request>(ask("principal@example.test"));
    expect(req.code).toMatch(/^\d{6}$/);
    expect(req.expiresAt).toBe(now + LINK_TTL_MS);
    expect(await json(poll(req.requestId, req.secret))).toEqual({ state: "waiting" });
    expect(await json(get(`/api/link/${req.requestId}/details`, as(phone)))).toEqual({   // never the code: it is typed
      createdAt: now, expiresAt: now + LINK_TTL_MS, requester: { login: "principal@example.test" }, state: "open",
    });
    const fingerprint = "ab".repeat(32), proof = "p".repeat(43);
    const bare = await hub.post(`/api/link/${req.requestId}/approve`, {}, as(phone));
    expect([bare.status, await bare.json()]).toEqual([400, { error: "no_identity" }]);   // no pinned identity, no approval (M1)
    expect((await hub.post(`/api/link/${req.requestId}/approve`, { fingerprint, proof, code: req.code }, as(phone))).status).toBe(200);
    const got = await json<{ state: string; token: string; fingerprint: string }>(poll(req.requestId, req.secret));
    expect(got).toEqual({ state: "approved", token: linkTokenSecret(req.secret), fingerprint, proof });
    const trail = hub.store.audit().filter(a => a.type === "LinkRequested" || a.type === "LinkApproved").map(a => a.body);
    expect(trail).toEqual(expect.arrayContaining([expect.objectContaining({ requester: { login: "principal@example.test" } }), expect.objectContaining({ tokenId: expect.any(String) })]));   // L2
    expect(await json(poll(req.requestId, req.secret))).toEqual(got);                // a lost reply can be asked for again
    expect(await json(hub.post("/api/pair/check", { token: got.token }))).toMatchObject({ needsCode: false });   // typed on the approver
    const laptop = await pairWith(got.token);
    expect((await json<{ session: { verifiedAt: number } }>(get("/api/me", as(laptop)))).session.verifiedAt).toBe(0);
    expect(audit()).toEqual(expect.arrayContaining(["LinkRequested", "LinkApproved", "PairingTokenIssued", "EndpointPaired"]));
    const again = await hub.post(`/api/link/${req.requestId}/deny`, {}, as(phone));
    expect([again.status, await again.json()]).toEqual([409, { error: "decided" }]);
  });
  it("only the requester's own secret collects: a wrong one and an unknown request look the same", async () => {
    const req = await json<Request>(ask());
    const wrong = await poll(req.requestId, "not-the-secret");
    expect([wrong.status, await wrong.json()]).toEqual([404, { error: "unknown" }]);
    const none = await get(`/api/link/${req.requestId}`);
    expect(none.status).toBe(404);
    const unknown = await poll(crypto.randomUUID(), req.secret);
    expect([unknown.status, await unknown.json()]).toEqual([404, { error: "unknown" }]);
  });
  it("approving needs a passkey check from the last 5 minutes; denying doesn't", async () => {
    const phone = await hub.cookie();
    const a = await json<Request>(ask()), b = await json<Request>(ask());
    now += 5 * 60_000 + 1;
    const late = await hub.post(`/api/link/${a.requestId}/approve`, { fingerprint: "ab".repeat(32), proof: "p".repeat(43), code: a.code }, as(phone));
    expect([late.status, await late.json()]).toEqual([403, { error: "step_up" }]);
    expect((await hub.post(`/api/link/${b.requestId}/deny`, {}, as(phone))).status).toBe(200);
    expect(await json(poll(b.requestId, b.secret))).toEqual({ state: "denied" });
    expect(audit()).toContain("LinkDenied");
  });
  it("expires after 10 minutes: nothing to approve or collect, and the audit says so once", async () => {
    const phone = await hub.cookie();
    const req = await json<Request>(ask());
    now += LINK_TTL_MS;
    expect(await json(poll(req.requestId, req.secret))).toEqual({ state: "expired" });
    const r = await hub.post(`/api/link/${req.requestId}/approve`, { fingerprint: "ab".repeat(32), proof: "p".repeat(43), code: req.code }, as(phone));
    expect([r.status, await r.json()]).toEqual([409, { error: "expired" }]);
    expect(audit().filter(t => t === "LinkExpired")).toHaveLength(1);
  });
  it("at most 3 open at once; an answered or expired one frees its place", async () => {
    const phone = await hub.cookie();
    const first = await json<Request>(ask("a@example.test"));
    await ask("b@example.test"); await ask("c@example.test");
    const fourth = await ask("d@example.test");
    expect([fourth.status, await fourth.json()]).toEqual([409, { error: "too_many" }]);
    await hub.post(`/api/link/${first.requestId}/deny`, {}, as(phone));
    expect((await ask("d@example.test")).status).toBe(200);
  });
  it("a request from another site is refused (the origin check)", async () => {
    const r = await fetch(`${hub.base}/api/link`, { method: "POST", headers: { origin: "https://elsewhere.example", "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(403);
    expect(ORIGIN).not.toBe("https://elsewhere.example");
  });
  it("approving with 6 devices active is refused (AC2)", async () => {
    const cookies = [];
    for (let i = 0; i < MAX_ACTIVE_ENDPOINTS; i++) cookies.push(await hub.cookie());
    const req = await json<Request>(ask());
    const r = await hub.post(`/api/link/${req.requestId}/approve`, { fingerprint: "ab".repeat(32), proof: "p".repeat(43), code: req.code }, as(cookies[0] ?? ""));
    expect([r.status, await r.json()]).toEqual([409, { error: "too_many_endpoints" }]);
  });
  it("an approval in the request's last seconds is still collected after its 10 minutes (review L1)", async () => {
    const req = await json<Request>(ask());
    now += LINK_TTL_MS - 1000;
    const fresh = await hub.cookie();                                 // a device verified just now approves
    expect((await hub.post(`/api/link/${req.requestId}/approve`, { fingerprint: "ab".repeat(32), proof: "p".repeat(43), code: req.code }, as(fresh))).status).toBe(200);
    now += 2000;
    expect(await json(poll(req.requestId, req.secret))).toMatchObject({ state: "approved" });
  });
  it("Cancel with the requester's own secret ends it and frees its place; a wrong secret can't (review L6)", async () => {
    const reqs = [await json<Request>(ask()), await json<Request>(ask()), await json<Request>(ask())];
    expect((await ask()).status).toBe(409);
    const cancel = (id: string, secret: string) => hub.post(`/api/link/${id}/cancel`, {}, { "x-morndo-link-secret": secret });
    const first = reqs[0] ?? reqs[1];
    if (!first) throw new Error();
    expect((await cancel(first.requestId, "wrong")).status).toBe(404);
    expect((await cancel(first.requestId, first.secret)).status).toBe(200);
    expect(await json(poll(first.requestId, first.secret))).toEqual({ state: "cancelled" });
    expect((await cancel(first.requestId, first.secret)).status).toBe(409);
    expect((await ask()).status).toBe(200);
    expect(audit()).toContain("LinkCancelled");
  });
});

describe("revoking a device ends what it issued (whole-branch review M1)", () => {
  const identity = { fingerprint: "ab".repeat(32), proof: "p".repeat(43) };
  const endpointOf = (cookie: string) => hub.access.authenticate(cookie, false)?.endpoint.id ?? "";
  it("its Add a device link can't pair once it is revoked", async () => {
    const phone = await hub.cookie();
    const { secret, code } = await json<{ secret: string; code: string }>(hub.post("/api/devices/add", {}, as(phone)));
    expect(hub.access.revoke(endpointOf(phone))).toBe(true);
    const r = await hub.post("/api/pair/options", { token: secret, name: "laptop", code });
    expect([r.status, await r.json()]).toEqual([400, { error: "expired" }]);
    expect(audit()).toContain("PairingTokenWithdrawn");
  });
  it("a Link request it approved can't be collected once it is revoked", async () => {
    const phone = await hub.cookie();
    const req = await json<Request>(hub.post("/api/link", {}));
    expect((await hub.post(`/api/link/${req.requestId}/approve`, { ...identity, code: req.code }, as(phone))).status).toBe(200);
    expect(hub.access.revoke(endpointOf(phone))).toBe(true);
    expect(await json(poll(req.requestId, req.secret))).toEqual({ state: "expired" });
    const r = await hub.post("/api/pair/options", { token: linkTokenSecret(req.secret), name: "laptop" });
    expect((await r.json() as { error?: string }).error).toBe("expired");
  });
});

describe("revoking another device needs a fresh passkey check (whole-branch review L8)", () => {
  it("a device added from another can't revoke the others before its own check, but can sign itself out", async () => {
    const phone = await hub.cookie();
    const { secret, code } = await json<{ secret: string; code: string }>(hub.post("/api/devices/add", {}, as(phone)));
    const laptop = await pairWith(secret, "laptop", code);                                  // verifiedAt 0 (AC12)
    const phoneId = hub.access.authenticate(phone, false)?.endpoint.id ?? "";
    const laptopId = hub.access.authenticate(laptop, false)?.endpoint.id ?? "";
    const r = await hub.post(`/api/devices/${phoneId}/revoke`, {}, as(laptop));
    expect([r.status, await r.json()]).toEqual([403, { error: "step_up" }]);
    expect(hub.access.authenticate(phone, false)).not.toBeNull();                           // the phone is still in
    expect((await hub.post(`/api/devices/${laptopId}/revoke`, {}, as(laptop))).status).toBe(200);   // itself: always
    const other = await hub.cookie();
    expect((await hub.post(`/api/devices/${hub.access.authenticate(other, false)?.endpoint.id ?? ""}/revoke`, {}, as(phone))).status).toBe(200);   // fresh: yes
  });
});

describe("the code is typed, not compared (amendment 11)", () => {
  const ask = () => hub.post("/api/link", {});
  const identity = { fingerprint: "ab".repeat(32), proof: "p".repeat(43) };
  it("link direction: the approver types the new device's code; a wrong one ends the request, a second try is refused, the new device hears why", async () => {
    const phone = await hub.cookie();
    const req = await json<Request>(ask());
    const wrongCode = req.code === "000000" ? "000001" : "000000";
    const none = await hub.post(`/api/link/${req.requestId}/approve`, identity, as(phone));
    expect([none.status, await none.json()]).toEqual([400, { error: "code_needed" }]);     // asked for; the request stays open (L7)
    expect(await json(poll(req.requestId, req.secret))).toEqual({ state: "waiting" });
    const wrong = await hub.post(`/api/link/${req.requestId}/approve`, { ...identity, code: wrongCode }, as(phone));
    expect([wrong.status, await wrong.json()]).toEqual([409, { error: "wrong_code" }]);
    const again = await hub.post(`/api/link/${req.requestId}/approve`, { ...identity, code: req.code }, as(phone));
    expect([again.status, await again.json()]).toEqual([409, { error: "expired" }]);
    expect(await json(poll(req.requestId, req.secret))).toEqual({ state: "mistyped" });
    expect(audit()).toContain("LinkCodeMismatched");
    expect(hub.store.audit().some(a => a.type === "PairingTokenIssued" && (a.body as { issuedBy: { kind: string } }).issuedBy.kind === "endpoint")).toBe(false);   // no token for it
  });
  it("add direction: the new device must type the issuing device's code; the link alone is refused; a wrong code ends the token", async () => {
    const phone = await hub.cookie();
    const { secret, code } = await json<{ secret: string; code: string }>(hub.post("/api/devices/add", {}, as(phone)));
    const bare = await hub.post("/api/pair/options", { token: secret, name: "laptop" });
    expect([bare.status, await bare.json()]).toEqual([400, { error: "code_needed" }]);       // asked, nothing ends
    const wrongCode = code === "000000" ? "000001" : "000000";
    const wrong = await hub.post("/api/pair/options", { token: secret, name: "laptop", code: wrongCode });
    expect([wrong.status, await wrong.json()]).toEqual([400, { error: "wrong_code" }]);
    const second = await hub.post("/api/pair/options", { token: secret, name: "laptop", code });
    expect([second.status, await second.json()]).toEqual([400, { error: "expired" }]);         // no second try on it
    expect(audit()).toContain("PairingTokenCodeMismatched");
  });
  it("add direction: the right code pairs", async () => {
    const phone = await hub.cookie();
    const { secret, code } = await json<{ secret: string; code: string }>(hub.post("/api/devices/add", {}, as(phone)));
    expect(await pairWith(secret, "laptop", code)).not.toBe("");
  });
});
