// The hub's half of the principal's proof (updates §5.4, PR 6c): one assertion per request — what it asks for, how
// long it is good, a nonce — signed with the hub's identity key (ADR-0004), the same key every endpoint pins at
// pairing. The fleet verifies under the public key its config pins (apps/fleet/src/adapters/principal-check.ts);
// the two ends meet over the protocol's pure encode (packages/protocol/src/principal.ts), so the bytes signed are
// exactly the bytes sent.
import { randomBytes } from "node:crypto";
import { PRINCIPAL_SIGN_PREFIX, encodePrincipalHeader, principalPayloadText, type PrincipalAsk, type PrincipalAssertion } from "@morndo/protocol";
import type { HubIdentity } from "./identity.ts";

// How long a signed assertion is good for (§5.4): the fleet takes an exp no more than 60 s ahead of its own clock,
// so half of that leaves room for two clocks a little apart without giving the proof a shelf life.
export const PRINCIPAL_GOOD_FOR_MS = 30_000;

// The signer as the updates service takes it: one ask in, one header value out. A fresh nonce every call — the
// fleet spends each on use, so a repeated header is a replay it refuses.
export function principalSigner(identity: HubIdentity): (ask: PrincipalAsk, now?: number) => string {
  return (ask, now) => {
    const assertion: PrincipalAssertion = { ...ask, exp: (now ?? Date.now()) + PRINCIPAL_GOOD_FOR_MS, nonce: randomBytes(16).toString("base64url") };
    const payload = principalPayloadText(assertion);
    const signature = identity.sign(Buffer.concat([Buffer.from(PRINCIPAL_SIGN_PREFIX), Buffer.from(payload)]));
    return encodePrincipalHeader(payload, signature);
  };
}
