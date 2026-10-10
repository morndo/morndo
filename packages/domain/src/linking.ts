// Adding a device from a signed-in one (Access, ADR-0008 phase E; AC10–AC13 in docs/domain.md). Modeled on Signal's
// linked devices, with the product lane's constraints: the issuing or approving Endpoint verifies within 5 minutes,
// a code shows on both screens, and the new device starts with no step-up credit. Pure: secrets arrive hashed.
// Design reference, not code: Signal-Desktop ts/textsecure/Provisioner.preload.ts, Signal-Server ProvisioningController.
import { MAX_ACTIVE_ENDPOINTS, issuePairingToken, mayWatch, type AccessEvent, type AccessPolicy, type PairingToken, type Session } from "./access.ts";
import { err, ok, type EndpointId, type PairingTokenId, type Result } from "./shared.ts";

export const LINK_TTL_MS = 10 * 60_000;            // AC11: a Link request lives 10 minutes, like a pairing token
export const MAX_OPEN_LINKS = 3;                   // AC11: at most 3 open at once
export const ISSUE_FRESHNESS_MS = 5 * 60_000;      // AC10: as in AC8 and AC9

export const isLinkCode = (c: string) => /^\d{6}$/.test(c);

export type LinkState = "open" | "approved" | "denied" | "expired" | "cancelled" | "mistyped";
export type LinkRequest = {
  id: string;
  secretHash: string;                              // the requester's own secret, hashed: only it collects the token
  tokenSecretHash: string;                         // the pairing secret the requester derives from it, hashed
  code: string;                                    // six digits the new device shows and the approving one types
  createdAt: number;
  expiresAt: number;
  state: LinkState;
  requester: { login: string | null };             // what the hub knows of who asked: the network's identity header
  tokenId: PairingTokenId | null;                  // bound on approval
  decidedBy: EndpointId | null;
};

// AC10: an Endpoint issues a pairing token or approves a Link request only with a user verification from the last
// 5 minutes, whatever the step-up policy, and only from a valid Session.
export const mayIssueFromEndpoint = (s: Session, now: number, policy: AccessPolicy) =>
  mayWatch(s, now, policy) && s.verifiedAt > 0 && now - s.verifiedAt < ISSUE_FRESHNESS_MS;

// AC10: a pairing token issued by this Endpoint. From "Add a device" it has a code the new device must type before it
// pairs (amendment 11); for an approved Link request it has none, since the approver typed that request's code. Not
// while 6 are active (AC2; checked again when the token is redeemed, as Signal checks on issue and on link), which is
// said before any passkey check.
export function issueFromEndpoint(p: {
  id: PairingTokenId; secretHash: string; code: string | null; issuer: Session; activeEndpoints: number; now: number; policy: AccessPolicy;
}): Result<{ token: PairingToken; events: AccessEvent[] }, "step_up" | "ended" | "too_many_endpoints"> {
  if (!mayWatch(p.issuer, p.now, p.policy)) return err("ended");
  if (p.activeEndpoints >= MAX_ACTIVE_ENDPOINTS) return err("too_many_endpoints");
  if (!mayIssueFromEndpoint(p.issuer, p.now, p.policy) || (p.code !== null && !isLinkCode(p.code))) return err("step_up");
  return ok(issuePairingToken({ id: p.id, secretHash: p.secretHash, code: p.code, issuedBy: { kind: "endpoint", endpointId: p.issuer.endpointId }, now: p.now }));
}

const live = (r: LinkRequest, now: number) => r.state === "open" && now < r.expiresAt;

export function openLinkRequest(p: {
  id: string; secretHash: string; tokenSecretHash: string; code: string; open: readonly LinkRequest[]; requester: { login: string | null }; now: number;
}): Result<{ request: LinkRequest; events: AccessEvent[] }, "too_many"> {
  if (p.open.filter(r => live(r, p.now)).length >= MAX_OPEN_LINKS) return err("too_many");
  const request: LinkRequest = {
    id: p.id, secretHash: p.secretHash, tokenSecretHash: p.tokenSecretHash, code: p.code, createdAt: p.now,
    expiresAt: p.now + LINK_TTL_MS, state: "open", requester: p.requester, tokenId: null, decidedBy: null,
  };
  return ok({ request, events: [{ type: "LinkRequested", linkId: p.id, requester: p.requester, at: p.now }] });
}

// Amendment 11, the Add-a-device direction: the new device types the code the issuing device shows, before its
// passkey. A token without a code needs none. A wrong code ends the token at once: no second try on it.
export type CodeCheck =
  | { matched: true }
  | { matched: false; reason: "code_needed" }
  | { matched: false; reason: "wrong_code"; token: PairingToken; events: AccessEvent[] };
export function matchTokenCode(token: PairingToken, typed: string | null, now: number): CodeCheck {
  if (token.code === null || typed === token.code) return { matched: true };
  if (!typed) return { matched: false, reason: "code_needed" };
  // Ended as of its own issue time, so no clock stepping back can revive it (review L1).
  return { matched: false, reason: "wrong_code", token: { ...token, expiresAt: token.issuedAt }, events: [{ type: "PairingTokenCodeMismatched", tokenId: token.id, at: now }] };
}

// "Cancel" on the device that issued a token: it can't be redeemed any more. Only its issuer withdraws it.
export function withdrawToken(token: PairingToken, by: EndpointId, now: number): Result<{ token: PairingToken; events: AccessEvent[] }, "not_yours" | "ended"> {
  if (token.issuedBy.kind !== "endpoint" || token.issuedBy.endpointId !== by) return err("not_yours");
  if (token.redeemedAt !== null || now >= token.expiresAt) return err("ended");
  return ok({ token: { ...token, expiresAt: token.issuedAt }, events: [{ type: "PairingTokenWithdrawn", tokenId: token.id, endpointId: by, at: now }] });
}

// "Cancel" on the device that asked: only its own secret ends it, and only while it waits for an answer, so it frees
// its place among the 3 open (AC11).
export function cancelLink(p: { request: LinkRequest; secretHash: string; now: number }): Result<{ request: LinkRequest; events: AccessEvent[] }, "wrong_secret" | "ended"> {
  if (p.secretHash !== p.request.secretHash) return err("wrong_secret");
  if (!live(p.request, p.now)) return err("ended");
  return ok({ request: { ...p.request, state: "cancelled" }, events: [{ type: "LinkCancelled", linkId: p.request.id, at: p.now }] });
}

// AC11: answered once. Approval needs the code the new device shows, typed on the approving device (amendment 11):
// a wrong one ends the request at once, before any passkey check, with no second try. A right one issues exactly one
// pairing token for the requester, bound to the request, with this Endpoint as the issuer; denial yields nothing.
export type LinkOutcome = "approved" | "denied" | "mistyped";
export function decideLink(p: {
  request: LinkRequest; approver: Session; approve: boolean; typedCode: string | null; tokenId: PairingTokenId; activeEndpoints: number; now: number; policy: AccessPolicy;
}): Result<{ request: LinkRequest; token: PairingToken | null; outcome: LinkOutcome; events: AccessEvent[] }, "expired" | "decided" | "step_up" | "ended" | "too_many_endpoints" | "code_needed"> {
  const over = p.request.state === "expired" || p.request.state === "cancelled" || p.request.state === "mistyped" || (p.request.state === "open" && p.now >= p.request.expiresAt);
  if (over) return err("expired");
  if (p.request.state !== "open") return err("decided");
  if (!mayWatch(p.approver, p.now, p.policy)) return err("ended");
  const decidedBy = p.approver.endpointId;
  if (!p.approve) {
    return ok({ request: { ...p.request, state: "denied", decidedBy }, token: null, outcome: "denied", events: [{ type: "LinkDenied", linkId: p.request.id, endpointId: decidedBy, at: p.now }] });
  }
  if (!p.typedCode) return err("code_needed");                     // asked for, as on the pairing page (review L7)
  if (p.typedCode !== p.request.code) {
    return ok({ request: { ...p.request, state: "mistyped", decidedBy }, token: null, outcome: "mistyped", events: [{ type: "LinkCodeMismatched", linkId: p.request.id, endpointId: decidedBy, at: p.now }] });
  }
  const issued = issueFromEndpoint({
    id: p.tokenId, secretHash: p.request.tokenSecretHash, code: null, issuer: p.approver, activeEndpoints: p.activeEndpoints, now: p.now, policy: p.policy,
  });
  if (!issued.ok) return issued;
  return ok({
    request: { ...p.request, state: "approved", tokenId: p.tokenId, decidedBy },
    token: issued.value.token,
    outcome: "approved",
    events: [{ type: "LinkApproved", linkId: p.request.id, endpointId: decidedBy, tokenId: p.tokenId, at: p.now }, ...issued.value.events],
  });
}

// AC11: only the requester's secret collects the bound token. Asking again gives the same answer (a lost reply can be
// asked for again). Once approved, the token's own life counts, not the request's: an approval in the request's last
// seconds isn't lost (review L1); the token is still redeemed only once and expires on its own (AC1).
export function collectLink(p: { request: LinkRequest; secretHash: string; now: number }):
  Result<{ tokenId: PairingTokenId }, "wrong_secret" | "waiting" | "denied" | "expired" | "cancelled" | "mistyped"> {
  if (p.secretHash !== p.request.secretHash) return err("wrong_secret");
  if (p.request.state === "approved" && p.request.tokenId) return ok({ tokenId: p.request.tokenId });
  if (p.request.state === "denied") return err("denied");
  if (p.request.state === "mistyped") return err("mistyped");
  if (p.request.state === "cancelled") return err("cancelled");
  if (p.request.state === "expired" || p.now >= p.request.expiresAt) return err("expired");
  return err("waiting");
}

// An open request past its life ends as expired, once.
export function expireLink(r: LinkRequest, now: number): { request: LinkRequest; events: AccessEvent[] } | null {
  if (r.state !== "open" || now < r.expiresAt) return null;
  return { request: { ...r, state: "expired" }, events: [{ type: "LinkExpired", linkId: r.id, at: now }] };
}
