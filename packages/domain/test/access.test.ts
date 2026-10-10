import { describe, expect, it } from "vitest";
import {
  COMMAND_FRESHNESS_MS, DEFAULT_POLICY, MAX_ACTIVE_ENDPOINTS, POLICY_CHANGE_FRESHNESS_MS, STAY_CHOICES, changePolicy, PAIRING_SESSION_WINDOW_MS, mayCommand, reverifySession, PAIRING_TOKEN_TTL_MS, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS,
  endpointId, formatFingerprint, hubIdentityMatches, issuePairingToken, pairEndpoint, pairingTokenId,
  revokeEndpoint, sessionId, sessionState, startSession, touchSession, grantControl, controlHolds, endControl, mayWatch, CONTROL_FRESHNESS_MS,
  type Endpoint, type PasskeyCredential, type Session,
} from "../src/index.ts";

const T0 = Date.UTC(2026, 8, 30, 20, 0, 0);
const cred = (counter = 0): PasskeyCredential => ({ id: "cred-1", publicKey: new Uint8Array([1, 2, 3]), counter, transports: ["internal"] });
const token = (now = T0) => issuePairingToken({ id: pairingTokenId("tok-1"), secretHash: "h", issuedBy: { kind: "console" }, now }).token;
const pair = (over: Partial<Parameters<typeof pairEndpoint>[0]> = {}) =>
  pairEndpoint({ token: token(), activeEndpoints: 0, id: endpointId("ep-1"), name: "iPhone", credential: cred(), userVerified: true, typedCode: null, now: T0 + 1000, ...over });
const paired = (): Endpoint => {
  const r = pair();
  if (!r.ok) throw new Error(r.error);
  return r.value.endpoint;
};

describe("AC1: an Endpoint pairs only with a live, unused token", () => {
  it("pairs with a fresh token and marks the token used", () => {
    const r = pair();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.token.redeemedBy).toBe("ep-1");
    expect(r.value.events.map(e => e.type)).toEqual(["EndpointPaired"]);
  });
  it("refuses a token at or after its 10-minute expiry (negative control)", () => {
    expect(pair({ now: T0 + PAIRING_TOKEN_TTL_MS })).toEqual({ ok: false, error: "expired" });
    expect(pair({ now: T0 + PAIRING_TOKEN_TTL_MS - 1 }).ok).toBe(true);
  });
  it("refuses a token that already paired a device", () => {
    const first = pair();
    if (!first.ok) throw new Error("setup");
    expect(pair({ token: first.value.token, id: endpointId("ep-2") })).toEqual({ ok: false, error: "used" });
  });
  it("refuses a pairing without user verification", () => {
    expect(pair({ userVerified: false })).toEqual({ ok: false, error: "no_user_verification" });
  });
});

describe("AC2: at most 6 active Endpoints", () => {
  it("allows the sixth and refuses the seventh", () => {
    expect(pair({ activeEndpoints: MAX_ACTIVE_ENDPOINTS - 1 }).ok).toBe(true);
    expect(pair({ activeEndpoints: MAX_ACTIVE_ENDPOINTS })).toEqual({ ok: false, error: "too_many_endpoints" });
  });
});

describe("AC3: a Session needs an active Endpoint, user verification and a counter that didn't go backwards", () => {
  it("starts a session and stores the new counter", () => {
    const r = startSession({ endpoint: paired(), id: sessionId("s-1"), proof: { kind: "assertion", userVerified: true, newCounter: 0 }, now: T0 + 2000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.events.map(e => e.type)).toEqual(["SessionStarted"]);
  });
  it("refuses without user verification", () => {
    expect(startSession({ endpoint: paired(), id: sessionId("s-1"), proof: { kind: "assertion", userVerified: false, newCounter: 0 }, now: T0 })).toEqual({ ok: false, error: "no_user_verification" });
  });
  it("refuses a counter that went backwards or stood still after being non-zero (cloned authenticator)", () => {
    const ep = { ...paired(), credential: cred(5) };
    expect(startSession({ endpoint: ep, id: sessionId("s"), proof: { kind: "assertion", userVerified: true, newCounter: 5 }, now: T0 })).toEqual({ ok: false, error: "counter_regressed" });
    expect(startSession({ endpoint: ep, id: sessionId("s"), proof: { kind: "assertion", userVerified: true, newCounter: 4 }, now: T0 })).toEqual({ ok: false, error: "counter_regressed" });
    expect(startSession({ endpoint: ep, id: sessionId("s"), proof: { kind: "assertion", userVerified: true, newCounter: 6 }, now: T0 }).ok).toBe(true);
  });
  it("accepts counters that stay at zero (synced passkeys report 0)", () => {
    expect(startSession({ endpoint: paired(), id: sessionId("s"), proof: { kind: "assertion", userVerified: true, newCounter: 0 }, now: T0 }).ok).toBe(true);
  });
});

describe("AC3: the pairing itself starts the first session, once, right away", () => {
  const fresh = () => ({ ...paired(), credential: cred(1) });     // real authenticators often report 1 at registration
  it("starts from its own fresh pairing even with a non-zero counter", () => {
    const ep = fresh();
    expect(startSession({ endpoint: ep, id: sessionId("s"), proof: { kind: "pairing", tokenId: ep.pairedWith, issuedBy: { kind: "console" } }, now: ep.pairedAt + 500 }).ok).toBe(true);
  });
  it("refuses another token's pairing, or a pairing older than the window (negative controls)", () => {
    const ep = fresh();
    expect(startSession({ endpoint: ep, id: sessionId("s"), proof: { kind: "pairing", tokenId: pairingTokenId("other"), issuedBy: { kind: "console" } }, now: ep.pairedAt })).toEqual({ ok: false, error: "stale_pairing" });
    expect(startSession({ endpoint: ep, id: sessionId("s"), proof: { kind: "pairing", tokenId: ep.pairedWith, issuedBy: { kind: "console" } }, now: ep.pairedAt + PAIRING_SESSION_WINDOW_MS + 1 })).toEqual({ ok: false, error: "stale_pairing" });
  });
});

describe("AC4: revoking ends the Endpoint's sessions at once, for good", () => {
  it("ends only that Endpoint's sessions and refuses new ones", () => {
    const ep = paired();
    const mine: Session = { id: sessionId("s-1"), endpointId: ep.id, startedAt: T0, lastSeenAt: T0, verifiedAt: T0, endedAt: null, endReason: null };
    const other: Session = { ...mine, id: sessionId("s-2"), endpointId: endpointId("ep-2") };
    const r = revokeEndpoint(ep, [mine, other], T0 + 5000);
    expect(r.endpoint.revokedAt).toBe(T0 + 5000);
    expect(r.sessions.find(s => s.id === "s-1")?.endReason).toBe("revoked");
    expect(r.sessions.find(s => s.id === "s-2")?.endedAt).toBeNull();
    expect(r.events.map(e => e.type)).toEqual(["EndpointRevoked", "SessionEnded"]);
    expect(startSession({ endpoint: r.endpoint, id: sessionId("s-3"), proof: { kind: "assertion", userVerified: true, newCounter: 0 }, now: T0 + 6000 })).toEqual({ ok: false, error: "revoked" });
    expect(revokeEndpoint(r.endpoint, r.sessions, T0 + 7000).events).toEqual([]);
  });
  it("ends the tokens it issued that nobody used yet, and no others (whole-branch review M1)", () => {
    const ep = paired();
    const t = (id: string, issuedBy: Parameters<typeof issuePairingToken>[0]["issuedBy"]) => issuePairingToken({ id: pairingTokenId(id), secretHash: id, issuedBy, now: T0 }).token;
    const mine = t("mine", { kind: "endpoint", endpointId: ep.id });
    const used = { ...t("used", { kind: "endpoint", endpointId: ep.id }), redeemedAt: T0 + 1 };
    const over = { ...t("over", { kind: "endpoint", endpointId: ep.id }), expiresAt: T0 + 2 };
    const others = [t("console", { kind: "console" }), t("theirs", { kind: "endpoint", endpointId: endpointId("ep-2") })];
    const r = revokeEndpoint(ep, [], T0 + 5000, [mine, used, over, ...others]);
    expect(r.tokens).toEqual([{ ...mine, expiresAt: T0 }]);
    expect(r.events).toContainEqual({ type: "PairingTokenWithdrawn", tokenId: "mine", endpointId: ep.id, at: T0 + 5000 });
    expect(pairEndpoint({ token: r.tokens[0]!, activeEndpoints: 1, id: endpointId("ep-9"), name: "x", credential: cred(), userVerified: true, typedCode: null, now: T0 + 5000 })).toEqual({ ok: false, error: "expired" });
  });
});

describe("AC5: sessions expire when idle or too old", () => {
  const s: Session = { id: sessionId("s"), endpointId: endpointId("ep"), startedAt: T0, lastSeenAt: T0, verifiedAt: T0, endedAt: null, endReason: null };
  it("is valid until the idle limit, and touching keeps it valid", () => {
    expect(sessionState(s, T0 + SESSION_IDLE_MS - 1)).toBe("valid");
    expect(sessionState(s, T0 + SESSION_IDLE_MS)).toBe("idle_expired");
    const touched = touchSession(s, T0 + SESSION_IDLE_MS - 1);
    expect(sessionState(touched, T0 + SESSION_IDLE_MS + 1000)).toBe("valid");
  });
  it("expires at the absolute limit however active it is", () => {
    let cur = s;
    for (let t = T0; t < T0 + SESSION_ABSOLUTE_MS; t += SESSION_IDLE_MS / 2) cur = touchSession(cur, t);
    expect(sessionState(cur, T0 + SESSION_ABSOLUTE_MS)).toBe("absolute_expired");
  });
  it("an expired session can't be revived by touching it", () => {
    const expired = touchSession(s, T0 + SESSION_IDLE_MS + 1);
    expect(sessionState(expired, T0 + SESSION_IDLE_MS + 2)).toBe("idle_expired");
  });
});

describe("AC6: the pinned hub identity must match", () => {
  const fp = "a1b2c3d4".repeat(8);
  it("matches however it is formatted", () => {
    expect(hubIdentityMatches(fp, formatFingerprint(fp))).toBe(true);
    expect(formatFingerprint(fp).split(" ")).toHaveLength(16);
  });
  it("any other key is a mismatch (negative control)", () => {
    expect(hubIdentityMatches(fp, "f" + fp.slice(1))).toBe(false);
  });
});

describe("AC7: commands need a recently verified session", () => {
  const s: Session = { id: sessionId("s"), endpointId: endpointId("ep-1"), startedAt: T0, lastSeenAt: T0, verifiedAt: T0, endedAt: null, endReason: null };
  it("allows a command within 10 minutes of verification, not after (negative control)", () => {
    expect(mayCommand(s, T0 + COMMAND_FRESHNESS_MS - 1)).toBe(true);
    expect(mayCommand(s, T0 + COMMAND_FRESHNESS_MS)).toBe(false);
  });
  it("a fresh user-verified assertion from the same device renews it", () => {
    const ep = { ...paired(), credential: cred(3) };
    const later = T0 + COMMAND_FRESHNESS_MS + 5;
    const r = reverifySession({ session: { ...s, lastSeenAt: later - 1 }, endpoint: ep, userVerified: true, newCounter: 4, now: later });
    expect(r.ok).toBe(true);
    if (r.ok) expect(mayCommand(r.value.session, later + 1)).toBe(true);
  });
  it("refuses without user verification, from another device, with a stale counter, or on an ended session", () => {
    const ep = { ...paired(), credential: cred(3) };
    expect(reverifySession({ session: s, endpoint: ep, userVerified: false, newCounter: 4, now: T0 + 1 })).toEqual({ ok: false, error: "no_user_verification" });
    expect(reverifySession({ session: { ...s, endpointId: endpointId("other") }, endpoint: ep, userVerified: true, newCounter: 4, now: T0 + 1 })).toEqual({ ok: false, error: "wrong_device" });
    expect(reverifySession({ session: s, endpoint: ep, userVerified: true, newCounter: 3, now: T0 + 1 })).toEqual({ ok: false, error: "counter_regressed" });
    expect(reverifySession({ session: { ...s, endedAt: T0 }, endpoint: ep, userVerified: true, newCounter: 4, now: T0 + 1 })).toEqual({ ok: false, error: "ended" });
  });
});

describe("AC5, AC7, AC8: the principal chooses the windows; loosening needs a fresh passkey", () => {
  const s: Session = { id: sessionId("s"), endpointId: endpointId("ep"), startedAt: T0, lastSeenAt: T0, verifiedAt: T0, endedAt: null, endReason: null };
  it("the defaults: signed in for 7 days (1 day idle), a passkey check every hour before sending", () => {
    expect(DEFAULT_POLICY).toEqual({ stay: "7d", stepUp: "1h" });
    expect(sessionState(s, T0 + 23 * 3600_000, DEFAULT_POLICY)).toBe("valid");
    expect(sessionState(s, T0 + STAY_CHOICES["7d"].idle, DEFAULT_POLICY)).toBe("idle_expired");
    expect(mayCommand(s, T0 + 59 * 60_000, DEFAULT_POLICY)).toBe(true);
    expect(mayCommand(s, T0 + 60 * 60_000, DEFAULT_POLICY)).toBe(false);
  });
  it("with 'only at sign-in', any valid session may send; an expired one may not (negative control)", () => {
    const p = { stay: "30d", stepUp: "signin" } as const;
    expect(mayCommand({ ...s, lastSeenAt: T0 + 6 * 86_400_000 }, T0 + 6 * 86_400_000 + 1, p)).toBe(true);
    expect(mayCommand(s, T0 + STAY_CHOICES["30d"].idle, p)).toBe(false);
  });
  it("loosening needs a check from the last 5 minutes; tightening never does", () => {
    const later = T0 + POLICY_CHANGE_FRESHNESS_MS;
    expect(changePolicy({ current: DEFAULT_POLICY, next: { stay: "7d", stepUp: "signin" }, session: s, now: later })).toEqual({ ok: false, error: "step_up" });
    expect(changePolicy({ current: DEFAULT_POLICY, next: { stay: "30d", stepUp: "1h" }, session: s, now: later })).toEqual({ ok: false, error: "step_up" });
    const fresh = changePolicy({ current: DEFAULT_POLICY, next: { stay: "7d", stepUp: "signin" }, session: s, now: later - 1 });
    expect(fresh.ok && fresh.value.events.map(e => e.type)).toEqual(["PolicyChanged"]);
    const tighter = changePolicy({ current: DEFAULT_POLICY, next: { stay: "12h", stepUp: "10m" }, session: s, now: T0 + 3 * 3600_000 });
    expect(tighter.ok).toBe(true);
  });
});

describe("AC9: watching needs a valid Session; control is a Command granted per connection", () => {
  const session = (verifiedAt: number): Session => ({ id: sessionId("s-1"), endpointId: endpointId("ep-1"), startedAt: T0, lastSeenAt: T0 + 60_000, verifiedAt, endedAt: null, endReason: null });
  const policy = DEFAULT_POLICY;                                  // step-up within the hour
  const now = T0 + 2 * 60_000;
  it("grants control only with a fresh passkey check, and records the start", () => {
    const r = grantControl(session(T0), { kind: "desktop" }, now, policy);
    expect(r.ok && r.value.events.map(e => e.type)).toEqual(["ControlStarted"]);
    expect(grantControl(session(T0 - 2 * 3_600_000), { kind: "desktop" }, now, policy)).toEqual({ ok: false, error: "step_up" });
  });
  it("starting control needs a passkey check from the last 5 minutes, even when sending needs one only at sign-in", () => {
    const signin = { stay: "30d" as const, stepUp: "signin" as const };
    expect(grantControl(session(T0), { kind: "desktop" }, T0 + CONTROL_FRESHNESS_MS, signin)).toEqual({ ok: false, error: "step_up" });
    expect(grantControl(session(T0), { kind: "desktop" }, T0 + CONTROL_FRESHNESS_MS - 1, signin).ok).toBe(true);
    expect(mayCommand(session(T0), T0 + CONTROL_FRESHNESS_MS, signin)).toBe(true);   // sending is still covered by the sign-in
  });
  it("watching needs only a valid session, even a stale one (negative control: an ended session can't watch)", () => {
    expect(mayWatch(session(T0 - 2 * 3_600_000), now, policy)).toBe(true);
    expect(mayWatch({ ...session(T0), endedAt: T0 + 1, endReason: "signed_out" }, now, policy)).toBe(false);
    expect(grantControl({ ...session(T0), endedAt: T0 + 1, endReason: "signed_out" }, { kind: "desktop" }, now, policy)).toEqual({ ok: false, error: "ended" });
  });
  it("a grant lapses when the passkey check gets stale, and holds only for its own session", () => {
    const s = session(T0);
    const r = grantControl(s, { kind: "terminal", workerId: "%3" }, now, policy);
    if (!r.ok) throw new Error(r.error);
    expect(controlHolds(r.value.grant, s, now + 10 * 60_000, policy)).toBe(true);
    expect(controlHolds(r.value.grant, s, T0 + 3_600_000, policy)).toBe(false);
    expect(controlHolds(r.value.grant, { ...s, id: sessionId("s-2") }, now, policy)).toBe(false);
    expect(endControl(r.value.grant, "lapsed", T0 + 3_600_000)).toMatchObject({ type: "ControlEnded", reason: "lapsed", target: { kind: "terminal", workerId: "%3" } });
  });
});
