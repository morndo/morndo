// Adding a device from a signed-in one (ADR-0008 phase E; AC10–AC13 in docs/domain.md): a pairing token issued from an
// Endpoint needs a fresh user verification and carries a code; a Link request lives 10 minutes, at most 3 are open,
// is answered once, and only its own secret collects its token; a device paired this way starts with no step-up
// credit. Pure: secrets arrive hashed, time as `now`.
import { describe, expect, it } from "vitest";
import {
  LINK_TTL_MS, MAX_OPEN_LINKS, cancelLink, matchTokenCode, collectLink, decideLink, endpointId, expireLink, issueFromEndpoint, issuePairingToken, mayCommand,
  mayIssueFromEndpoint, openLinkRequest, pairEndpoint, pairingTokenId, sessionId, startSession, withdrawToken, type Endpoint, type LinkRequest, type Session,
} from "../src/index.ts";

const NOW = 1_000_000_000;
const session = (verifiedAt: number): Session => ({ id: sessionId("s1"), endpointId: endpointId("e1"), startedAt: NOW - 3_600_000, lastSeenAt: NOW, verifiedAt, endedAt: null, endReason: null });
const policy = { stay: "7d", stepUp: "1h" } as const;
const open = (n: number, at = NOW): LinkRequest[] => Array.from({ length: n }, (_, i) => ({
  id: `l${i}`, secretHash: `h${i}`, tokenSecretHash: `th${i}`, code: "123456", createdAt: at, expiresAt: at + LINK_TTL_MS, state: "open",
  requester: { login: null }, tokenId: null, decidedBy: null,
}));
const first = () => { const [r] = open(1); if (!r) throw new Error(); return r; };
const opening = (o: Partial<Parameters<typeof openLinkRequest>[0]> = {}) =>
  openLinkRequest({ id: "l9", secretHash: "h9", tokenSecretHash: "th9", code: "424242", open: [], requester: { login: null }, now: NOW, ...o });

describe("issuing a pairing token from an Endpoint (AC10)", () => {
  it("needs a user verification from the last 5 minutes, whatever the step-up policy", () => {
    expect(mayIssueFromEndpoint(session(NOW - 4 * 60_000), NOW, policy)).toBe(true);
    expect(mayIssueFromEndpoint(session(NOW - 6 * 60_000), NOW, policy)).toBe(false);
    expect(mayIssueFromEndpoint(session(NOW - 6 * 60_000), NOW, { stay: "7d", stepUp: "signin" })).toBe(false);
    expect(mayIssueFromEndpoint(session(0), NOW, { stay: "7d", stepUp: "signin" })).toBe(false);
  });
  it("records this Endpoint as the issuer and carries the 6-digit code", () => {
    const r = issueFromEndpoint({ id: pairingTokenId("t1"), secretHash: "s", code: "070707", issuer: session(NOW - 60_000), activeEndpoints: 1, now: NOW, policy });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.token).toMatchObject({ issuedBy: { kind: "endpoint", endpointId: "e1" }, code: "070707", expiresAt: NOW + 10 * 60_000 });
    expect(r.value.events).toEqual([{ type: "PairingTokenIssued", tokenId: "t1", issuedBy: { kind: "endpoint", endpointId: "e1" }, at: NOW }]);
  });
  it("is refused without a fresh verification, from an ended session, or without a proper code", () => {
    const base = { id: pairingTokenId("t1"), secretHash: "s", code: "070707", activeEndpoints: 1, now: NOW, policy };
    expect(issueFromEndpoint({ ...base, issuer: session(NOW - 6 * 60_000) })).toEqual({ ok: false, error: "step_up" });
    expect(issueFromEndpoint({ ...base, issuer: { ...session(NOW), endedAt: NOW - 1, endReason: "signed_out" } })).toEqual({ ok: false, error: "ended" });
    expect(issueFromEndpoint({ ...base, code: "12345", issuer: session(NOW) })).toEqual({ ok: false, error: "step_up" });
  });
  it("6 devices active is said before any passkey check: a stale verification still hears too_many_endpoints", () => {
    expect(issueFromEndpoint({ id: pairingTokenId("t1"), secretHash: "s", code: "070707", issuer: session(NOW - 60 * 60_000), activeEndpoints: 6, now: NOW, policy })).toEqual({ ok: false, error: "too_many_endpoints" });
  });
  it("not while 6 devices are active (AC2), from \"Add a device\" or an approval", () => {
    expect(issueFromEndpoint({ id: pairingTokenId("t1"), secretHash: "s", code: "070707", issuer: session(NOW), activeEndpoints: 6, now: NOW, policy })).toEqual({ ok: false, error: "too_many_endpoints" });
    expect(decideLink({ request: first(), approver: session(NOW), approve: true, typedCode: "123456", activeEndpoints: 6, tokenId: pairingTokenId("t1"), now: NOW, policy })).toEqual({ ok: false, error: "too_many_endpoints" });
    expect(decideLink({ request: first(), approver: session(NOW), approve: false, typedCode: null, activeEndpoints: 6, tokenId: pairingTokenId("t1"), now: NOW, policy }).ok).toBe(true);
  });
  it("a console token has no code", () => {
    expect(issuePairingToken({ id: pairingTokenId("t"), secretHash: "s", issuedBy: { kind: "console" }, now: NOW }).token.code).toBeNull();
  });
});

describe("Link requests (AC11)", () => {
  it("opens with a 10-minute life, its code and who asked", () => {
    const r = opening({ requester: { login: "someone@example.test" } });
    expect(r.ok && r.value.request).toMatchObject({ state: "open", expiresAt: NOW + LINK_TTL_MS, code: "424242", requester: { login: "someone@example.test" } });
    expect(r.ok && r.value.events).toEqual([{ type: "LinkRequested", linkId: "l9", requester: { login: "someone@example.test" }, at: NOW }]);   // the trail outlives the row (L2)
  });
  it("at most 3 open at once; expired and answered ones don't count", () => {
    expect(opening({ open: open(MAX_OPEN_LINKS) })).toEqual({ ok: false, error: "too_many" });
    expect(opening({ open: open(MAX_OPEN_LINKS, NOW - LINK_TTL_MS) }).ok).toBe(true);
    expect(opening({ open: open(MAX_OPEN_LINKS).map(r => ({ ...r, state: "denied" as const })) }).ok).toBe(true);
  });
  it("is approved once, by a fresh user verification, issuing one token for the requester's derived secret with the code", () => {
    const req = first();
    expect(decideLink({ request: req, approver: session(NOW - 6 * 60_000), approve: true, typedCode: "123456", activeEndpoints: 1, tokenId: pairingTokenId("t1"), now: NOW, policy })).toEqual({ ok: false, error: "step_up" });
    const ok = decideLink({ request: req, approver: session(NOW - 60_000), approve: true, typedCode: "123456", activeEndpoints: 1, tokenId: pairingTokenId("t1"), now: NOW, policy });
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.value.request).toMatchObject({ state: "approved", tokenId: "t1", decidedBy: "e1" });
    expect(ok.value.token).toMatchObject({ id: "t1", secretHash: "th0", code: null, issuedBy: { kind: "endpoint", endpointId: "e1" } });   // typed already
    expect(ok.value.outcome).toBe("approved");
    expect(ok.value.events.map(e => e.type)).toEqual(["LinkApproved", "PairingTokenIssued"]);
    expect(ok.value.events[0]).toMatchObject({ tokenId: "t1" });                     // which token it bound (L2)
    expect(decideLink({ request: ok.value.request, approver: session(NOW), approve: false, typedCode: null, activeEndpoints: 1, tokenId: pairingTokenId("t2"), now: NOW, policy })).toEqual({ ok: false, error: "decided" });
  });
  it("can be denied without a fresh verification, and then yields nothing", () => {
    const d = decideLink({ request: first(), approver: session(NOW - 50 * 60_000), approve: false, typedCode: null, activeEndpoints: 1, tokenId: pairingTokenId("t1"), now: NOW, policy });
    if (!d.ok) throw new Error(d.error);
    expect(d.value.request.state).toBe("denied");
    expect(d.value.token).toBeNull();
    expect(d.value.events).toEqual([{ type: "LinkDenied", linkId: "l0", endpointId: "e1", at: NOW }]);
    expect(collectLink({ request: d.value.request, secretHash: "h0", now: NOW })).toEqual({ ok: false, error: "denied" });
  });
  it("an ended session can't answer at all", () => {
    expect(decideLink({ request: first(), approver: { ...session(NOW), endedAt: NOW - 1, endReason: "revoked" }, approve: false, typedCode: null, activeEndpoints: 1, tokenId: pairingTokenId("t"), now: NOW, policy })).toEqual({ ok: false, error: "ended" });
  });
  it("expires: neither answered nor collected after 10 minutes, and ends as expired once", () => {
    const req = first();
    const later = NOW + LINK_TTL_MS;
    expect(decideLink({ request: req, approver: { ...session(later), lastSeenAt: later }, approve: true, typedCode: "123456", activeEndpoints: 1, tokenId: pairingTokenId("t"), now: later, policy })).toEqual({ ok: false, error: "expired" });
    expect(collectLink({ request: req, secretHash: "h0", now: later })).toEqual({ ok: false, error: "expired" });
    expect(expireLink(req, later - 1)).toBeNull();
    const x = expireLink(req, later);
    expect(x?.request.state).toBe("expired");
    expect(x?.events).toEqual([{ type: "LinkExpired", linkId: "l0", at: later }]);
    if (!x) throw new Error();
    expect(expireLink(x.request, later + 1)).toBeNull();
    expect(decideLink({ request: x.request, approver: session(NOW), approve: false, typedCode: null, activeEndpoints: 1, tokenId: pairingTokenId("t"), now: NOW, policy })).toEqual({ ok: false, error: "expired" });
  });
  it("only the requester's own secret collects the token; asking again gives it again", () => {
    const req = first();
    const a = decideLink({ request: req, approver: session(NOW), approve: true, typedCode: "123456", activeEndpoints: 1, tokenId: pairingTokenId("t1"), now: NOW, policy });
    if (!a.ok) throw new Error(a.error);
    expect(collectLink({ request: a.value.request, secretHash: "wrong", now: NOW })).toEqual({ ok: false, error: "wrong_secret" });
    expect(collectLink({ request: req, secretHash: "wrong", now: NOW })).toEqual({ ok: false, error: "wrong_secret" });
    expect(collectLink({ request: req, secretHash: "h0", now: NOW })).toEqual({ ok: false, error: "waiting" });
    expect(collectLink({ request: a.value.request, secretHash: "h0", now: NOW })).toEqual({ ok: true, value: { tokenId: "t1" } });
    expect(collectLink({ request: a.value.request, secretHash: "h0", now: NOW + 1 })).toEqual({ ok: true, value: { tokenId: "t1" } });
  });
});

describe("an approval in the request's last seconds (review L1)", () => {
  it("is still collected after the request's 10 minutes: the token's own life counts from then on", () => {
    const req = first();
    const a = decideLink({ request: req, approver: session(NOW + LINK_TTL_MS - 1000), approve: true, typedCode: "123456", activeEndpoints: 1, tokenId: pairingTokenId("t1"), now: NOW + LINK_TTL_MS - 1000, policy });
    if (!a.ok) throw new Error(a.error);
    expect(collectLink({ request: a.value.request, secretHash: "h0", now: NOW + LINK_TTL_MS + 1000 })).toEqual({ ok: true, value: { tokenId: "t1" } });
    expect(expireLink(a.value.request, NOW + LINK_TTL_MS + 1000)).toBeNull();          // an answered request doesn't expire
  });
});

describe("Cancel (review L6)", () => {
  it("the requester's own secret ends a waiting request and frees its place; nothing else does", () => {
    const req = first();
    expect(cancelLink({ request: req, secretHash: "wrong", now: NOW })).toEqual({ ok: false, error: "wrong_secret" });
    const c = cancelLink({ request: req, secretHash: "h0", now: NOW });
    if (!c.ok) throw new Error(c.error);
    expect(c.value.request.state).toBe("cancelled");
    expect(c.value.events).toEqual([{ type: "LinkCancelled", linkId: "l0", at: NOW }]);
    expect(cancelLink({ request: c.value.request, secretHash: "h0", now: NOW })).toEqual({ ok: false, error: "ended" });
    expect(openLinkRequest({ id: "x", secretHash: "h", tokenSecretHash: "th", code: "123456", open: [c.value.request, ...open(2).slice(0, 2)], requester: { login: null }, now: NOW }).ok).toBe(true);
    expect(decideLink({ request: c.value.request, approver: session(NOW), approve: true, typedCode: "123456", activeEndpoints: 1, tokenId: pairingTokenId("t"), now: NOW, policy })).toEqual({ ok: false, error: "expired" });
    expect(collectLink({ request: c.value.request, secretHash: "h0", now: NOW })).toEqual({ ok: false, error: "cancelled" });
  });
  it("the issuing device withdraws its token: it can't be redeemed any more; no other device can", () => {
    const t = issueFromEndpoint({ id: pairingTokenId("t1"), secretHash: "s", code: "070707", issuer: session(NOW), activeEndpoints: 1, now: NOW, policy });
    if (!t.ok) throw new Error(t.error);
    expect(withdrawToken(t.value.token, endpointId("e9"), NOW)).toEqual({ ok: false, error: "not_yours" });
    const w = withdrawToken(t.value.token, endpointId("e1"), NOW + 1000);
    if (!w.ok) throw new Error(w.error);
    expect(w.value.events).toEqual([{ type: "PairingTokenWithdrawn", tokenId: "t1", endpointId: "e1", at: NOW + 1000 }]);
    expect(w.value.token.expiresAt).toBe(NOW);                   // as of its issue (review L1)
    expect(withdrawToken(w.value.token, endpointId("e1"), NOW + 500)).toEqual({ ok: false, error: "ended" });
    const credential = { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] };
    expect(pairEndpoint({ token: w.value.token, activeEndpoints: 1, id: endpointId("e2"), name: "x", credential, userVerified: true, typedCode: "070707", now: NOW + 1000 })).toEqual({ ok: false, error: "expired" });
    expect(withdrawToken(issuePairingToken({ id: pairingTokenId("c1"), secretHash: "s", issuedBy: { kind: "console" }, now: NOW }).token, endpointId("e1"), NOW)).toEqual({ ok: false, error: "not_yours" });
  });
});

describe("no step-up credit for a device added from another (AC12)", () => {
  const endpoint = (pairedWith: string): Endpoint => ({ id: endpointId("e2"), name: "laptop", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: NOW, pairedWith: pairingTokenId(pairedWith), lastSeenAt: NOW, revokedAt: null });
  it("a session from a pairing with an Endpoint's token can't send until it verifies, even under 'only at sign-in'", () => {
    const r = startSession({ endpoint: endpoint("t1"), id: sessionId("s2"), proof: { kind: "pairing", tokenId: pairingTokenId("t1"), issuedBy: { kind: "endpoint", endpointId: endpointId("e1") } }, now: NOW });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.session.verifiedAt).toBe(0);
    expect(mayCommand(r.value.session, NOW, policy)).toBe(false);
    expect(mayCommand(r.value.session, NOW, { stay: "7d", stepUp: "signin" })).toBe(false);
  });
  it("console pairing keeps its credit (AC3)", () => {
    const r = startSession({ endpoint: endpoint("t1"), id: sessionId("s2"), proof: { kind: "pairing", tokenId: pairingTokenId("t1"), issuedBy: { kind: "console" } }, now: NOW });
    if (!r.ok) throw new Error(r.error);
    expect(mayCommand(r.value.session, NOW, policy)).toBe(true);
  });
  it("the pairing event says who issued the token, so the hub can tell every device (AC13)", () => {
    const token = issueFromEndpoint({ id: pairingTokenId("t1"), secretHash: "s", code: "070707", issuer: session(NOW), activeEndpoints: 1, now: NOW, policy });
    if (!token.ok) throw new Error(token.error);
    const credential = { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] };
    const p = pairEndpoint({ token: token.value.token, activeEndpoints: 1, id: endpointId("e2"), name: "laptop", credential, userVerified: true, typedCode: "070707", now: NOW });
    if (!p.ok) throw new Error(p.error);
    expect(p.value.events[0]).toMatchObject({ type: "EndpointPaired", issuedBy: { kind: "endpoint", endpointId: "e1" } });
  });
});

describe("the code is typed, not compared (amendment 11)", () => {
  it("link direction: the approver types the new device's code; a wrong one ends the request at once, before any passkey check", () => {
    const req = first();
    const wrong = decideLink({ request: req, approver: session(NOW - 60 * 60_000), approve: true, typedCode: "654321", activeEndpoints: 1, tokenId: pairingTokenId("t1"), now: NOW, policy });
    if (!wrong.ok) throw new Error(wrong.error);
    expect(wrong.value.outcome).toBe("mistyped");
    expect(wrong.value.token).toBeNull();
    expect(wrong.value.events).toEqual([{ type: "LinkCodeMismatched", linkId: "l0", endpointId: "e1", at: NOW }]);
    // No second try on it, even with the right code and a fresh check; the new device hears why.
    expect(decideLink({ request: wrong.value.request, approver: session(NOW), approve: true, typedCode: "123456", activeEndpoints: 1, tokenId: pairingTokenId("t2"), now: NOW, policy })).toEqual({ ok: false, error: "expired" });
    expect(collectLink({ request: wrong.value.request, secretHash: "h0", now: NOW })).toEqual({ ok: false, error: "mistyped" });
    // No code at all is asked for, not a wrong one: the request stays open (review L7).
    expect(decideLink({ request: req, approver: session(NOW), approve: true, typedCode: null, activeEndpoints: 1, tokenId: pairingTokenId("t3"), now: NOW, policy })).toEqual({ ok: false, error: "code_needed" });
    expect(decideLink({ request: req, approver: session(NOW), approve: true, typedCode: "", activeEndpoints: 1, tokenId: pairingTokenId("t3"), now: NOW, policy })).toEqual({ ok: false, error: "code_needed" });
    expect(req.state).toBe("open");
  });
  it("add direction: the new device types the issuing device's code; none is asked again, a wrong one ends the token", () => {
    const t = issueFromEndpoint({ id: pairingTokenId("t1"), secretHash: "s", code: "070707", issuer: session(NOW), activeEndpoints: 1, now: NOW, policy });
    if (!t.ok) throw new Error(t.error);
    expect(matchTokenCode(t.value.token, "070707", NOW)).toEqual({ matched: true });
    expect(matchTokenCode(t.value.token, null, NOW)).toEqual({ matched: false, reason: "code_needed" });
    const wrong = matchTokenCode(t.value.token, "070708", NOW + 1000);
    if (wrong.matched || wrong.reason !== "wrong_code") throw new Error("not refused");
    expect(wrong.events).toEqual([{ type: "PairingTokenCodeMismatched", tokenId: "t1", at: NOW + 1000 }]);
    expect(wrong.token.expiresAt).toBe(NOW);                     // ended as of its issue: a clock stepping back can't revive it (L1)
    const credential = { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] };
    const pair = (token: typeof wrong.token, typedCode: string | null) => pairEndpoint({ token, activeEndpoints: 1, id: endpointId("e2"), name: "x", credential, userVerified: true, typedCode, now: NOW + 1000 });
    expect(pair(wrong.token, "070707")).toEqual({ ok: false, error: "expired" });                  // no second try on it
    expect(pair(t.value.token, null)).toEqual({ ok: false, error: "wrong_code" });                 // the link alone isn't enough
    expect(pair(t.value.token, "070707").ok).toBe(true);
    const console = issuePairingToken({ id: pairingTokenId("c1"), secretHash: "s", issuedBy: { kind: "console" }, now: NOW }).token;
    expect(matchTokenCode(console, null, NOW)).toEqual({ matched: true });                         // the console's has none
  });
});

