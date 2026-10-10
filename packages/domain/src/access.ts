// Access context: which devices speak for the principal (docs/domain.md, "Access"). Modeled on Signal's linked devices.
// Pure: secrets arrive already hashed, passkey checks arrive as facts ("user verified, counter n"), time arrives as `now`.

import { err, ok, type EndpointId, type PairingTokenId, type Result, type SessionId } from "./shared.ts";

export const PAIRING_TOKEN_TTL_MS = 10 * 60_000;        // AC1: Signal's link token also lasts 10 minutes
export const MAX_ACTIVE_ENDPOINTS = 6;                   // AC2: Signal's device cap
export const SESSION_IDLE_MS = 2 * 60 * 60_000;          // AC5, the "12h" choice below
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60_000;     // AC5, the "12h" choice below
export const COMMAND_FRESHNESS_MS = 10 * 60_000;         // AC7, the "10m" choice below

const HOUR = 60 * 60_000, DAY = 24 * HOUR;

// The principal's access policy (AC5, AC7, AC8): how long a sign-in lasts, and how fresh the passkey check before
// sending must be. "signin" means the sign-in's own check is enough.
export const STAY_CHOICES = { "12h": { absolute: 12 * HOUR, idle: 2 * HOUR }, "7d": { absolute: 7 * DAY, idle: DAY }, "30d": { absolute: 30 * DAY, idle: 7 * DAY } } as const;
export const STEP_UP_CHOICES = { "10m": 10 * 60_000, "1h": HOUR, "8h": 8 * HOUR, signin: null } as const;
export type StayChoice = keyof typeof STAY_CHOICES;
export type StepUpChoice = keyof typeof STEP_UP_CHOICES;
export type AccessPolicy = { stay: StayChoice; stepUp: StepUpChoice };
export const DEFAULT_POLICY: AccessPolicy = { stay: "7d", stepUp: "1h" };
export const LONGEST_SESSION_MS = STAY_CHOICES["30d"].absolute;
export const POLICY_CHANGE_FRESHNESS_MS = 5 * 60_000;    // AC8

// Only the tables' own keys: `in` would also accept inherited ones like "constructor" or "toString".
export const isPolicy = (p: unknown): p is AccessPolicy =>
  !!p && typeof p === "object" && Object.hasOwn(STAY_CHOICES, (p as AccessPolicy).stay) && Object.hasOwn(STEP_UP_CHOICES, (p as AccessPolicy).stepUp);

const stepUpWindow = (c: StepUpChoice) => STEP_UP_CHOICES[c] ?? Infinity;

export type Issuer = { kind: "console" } | { kind: "endpoint"; endpointId: EndpointId };

export type PairingToken = {
  id: PairingTokenId;
  secretHash: string;                                    // the secret itself never enters the domain
  issuedBy: Issuer;
  code: string | null;                                   // AC10: six digits the redeeming device must type (amendment 11)
  issuedAt: number;
  expiresAt: number;
  redeemedAt: number | null;
  redeemedBy: EndpointId | null;
};

export type PasskeyCredential = {
  id: string;                                            // credential ID, base64url
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
};

export type Endpoint = {
  id: EndpointId;
  name: string;
  credential: PasskeyCredential;
  pairedAt: number;
  pairedWith: PairingTokenId;
  lastSeenAt: number | null;
  revokedAt: number | null;
};

export type Session = {
  id: SessionId;
  endpointId: EndpointId;
  startedAt: number;
  lastSeenAt: number;
  verifiedAt: number;                                    // last user-verified passkey use (AC7)
  endedAt: number | null;
  endReason: SessionEndReason | null;
};

// "expired": past the limits of the policy in force, stored as ended so a looser policy later can't revive it (AC5).
export type SessionEndReason = "revoked" | "signed_out" | "expired";

export type AccessEvent =
  | { type: "PairingTokenIssued"; tokenId: PairingTokenId; issuedBy: Issuer; at: number }
  | { type: "EndpointPaired"; endpointId: EndpointId; name: string; tokenId: PairingTokenId; issuedBy: Issuer; at: number }
  | { type: "EndpointRevoked"; endpointId: EndpointId; at: number }
  | { type: "SessionStarted"; sessionId: SessionId; endpointId: EndpointId; at: number }
  | { type: "SessionReverified"; sessionId: SessionId; endpointId: EndpointId; at: number }
  | { type: "CommandSent"; sessionId: SessionId; endpointId: EndpointId; workerId: string; length: number; digest: string; attachments?: number; at: number }
  | { type: "PolicyChanged"; endpointId: EndpointId; from: AccessPolicy; to: AccessPolicy; at: number }
  | { type: "SessionEnded"; sessionId: SessionId; endpointId: EndpointId; reason: SessionEndReason; at: number }
  | { type: "ControlStarted"; sessionId: SessionId; endpointId: EndpointId; target: ControlTarget; at: number }
  | { type: "ControlEnded"; sessionId: SessionId; endpointId: EndpointId; target: ControlTarget; reason: "released" | "lapsed"; at: number }
  // ADR-0008 phase E (AC11): a device asked to be added; an Endpoint approved or denied it; it expired unanswered.
  | { type: "LinkRequested"; linkId: string; requester: { login: string | null }; at: number }
  | { type: "LinkApproved"; linkId: string; endpointId: EndpointId; tokenId: PairingTokenId; at: number }
  | { type: "LinkCancelled"; linkId: string; at: number }
  | { type: "LinkCodeMismatched"; linkId: string; endpointId: EndpointId; at: number }
  | { type: "PairingTokenCodeMismatched"; tokenId: PairingTokenId; at: number }
  | { type: "PairingTokenWithdrawn"; tokenId: PairingTokenId; endpointId: EndpointId; at: number }
  | { type: "LinkDenied"; linkId: string; endpointId: EndpointId; at: number }
  | { type: "LinkExpired"; linkId: string; at: number };

export const isActive = (e: Endpoint) => e.revokedAt === null;

export function issuePairingToken(p: { id: PairingTokenId; secretHash: string; issuedBy: Issuer; code?: string | null; now: number }) {
  const token: PairingToken = {
    id: p.id, secretHash: p.secretHash, issuedBy: p.issuedBy, code: p.code ?? null, issuedAt: p.now,
    expiresAt: p.now + PAIRING_TOKEN_TTL_MS, redeemedAt: null, redeemedBy: null,
  };
  const event: AccessEvent = { type: "PairingTokenIssued", tokenId: p.id, issuedBy: p.issuedBy, at: p.now };
  return { token, events: [event] };
}

export type TokenProblem = "expired" | "used";

export function tokenProblem(token: PairingToken, now: number): TokenProblem | null {
  if (token.redeemedAt !== null) return "used";
  if (now >= token.expiresAt) return "expired";
  return null;
}

export type PairingRefusal = TokenProblem | "too_many_endpoints" | "no_user_verification" | "wrong_code";

// AC1, AC2: an Endpoint exists only by redeeming a live, unused token, and only while fewer than 6 are active.
export function pairEndpoint(p: {
  token: PairingToken;
  activeEndpoints: number;
  id: EndpointId;
  name: string;
  credential: PasskeyCredential;
  userVerified: boolean;
  typedCode: string | null;                                // what the new device typed for a token with a code
  now: number;
}): Result<{ endpoint: Endpoint; token: PairingToken; events: AccessEvent[] }, PairingRefusal> {
  const problem = tokenProblem(p.token, p.now);
  if (problem) return err(problem);
  if (p.token.code !== null && p.typedCode !== p.token.code) return err("wrong_code");   // amendment 11: the link alone isn't enough
  if (p.activeEndpoints >= MAX_ACTIVE_ENDPOINTS) return err("too_many_endpoints");
  if (!p.userVerified) return err("no_user_verification");
  const endpoint: Endpoint = {
    id: p.id, name: p.name.trim().slice(0, 40) || "Device", credential: p.credential,
    pairedAt: p.now, pairedWith: p.token.id, lastSeenAt: p.now, revokedAt: null,
  };
  const token: PairingToken = { ...p.token, redeemedAt: p.now, redeemedBy: p.id };
  return ok({ endpoint, token, events: [{ type: "EndpointPaired", endpointId: p.id, name: endpoint.name, tokenId: token.id, issuedBy: token.issuedBy, at: p.now }] });
}

export type SessionRefusal = "revoked" | "no_user_verification" | "counter_regressed" | "stale_pairing";

// WebAuthn §7.2 step 22: if either counter is non-zero, the new one must be greater, or the authenticator may be cloned.
export const counterRegressed = (stored: number, presented: number) => (stored !== 0 || presented !== 0) && presented <= stored;

export const PAIRING_SESSION_WINDOW_MS = 60_000;

// What a Session starts from: a user-verified passkey assertion, or the pairing that just created the Endpoint
// (its registration was already user-verified under AC1, so it counts once, right after pairing). That pairing counts
// toward Commands (AC3) only with a token from the console; one from an Endpoint or a Link request doesn't (AC12): such
// a device verifies before its first Command.
export type SessionProof =
  | { kind: "assertion"; userVerified: boolean; newCounter: number }
  | { kind: "pairing"; tokenId: PairingTokenId; issuedBy: Issuer };

// AC3: a Session starts only for an active Endpoint, from a user-verified assertion whose counter didn't go backwards,
// or from its own fresh pairing.
export function startSession(p: {
  endpoint: Endpoint;
  id: SessionId;
  proof: SessionProof;
  now: number;
}): Result<{ session: Session; endpoint: Endpoint; events: AccessEvent[] }, SessionRefusal> {
  if (!isActive(p.endpoint)) return err("revoked");
  let endpoint: Endpoint = { ...p.endpoint, lastSeenAt: p.now };
  if (p.proof.kind === "assertion") {
    if (!p.proof.userVerified) return err("no_user_verification");
    if (counterRegressed(p.endpoint.credential.counter, p.proof.newCounter)) return err("counter_regressed");
    endpoint = { ...endpoint, credential: { ...p.endpoint.credential, counter: p.proof.newCounter } };
  } else if (p.proof.tokenId !== p.endpoint.pairedWith || p.now - p.endpoint.pairedAt > PAIRING_SESSION_WINDOW_MS) {
    return err("stale_pairing");
  }
  // verifiedAt 0: no user verification yet counts for Commands (AC12).
  const verifiedAt = p.proof.kind === "pairing" && p.proof.issuedBy.kind !== "console" ? 0 : p.now;
  const session: Session = { id: p.id, endpointId: p.endpoint.id, startedAt: p.now, lastSeenAt: p.now, verifiedAt, endedAt: null, endReason: null };
  return ok({ session, endpoint, events: [{ type: "SessionStarted", sessionId: p.id, endpointId: p.endpoint.id, at: p.now }] });
}

// AC7 step-up: a fresh user-verified assertion from the same Endpoint renews the Session's verification.
export function reverifySession(p: {
  session: Session;
  endpoint: Endpoint;
  userVerified: boolean;
  newCounter: number;
  now: number;
  policy?: AccessPolicy;
}): Result<{ session: Session; endpoint: Endpoint; events: AccessEvent[] }, SessionRefusal | "ended" | "wrong_device"> {
  if (sessionState(p.session, p.now, p.policy) !== "valid") return err("ended");
  if (p.session.endpointId !== p.endpoint.id) return err("wrong_device");
  if (!isActive(p.endpoint)) return err("revoked");
  if (!p.userVerified) return err("no_user_verification");
  if (counterRegressed(p.endpoint.credential.counter, p.newCounter)) return err("counter_regressed");
  return ok({
    session: { ...p.session, verifiedAt: p.now, lastSeenAt: p.now },
    endpoint: { ...p.endpoint, lastSeenAt: p.now, credential: { ...p.endpoint.credential, counter: p.newCounter } },
    events: [{ type: "SessionReverified", sessionId: p.session.id, endpointId: p.endpoint.id, at: p.now }],
  });
}

// AC7: sending into a worker needs a valid Session whose passkey check is fresher than the policy's step-up window
// (with "signin", the sign-in's own check is enough). Without a policy: the strictest choice, 10 minutes.
// A Session that never verified for Commands (verifiedAt 0, AC12) may not send, whatever the policy.
export const mayCommand = (s: Session, now: number, policy: AccessPolicy = { stay: "12h", stepUp: "10m" }) =>
  sessionState(s, now, policy) === "valid" && s.verifiedAt > 0 && now - s.verifiedAt < stepUpWindow(policy.stepUp);

// AC9: watching a worker's terminal or the office's desktop needs a valid Session. Controlling one (keys, pointer,
// clipboard) is a Command, granted per connection only when the principal asks for it. Starting it needs a passkey
// check from the last 5 minutes whatever the step-up policy (the owner chose "control after passkey"; even "only when
// I sign in" doesn't waive it); it then holds while mayCommand holds and lapses when it stops. Starting and ending
// control are recorded; the input never is.
export const CONTROL_FRESHNESS_MS = 5 * 60_000;
export type ControlTarget = { kind: "terminal"; workerId: string } | { kind: "desktop" };
export type ControlGrant = { target: ControlTarget; sessionId: SessionId; endpointId: EndpointId; grantedAt: number };

export const mayWatch = (s: Session, now: number, policy: AccessPolicy) => sessionState(s, now, policy) === "valid";

export function grantControl(s: Session, target: ControlTarget, now: number, policy: AccessPolicy): Result<{ grant: ControlGrant; events: AccessEvent[] }, "step_up" | "ended"> {
  if (!mayWatch(s, now, policy)) return err("ended");
  if (!mayCommand(s, now, policy) || now - s.verifiedAt >= CONTROL_FRESHNESS_MS) return err("step_up");
  const grant: ControlGrant = { target, sessionId: s.id, endpointId: s.endpointId, grantedAt: now };
  return ok({ grant, events: [{ type: "ControlStarted", sessionId: s.id, endpointId: s.endpointId, target, at: now }] });
}

// Whether a grant still holds for this Session now; the hub ends the control (ControlEnded "lapsed") when it doesn't.
export const controlHolds = (g: ControlGrant, s: Session, now: number, policy: AccessPolicy) =>
  g.sessionId === s.id && mayCommand(s, now, policy);

export const endControl = (g: ControlGrant, reason: "released" | "lapsed", now: number): AccessEvent =>
  ({ type: "ControlEnded", sessionId: g.sessionId, endpointId: g.endpointId, target: g.target, reason, at: now });

// AC8: loosening the policy (a longer sign-in or a wider step-up window) needs a passkey check from the last 5 minutes;
// tightening it never does, so a principal can always make things stricter.
export function changePolicy(p: { current: AccessPolicy; next: AccessPolicy; session: Session; now: number }): Result<{ policy: AccessPolicy; events: AccessEvent[] }, "step_up" | "ended"> {
  if (sessionState(p.session, p.now, p.current) !== "valid") return err("ended");
  const looser = STAY_CHOICES[p.next.stay].absolute > STAY_CHOICES[p.current.stay].absolute
    || stepUpWindow(p.next.stepUp) > stepUpWindow(p.current.stepUp);
  if (looser && p.now - p.session.verifiedAt >= POLICY_CHANGE_FRESHNESS_MS) return err("step_up");
  if (p.next.stay === p.current.stay && p.next.stepUp === p.current.stepUp) return ok({ policy: p.current, events: [] });
  return ok({ policy: p.next, events: [{ type: "PolicyChanged", endpointId: p.session.endpointId, from: p.current, to: p.next, at: p.now }] });
}

export type SessionState = "valid" | "ended" | "idle_expired" | "absolute_expired";

// AC5: idle and absolute limits from the policy; an ended Session stays ended.
export function sessionState(s: Session, now: number, policy: AccessPolicy = { ...DEFAULT_POLICY, stay: "12h" }): SessionState {
  const limits = STAY_CHOICES[policy.stay];
  if (s.endedAt !== null) return "ended";
  if (now - s.startedAt >= limits.absolute) return "absolute_expired";
  if (now - s.lastSeenAt >= limits.idle) return "idle_expired";
  return "valid";
}

export const touchSession = (s: Session, now: number, policy?: AccessPolicy): Session =>
  (sessionState(s, now, policy) === "valid" ? { ...s, lastSeenAt: now } : s);

export function endSession(s: Session, reason: SessionEndReason, now: number) {
  if (s.endedAt !== null) return { session: s, events: [] as AccessEvent[] };
  const session: Session = { ...s, endedAt: now, endReason: reason };
  return { session, events: [{ type: "SessionEnded", sessionId: s.id, endpointId: s.endpointId, reason, at: now }] as AccessEvent[] };
}

// AC5: a Session past the policy's limits is over for good. The hub ends these before any policy change applies, so
// loosening the policy later extends only live Sessions and never revives one that already expired.
export function endExpiredSessions(sessions: Session[], now: number, policy: AccessPolicy) {
  const ended: Session[] = [];
  const events: AccessEvent[] = [];
  for (const s of sessions) {
    const state = sessionState(s, now, policy);
    if (state !== "idle_expired" && state !== "absolute_expired") continue;
    const r = endSession(s, "expired", now);
    ended.push(r.session);
    events.push(...r.events);
  }
  return { sessions: ended, events };
}

// AC4: revoking ends every Session of the Endpoint at once; a revoked Endpoint stays revoked.
// Revoking also ends the pairing tokens it issued and nobody used yet: its "Add a device" links and the tokens of Link
// requests it approved (whole-branch review M1), so a lost or phished device can't still add one after it is cut off.
export function revokeEndpoint(endpoint: Endpoint, sessions: Session[], now: number, tokens: PairingToken[] = []) {
  if (!isActive(endpoint)) return { endpoint, sessions, tokens: [] as PairingToken[], events: [] as AccessEvent[] };
  const events: AccessEvent[] = [{ type: "EndpointRevoked", endpointId: endpoint.id, at: now }];
  const ended = sessions.map(s => {
    if (s.endpointId !== endpoint.id) return s;
    const r = endSession(s, "revoked", now);
    events.push(...r.events);
    return r.session;
  });
  const issued = tokens.filter(t => t.issuedBy.kind === "endpoint" && t.issuedBy.endpointId === endpoint.id && t.redeemedAt === null && now < t.expiresAt);
  for (const t of issued) events.push({ type: "PairingTokenWithdrawn", tokenId: t.id, endpointId: endpoint.id, at: now });
  return { endpoint: { ...endpoint, revokedAt: now }, sessions: ended, tokens: issued.map(t => ({ ...t, expiresAt: t.issuedAt })), events };
}

// AC6: the Endpoint pins the hub's identity at pairing; any other identity later is a hard stop.
export const hubIdentityMatches = (pinnedFingerprint: string, presentedFingerprint: string) =>
  normalizeFingerprint(pinnedFingerprint) === normalizeFingerprint(presentedFingerprint);

const normalizeFingerprint = (f: string) => f.replace(/[^0-9a-f]/gi, "").toLowerCase();

// Shown on both sides at pairing, like a safety number: 64 hex digits in groups of four.
export const formatFingerprint = (hex: string) => (normalizeFingerprint(hex).match(/.{1,4}/g) ?? []).join(" ");
