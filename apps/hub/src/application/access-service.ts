// Application service for the Access context: orchestrates the domain, the store and the passkey adapter.
import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import {
  DEFAULT_POLICY, MAX_ACTIVE_ENDPOINTS, cancelLink, changePolicy, collectLink, decideLink, endExpiredSessions, endSession, expireLink, isPolicy, endpointId, isActive,
  issueFromEndpoint, issuePairingToken, matchTokenCode, mayCommand, openLinkRequest, pairEndpoint, pairingTokenId, reverifySession, revokeEndpoint, sessionId, sessionState, startSession,
  tokenProblem, touchSession, withdrawToken, type Issuer,
  type AccessPolicy, type Endpoint, type LinkRequest, type PairingRefusal, type Session, type SessionRefusal, type TokenProblem,
} from "@morndo/domain";
import type { Store } from "../adapters/store.ts";
import type { Passkeys } from "../adapters/passkeys.ts";
import type { RevocationJournal } from "@morndo/service-kit";
import { log } from "../adapters/log.ts";

const FLOW_TTL_MS = 5 * 60_000;
const TOUCH_WRITE_EVERY_MS = 60_000;                   // persist lastSeenAt at most once a minute per session

export const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");
const newSecret = () => randomBytes(32).toString("base64url");
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");       // AC10, AC11: six digits on both screens
// The pairing secret a Link request's requester gets once an Endpoint approved it, derived from the requester's own
// secret: the hub keeps only hashes of both, so nothing it stores redeems the token (ADR-0008 phase E).
export const linkTokenSecret = (secret: string) => createHmac("sha256", secret).update("morndo-link-token").digest("base64url");

// What the approving screen sees of a request: not its code, which it must type (amendment 11).
export type LinkView = { createdAt: number; expiresAt: number; requester: { login: string | null }; state: LinkRequest["state"] };
export type Collected = { state: "waiting" | "denied" | "expired" | "cancelled" | "mistyped" } | { state: "approved"; token: string; fingerprint: string | null; proof: string | null };
// AC13: a device added from another (`by`, that one's name), told to every device until each has seen it.
export type Linked = { name: string; at: number; by: string | null };
const LINKED_SHOWN_MS = 7 * 24 * 3_600_000;           // a device that stays away longer hears of it on the Devices page

type Flow =
  | { kind: "pair"; challenge: string; tokenId: string; secretHash: string; deviceName: string; typedCode: string | null; expires: number }
  | { kind: "login"; challenge: string; expires: number }
  | { kind: "stepup"; challenge: string; sessionId: string; expires: number };

export type Authenticated = { session: Session; endpoint: Endpoint };

export class AccessService {
  #store: Store;
  #passkeys: Passkeys;
  #now: () => number;
  #journal: RevocationJournal | null;
  #flows = new Map<string, Flow>();
  #onRevoked: (endpointId: string) => void = () => {};
  #onLinked = new Set<(e: Linked) => void>();

  constructor(store: Store, pk: Passkeys, now: () => number = Date.now, journal?: RevocationJournal) {
    this.#store = store;
    this.#passkeys = pk;
    this.#now = now;
    this.#journal = journal ?? null;
  }

  onRevoked(fn: (endpointId: string) => void) { this.#onRevoked = fn; }
  // AC13: a device was added from an Endpoint or a Link request; every active Endpoint is told.
  onLinked(fn: (e: Linked) => void) { this.#onLinked.add(fn); }
  #told(e: Linked) {
    for (const fn of this.#onLinked) {
      try { fn(e); } catch (err) { log.error("telling the devices a device was added failed", err); }   // the pairing stands
    }
  }
  #nameOf = (issuer: Issuer) => (issuer.kind === "endpoint" ? this.#store.endpoint(issuer.endpointId)?.name ?? null : null);

  // AC13 for a device that wasn't open then: the additions since its own pairing that it hasn't seen yet, oldest first.
  unseenLinks(endpointId: string): Linked[] {
    const self = this.#store.endpoint(endpointId);
    if (!self) return [];
    const seen = this.#store.setting<number>(`linked_seen:${endpointId}`) ?? 0;
    const since = Math.max(seen, self.pairedAt, this.#now() - LINKED_SHOWN_MS);
    return this.#store.auditOf("EndpointPaired", since).flatMap(e => {
      if (e.type !== "EndpointPaired" || e.issuedBy.kind !== "endpoint" || e.endpointId === endpointId || e.at <= since) return [];
      return [{ name: e.name, at: e.at, by: this.#nameOf(e.issuedBy) }];
    });
  }
  // Dismissed or reviewed on that device: up to `at`, it has seen them.
  seeLinks(endpointId: string, at: number) {
    const seen = this.#store.setting<number>(`linked_seen:${endpointId}`) ?? 0;
    if (at > seen) this.#store.saveSetting(`linked_seen:${endpointId}`, Math.min(at, this.#now()));
  }

  // The principal's access policy (AC5, AC7, AC8), kept in the hub so no browser can relax it on its own.
  policy(): AccessPolicy {
    const p = this.#store.setting<AccessPolicy>("access_policy");
    return isPolicy(p) ? p : DEFAULT_POLICY;
  }

  setPolicy(a: Authenticated, next: AccessPolicy): { policy: AccessPolicy } | { refused: "step_up" | "ended" | "invalid" } {
    if (!isPolicy(next)) return { refused: "invalid" };
    const session = this.#store.session(a.session.id);
    if (!session) return { refused: "ended" };
    const now = this.#now(), current = this.policy();
    const r = changePolicy({ current, next, session, now });
    if (!r.ok) return { refused: r.error };
    this.#store.transaction(() => {
      // AC5: sessions already past the current limits end first, so a looser policy can't revive them.
      const open = this.#store.endpoints().flatMap(e => this.#store.openSessionsOf(e.id));
      const expired = endExpiredSessions(open, now, current);
      for (const s of expired.sessions) this.#store.saveSession(s);
      this.#store.saveSetting("access_policy", r.value.policy);
      this.#store.record([...expired.events, ...r.value.events]);
    });
    return { policy: r.value.policy };
  }

  #putFlow(flow: Flow) {
    const now = this.#now();
    for (const [id, f] of this.#flows) if (f.expires <= now) this.#flows.delete(id);
    const id = randomUUID();
    this.#flows.set(id, flow);
    return id;
  }
  #takeFlow<K extends Flow["kind"]>(id: string, kind: K): Extract<Flow, { kind: K }> | null {
    const f = this.#flows.get(id);
    this.#flows.delete(id);                               // one attempt per challenge
    if (!f || f.kind !== kind || f.expires <= this.#now()) return null;
    return f as Extract<Flow, { kind: K }>;
  }

  // The console is the trust root (ADR-0004): only the principal's own machine issues the first token.
  issueConsoleToken() {
    const secret = newSecret();
    const { token, events } = issuePairingToken({
      id: pairingTokenId(randomUUID()), secretHash: hashSecret(secret), issuedBy: { kind: "console" }, now: this.#now(),
    });
    this.#store.transaction(() => { this.#store.saveToken(token); this.#store.record(events); });
    return { secret, token };
  }

  // AC10: "Add a device" on this Endpoint: a pairing token it issues, with the code this screen shows and the new device
  // types (amendment 11). Only with a user verification from the last 5 minutes, and not while 6 devices are active.
  issueEndpointToken(a: Authenticated): { tokenId: string; secret: string; code: string; expiresAt: number } | { refused: "step_up" | "ended" | "too_many_endpoints" } {
    const session = this.#store.session(a.session.id);
    if (!session) return { refused: "ended" };
    const secret = newSecret();
    const r = issueFromEndpoint({
      id: pairingTokenId(randomUUID()), secretHash: hashSecret(secret), code: newCode(), issuer: session,
      activeEndpoints: this.#store.activeEndpointCount(), now: this.#now(), policy: this.policy(),
    });
    if (!r.ok) return { refused: r.error };
    this.#store.transaction(() => { this.#store.saveToken(r.value.token); this.#store.record(r.value.events); });
    return { tokenId: r.value.token.id, secret, code: r.value.token.code ?? "", expiresAt: r.value.token.expiresAt };
  }

  // "Add a device" asks whether its own token was used, and by which device (review M3: not any device paired since).
  addedWith(a: Authenticated, tokenId: string): { name: string | null } | null {
    const token = this.#store.token(tokenId);
    if (!token || token.issuedBy.kind !== "endpoint" || token.issuedBy.endpointId !== a.endpoint.id) return null;
    const redeemedBy = token.redeemedBy;
    return { name: redeemedBy ? this.#store.endpoint(redeemedBy)?.name ?? null : null };
  }

  // "Cancel" on the device that issued the token: it can't be redeemed any more (review L6).
  // Already ended (used, expired, or a wrong code typed): nothing to withdraw, and that is fine.
  withdrawEndpointToken(a: Authenticated, tokenId: string): "withdrawn" | "ended" | "not_yours" {
    return this.#store.transaction(() => {
      const token = this.#store.token(tokenId);
      if (!token) return "not_yours";
      const r = withdrawToken(token, endpointId(a.endpoint.id), this.#now());
      if (!r.ok) return r.error;
      this.#store.saveToken(r.value.token);
      this.#store.record(r.value.events);
      return "withdrawn";
    });
  }

  // The pairing screen's look at its token before the passkey: whether it is still good, and whether the device must
  // type the code the issuing device shows (amendment 11). Never the code itself.
  tokenInfo(secret: string): { needsCode: boolean; expiresAt: number } | { refused: TokenProblem | "unknown_token" } {
    const token = this.#store.tokenBySecretHash(hashSecret(secret));
    if (!token) return { refused: "unknown_token" };
    const problem = tokenProblem(token, this.#now());
    return problem ? { refused: problem } : { needsCode: token.code !== null, expiresAt: token.expiresAt };
  }

  // AC11: a device not yet paired asks to be added. Its secret goes back to it once; the hub keeps hashes.
  requestLink(login: string | null): { requestId: string; secret: string; code: string; expiresAt: number } | { refused: "too_many" } {
    const secret = newSecret(), now = this.#now();
    return this.#store.transaction(() => {
      this.#expireLinks(now);
      const r = openLinkRequest({
        id: randomUUID(), secretHash: hashSecret(secret), tokenSecretHash: hashSecret(linkTokenSecret(secret)), code: newCode(),
        open: this.#store.openLinks(), requester: { login }, now,
      });
      if (!r.ok) return { refused: r.error };
      this.#store.saveLink(r.value.request);
      this.#store.record(r.value.events);
      return { requestId: r.value.request.id, secret, code: r.value.request.code, expiresAt: r.value.request.expiresAt };
    });
  }

  // An open request past its life ends as expired, with its audit row (AC11).
  #expireLinks(now: number) {
    for (const r of this.#store.openLinks()) {
      const x = expireLink(r, now);
      if (x) { this.#store.saveLink(x.request); this.#store.record(x.events); }
    }
  }

  // What the approving screen shows (AC11): when it asked, and the network's identity header if present; never the code,
  // which it must type (amendment 11).
  linkDetails(id: string): LinkView | null {
    const now = this.#now();
    const found = this.#store.transaction(() => { this.#expireLinks(now); return this.#store.link(id); });
    if (!found) return null;
    const r = found.request;
    return { createdAt: r.createdAt, expiresAt: r.expiresAt, requester: r.requester, state: r.state };
  }

  // AC11: approve (with a fresh user verification) or deny, once. Approval issues the requester's pairing token, with
  // this Endpoint as the issuer and the request's code. `identity`: the hub identity this device pinned at its own
  // pairing, and an HMAC of it under a key from the new device's QR code that the hub never saw: the new device checks
  // the HMAC, then the hub against that identity (review M1). An approval without it is refused.
  // `typedCode`: what the approver typed of the new device's code; a wrong one ends the request (amendment 11).
  decideLink(a: Authenticated, id: string, approve: boolean, identity: { pinned: string; proof: string } | null, typedCode: string | null = null): { ok: true } | { refused: "unknown" | "expired" | "decided" | "step_up" | "ended" | "too_many_endpoints" | "no_identity" | "wrong_code" | "code_needed" } {
    const now = this.#now();
    if (approve && !identity) return { refused: "no_identity" };
    return this.#store.transaction(() => {
      this.#expireLinks(now);
      const found = this.#store.link(id);
      const session = this.#store.session(a.session.id);
      if (!found) return { refused: "unknown" as const };
      if (!session) return { refused: "ended" as const };
      const r = decideLink({
        request: found.request, approver: session, approve, typedCode, tokenId: pairingTokenId(randomUUID()),
        activeEndpoints: this.#store.activeEndpointCount(), now, policy: this.policy(),
      });
      if (!r.ok) return { refused: r.error };
      this.#store.saveLink(r.value.request, r.value.outcome === "approved" ? identity : null);
      if (r.value.token) this.#store.saveToken(r.value.token);
      this.#store.record(r.value.events);
      return r.value.outcome === "mistyped" ? { refused: "wrong_code" as const } : { ok: true as const };
    });
  }

  // AC11: the requester asks with its own secret. Unknown, or the wrong secret: null, the same answer for both. Once
  // approved, its token's own life counts (review L1): used or expired, the request is over.
  collectLink(id: string, secret: string): Collected | null {
    const now = this.#now();
    const found = this.#store.transaction(() => { this.#expireLinks(now); return this.#store.link(id); });
    if (!found) return null;
    const r = collectLink({ request: found.request, secretHash: hashSecret(secret), now });
    if (!r.ok) return r.error === "wrong_secret" ? null : { state: r.error };
    const token = this.#store.tokenBySecretHash(found.request.tokenSecretHash);
    if (!token || tokenProblem(token, now)) return { state: "expired" };
    return { state: "approved", token: linkTokenSecret(secret), fingerprint: found.identity?.pinned ?? null, proof: found.identity?.proof ?? null };
  }

  // "Cancel" on the device that asked: its own secret ends the request and frees its place (review L6). Unknown, or
  // the wrong secret: null.
  cancelLink(id: string, secret: string): { ok: true } | { refused: "ended" } | null {
    const now = this.#now();
    return this.#store.transaction(() => {
      const found = this.#store.link(id);
      if (!found) return null;
      const r = cancelLink({ request: found.request, secretHash: hashSecret(secret), now });
      if (!r.ok) return r.error === "wrong_secret" ? null : { refused: r.error };
      this.#store.saveLink(r.value.request);
      this.#store.record(r.value.events);
      return { ok: true as const };
    });
  }

  // `typedCode`: the code from the issuing device, for a token that has one (amendment 11). Missing: asked for. Wrong:
  // the token ends at once, with no second try.
  async pairOptions(secret: string, deviceName: string, typedCode: string | null = null): Promise<{ flowId: string; options: unknown } | { refused: PairingRefusal | "unknown_token" | "code_needed" }> {
    const token = this.#store.tokenBySecretHash(hashSecret(secret));
    if (!token) return { refused: "unknown_token" };
    const problem = tokenProblem(token, this.#now());
    if (problem) return { refused: problem };
    const check = matchTokenCode(token, typedCode, this.#now());
    if (!check.matched && check.reason === "code_needed") return { refused: "code_needed" };
    if (!check.matched && check.reason === "wrong_code") {
      this.#store.transaction(() => { this.#store.saveToken(check.token); this.#store.record(check.events); });
      return { refused: "wrong_code" };
    }
    if (this.#store.activeEndpointCount() >= MAX_ACTIVE_ENDPOINTS) return { refused: "too_many_endpoints" };
    const exclude = this.#store.endpoints().filter(isActive).map(e => e.credential);
    const options = await this.#passkeys.registrationOptions({ deviceName, exclude });
    const flowId = this.#putFlow({ kind: "pair", challenge: options.challenge, tokenId: token.id, secretHash: token.secretHash, deviceName, typedCode, expires: this.#now() + FLOW_TTL_MS });
    return { flowId, options };
  }

  async pairVerify(flowId: string, response: RegistrationResponseJSON): Promise<{ cookieSecret: string; endpoint: Endpoint } | { refused: PairingRefusal | SessionRefusal | "bad_flow" | "not_verified" }> {
    const flow = this.#takeFlow(flowId, "pair");
    if (!flow) return { refused: "bad_flow" };
    let verified;
    try { verified = await this.#passkeys.verifyRegistration(response, flow.challenge); }
    catch (e) { log.warn(`passkey registration refused: ${(e as Error).message}`); verified = null; }
    if (!verified) return { refused: "not_verified" };
    const done = this.#store.transaction(() => {
      const now = this.#now();
      const token = this.#store.tokenBySecretHash(flow.secretHash);   // re-read inside the transaction: AC1 races
      if (!token) return { refused: "bad_flow" as const };
      const paired = pairEndpoint({
        token, activeEndpoints: this.#store.activeEndpointCount(), id: endpointId(randomUUID()), name: flow.deviceName,
        credential: verified.credential, userVerified: verified.userVerified, typedCode: flow.typedCode, now,
      });
      if (!paired.ok) return { refused: paired.error };
      const cookieSecret = newSecret();
      const started = startSession({ endpoint: paired.value.endpoint, id: sessionId(hashSecret(cookieSecret)), proof: { kind: "pairing", tokenId: token.id, issuedBy: token.issuedBy }, now });
      if (!started.ok) return { refused: started.error };
      this.#store.saveToken(paired.value.token);
      this.#store.saveEndpoint(started.value.endpoint);
      this.#store.saveSession(started.value.session);
      this.#store.record([...paired.value.events, ...started.value.events]);
      return { cookieSecret, endpoint: started.value.endpoint, linked: token.issuedBy.kind === "endpoint", by: this.#nameOf(token.issuedBy), at: now };
    });
    if ("linked" in done && done.linked) this.#told({ name: done.endpoint.name, at: done.at, by: done.by });   // AC13
    return "refused" in done ? done : { cookieSecret: done.cookieSecret, endpoint: done.endpoint };
  }

  async loginOptions() {
    const options = await this.#passkeys.authenticationOptions();
    return { flowId: this.#putFlow({ kind: "login", challenge: options.challenge, expires: this.#now() + FLOW_TTL_MS }), options };
  }

  async loginVerify(flowId: string, response: AuthenticationResponseJSON): Promise<{ cookieSecret: string; endpoint: Endpoint } | { refused: SessionRefusal | "bad_flow" | "unknown_device" | "not_verified" }> {
    const flow = this.#takeFlow(flowId, "login");
    if (!flow) return { refused: "bad_flow" };
    const endpoint = this.#store.endpointByCredential(response.id);
    if (!endpoint) return { refused: "unknown_device" };
    let verified;
    try { verified = await this.#passkeys.verifyAuthentication(response, flow.challenge, endpoint.credential); }
    catch (e) { log.warn(`passkey sign-in refused: ${(e as Error).message}`); verified = null; }
    if (!verified) return { refused: "not_verified" };
    const cookieSecret = newSecret();
    return this.#store.transaction(() => {
      const current = this.#store.endpoint(endpoint.id) ?? endpoint;      // it may have been revoked meanwhile
      const started = startSession({ endpoint: current, id: sessionId(hashSecret(cookieSecret)), proof: { kind: "assertion", userVerified: verified.userVerified, newCounter: verified.newCounter }, now: this.#now() });
      if (!started.ok) return { refused: started.error };
      this.#store.saveEndpoint(started.value.endpoint);
      this.#store.saveSession(started.value.session);
      this.#store.record(started.value.events);
      return { cookieSecret, endpoint: started.value.endpoint };
    });
  }

  // AC7 step-up: the signed-in device proves presence again (Face ID / Touch ID) before it may send commands.
  async stepUpOptions(a: Authenticated) {
    const options = await this.#passkeys.authenticationOptions([a.endpoint.credential]);
    return { flowId: this.#putFlow({ kind: "stepup", challenge: options.challenge, sessionId: a.session.id, expires: this.#now() + FLOW_TTL_MS }), options };
  }

  async stepUpVerify(a: Authenticated, flowId: string, response: AuthenticationResponseJSON): Promise<{ ok: true } | { refused: string }> {
    const flow = this.#takeFlow(flowId, "stepup");
    if (!flow || flow.sessionId !== a.session.id) return { refused: "bad_flow" };
    if (response.id !== a.endpoint.credential.id) return { refused: "wrong_device" };
    let verified;
    try { verified = await this.#passkeys.verifyAuthentication(response, flow.challenge, a.endpoint.credential); }
    catch (e) { log.warn(`passkey step-up refused: ${(e as Error).message}`); verified = null; }
    if (!verified) return { refused: "not_verified" };
    return this.#store.transaction(() => {
      const session = this.#store.session(a.session.id);
      const endpoint = this.#store.endpoint(a.endpoint.id);
      if (!session || !endpoint) return { refused: "ended" };
      const r = reverifySession({ session, endpoint, userVerified: verified.userVerified, newCounter: verified.newCounter, now: this.#now(), policy: this.policy() });
      if (!r.ok) return { refused: r.error };
      this.#store.saveSession(r.value.session);
      this.#store.saveEndpoint(r.value.endpoint);
      this.#store.record(r.value.events);
      return { ok: true as const };
    });
  }

  // Every request: the cookie's secret → a valid Session of an active Endpoint, or nothing. Only use by the principal
  // counts toward the idle limit (AC5); the hub's own periodic checks pass `use = false` and never touch the Session.
  authenticate(cookieSecret: string | undefined, use = true): Authenticated | null {
    if (!cookieSecret) return null;
    const session = this.#store.session(hashSecret(cookieSecret));
    if (!session) return null;
    const now = this.#now();
    const policy = this.policy();
    if (sessionState(session, now, policy) !== "valid") return null;
    const endpoint = this.#store.endpoint(session.endpointId);
    if (!endpoint || !isActive(endpoint)) return null;
    if (use && now - session.lastSeenAt >= TOUCH_WRITE_EVERY_MS) {
      const touched = touchSession(session, now, policy);
      this.#store.saveSession(touched);
      this.#store.saveEndpoint({ ...endpoint, lastSeenAt: now });
      return { session: touched, endpoint };
    }
    return { session, endpoint };
  }

  // Signing out also ends this device's push subscription: a signed-out browser shows no counts any more (review L3).
  signOut(session: Session) {
    const r = endSession(session, "signed_out", this.#now());
    this.#store.transaction(() => {
      this.#store.saveSession(r.session);
      this.#store.record(r.events);
      if (this.#store.deletePushSubscription(session.endpointId)) this.#store.record([{ type: "PushUnsubscribed", endpointId: session.endpointId, reason: "signed_out", at: this.#now() }]);
    });
  }

  devices() { return this.#store.endpoints(); }

  // From a device: another one only with a passkey check as fresh as a command needs (whole-branch review L8). Any
  // device can add one now, and a phished one, which has had no check of its own (AC12), mustn't cut the owner's devices
  // off. Its own, always: that is signing this device out for good. The console's `revoke` stays the recovery.
  revokeFrom(a: Authenticated, id: string): boolean | { refused: "step_up" } {
    if (id !== a.endpoint.id && !mayCommand(a.session, this.#now(), this.policy())) return { refused: "step_up" };
    return this.revoke(id);
  }

  revoke(id: string): boolean {
    // RL10 (updates design §11.5): the journal line goes down, fsynced, before the transaction. A crash between the
    // two leaves a revocation the next start applies; the other order could leave one only morndo.db knows, which a
    // database restored from an older copy would forget.
    const current = this.#store.endpoint(id);
    if (current !== null && isActive(current)) this.#journal?.append({ kind: "endpoint", id, at: this.#now() });
    const done = this.#store.transaction(() => {
      const endpoint = this.#store.endpoint(id);
      if (!endpoint) return false;
      const now = this.#now();
      const r = revokeEndpoint(endpoint, this.#store.openSessionsOf(id), now, this.#store.openTokensIssuedBy(id, now));
      this.#store.saveEndpoint(r.endpoint);
      for (const s of r.sessions) this.#store.saveSession(s);
      for (const t of r.tokens) this.#store.saveToken(t);
      this.#store.record(r.events);
      // N4: its push subscription goes with it, so a revoked device hears nothing more.
      if (this.#store.deletePushSubscription(id)) this.#store.record([{ type: "PushUnsubscribed", endpointId: id, reason: "revoked", at: this.#now() }]);
      return r.events.length > 0;
    });
    if (done) this.#onRevoked(id);                        // AC4: live connections of that device close at once
    return done;
  }
}
