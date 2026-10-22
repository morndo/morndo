// The fleet's check of the principal's proof (updates §5.4, PR 6c): the hub signs one assertion — what it asks for,
// until when, a nonce — and the fleet verifies it under the hub's public key, from one of two places: the key its
// config pins (principalKey), or, without a pin, the hub's own identity.pub read at each check (PR 6c round 2, R2 —
// the fleet starts before the hub, so the file may not be there yet). Every refusal is the same as no proof at all:
// the route answers not_allowed and nothing moves. The signature is checked over the prefix plus the payload's exact
// bytes as sent, so a payload that changed one byte on the way fails the signature before any field is read. The
// nonce makes a proof one-use: kept until its exp, then pruned; when the cache is full of still-live nonces the
// fleet stops accepting rather than forget one (fail closed).
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  PRINCIPAL_HEADER, PRINCIPAL_MAX_AHEAD_MS, PRINCIPAL_SIGN_PREFIX,
  decodePrincipalHeader, parsePrincipalAssertion,
} from "@morndo/protocol";
import type { RolloutAuthority } from "./client-api.ts";

// How many nonces the cache holds at once (§5.4): far more than a hub and a fleet can exchange in a minute, few
// enough that the check never becomes a memory the fleet must mind.
const MAX_NONCES = 10_000;

// The config's principalKey (base64) as the 32 bytes Ed25519 verifies under.
export function decodePrincipalKey(base64: string): Uint8Array {
  const raw = Buffer.from(base64, "base64");
  if (raw.length !== 32) throw new Error(`a principal key is 32 bytes, an Ed25519 public key, base64: this is ${raw.length}`);
  return new Uint8Array(raw);
}

// The authority's one check (§5.4), under whichever way this fleet learned the hub's public key: `keyAt` answers
// the 32 bytes to verify under, or null when none can be trusted at this moment — which says no, like every miss
// below. Commit and halt stay closed either way (they come by the internal paths, §4.5); resume and update.apply
// open to the hub's signed assertion, checked against exactly the request's ask.
const authorityOf = (keyAt: () => Uint8Array | null, o: { now?: () => number } = {}): RolloutAuthority => {
  const now = o.now ?? Date.now;
  const spent = new Map<string, number>();           // each nonce, until its exp
  return {
    updater: () => false,
    principal: (req, ask) => {
      const publicKey = keyAt();
      if (publicKey === null) return false;
      const header = req.headers[PRINCIPAL_HEADER];
      const value = Array.isArray(header) ? header[0] : header;
      if (typeof value !== "string") return false;
      const parts = decodePrincipalHeader(value);
      if (parts === null) return false;
      let signed: boolean;
      try {
        const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") }, format: "jwk" });
        signed = verify(null, Buffer.concat([Buffer.from(PRINCIPAL_SIGN_PREFIX), Buffer.from(parts.payload)]), key, Buffer.from(parts.signature));
      } catch {
        return false;
      }
      if (!signed) return false;
      const assertion = parsePrincipalAssertion(new TextDecoder().decode(parts.payload));
      if (assertion === null) return false;
      const t = now();
      if (!(assertion.exp > t && assertion.exp <= t + PRINCIPAL_MAX_AHEAD_MS)) return false;
      if (assertion.op !== ask.op || assertion.version !== ask.version || assertion.node !== ask.node) return false;
      // One use: forget what expired, refuse what is known, and stop at the cap rather than forget a live one.
      for (const [nonce, exp] of spent) if (exp <= t) spent.delete(nonce);
      if (spent.has(assertion.nonce)) return false;
      if (spent.size >= MAX_NONCES) return false;
      spent.set(assertion.nonce, assertion.exp);
      return true;
    },
  };
};

// The authority a pinned principalKey gives (§5.4): the key is the config's own word, read once at the start.
export function principalAuthority(publicKey: Uint8Array, o: { now?: () => number } = {}): RolloutAuthority {
  return authorityOf(() => publicKey, o);
}

// Where the hub writes its public key for the fleet (R2): the hub's own data dir (its dataDirOf rule, written here
// — the fleet does not import the hub), MORNDO_HOME ahead of ~/.local/share/morndo, as the hub decides it.
export function hubIdentityPubFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.MORNDO_HOME ?? join(homedir(), ".local/share/morndo"), "identity.pub");
}

// The authority the hub's own identity.pub gives (§5.4, R2): the file is read at each principal check, never held
// from the start, because the fleet starts before the hub and the hub rewrites the file at each of its starts.
// Missing, unreadable, or not 32 bytes of base64: that check says no. A pinned principalKey (above) wins over it.
export function hubFilePrincipalAuthority(path: string, o: { now?: () => number } = {}): RolloutAuthority {
  return authorityOf(() => {
    try {
      const raw = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
      return raw.length === 32 ? new Uint8Array(raw) : null;
    } catch { return null; }
  }, o);
}
