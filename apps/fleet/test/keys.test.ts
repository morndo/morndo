// The fleet's Ed25519 key: created once at mode 0600 in a 0700 directory, the same key on every later start, refused
// when others can read it; and the check of a node's signature, both ways round.
import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fleetSigPayload, nodeSigPayload } from "@morndo/protocol";
import { KeyFileUnsafe, loadOrCreateFleetKey, parsePublicKey, verifySig } from "../src/adapters/keys.ts";
import { tempDir } from "./helpers/temp.ts";

// The handshake's nonces are 22 to 86 characters of base64url (the protocol refuses to sign anything else).
const N1 = "nonce-1".padEnd(22, "0");
const N2 = "nonce-2".padEnd(22, "0");

const nodeKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { spki: publicKey.export({ type: "spki", format: "der" }).toString("base64"), sign: (p: string) => sign(null, Buffer.from(p), privateKey).toString("base64") };
};

describe("the fleet key", () => {
  it("is created on first use with mode 0600 in a 0700 directory, and is the same key afterwards", () => {
    const path = join(tempDir(), "state", "fleet-key.pem");
    const first = loadOrCreateFleetKey(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(loadOrCreateFleetKey(path).publicKey).toBe(first.publicKey);
    expect(parsePublicKey(first.publicKey)?.asymmetricKeyType).toBe("ed25519");
  });

  it("signs what a node can verify against the pinned public key, and nothing else verifies", () => {
    const key = loadOrCreateFleetKey(join(tempDir(), "k.pem"));
    const sig = key.sign(fleetSigPayload("pc", N1));
    const pinned = createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" });
    expect(verify(null, Buffer.from(fleetSigPayload("pc", N1)), pinned, Buffer.from(sig, "base64"))).toBe(true);
    expect(verify(null, Buffer.from(fleetSigPayload("pc", N2)), pinned, Buffer.from(sig, "base64"))).toBe(false);
    expect(verify(null, Buffer.from(fleetSigPayload("mac", N1)), pinned, Buffer.from(sig, "base64"))).toBe(false);
  });

  it("refuses a key file that others can read", () => {
    const path = join(tempDir(), "k.pem");
    loadOrCreateFleetKey(path);
    chmodSync(path, 0o644);
    expect(() => loadOrCreateFleetKey(path)).toThrow(KeyFileUnsafe);
    expect(() => loadOrCreateFleetKey(path)).toThrow(/chmod 600/);
  });
});

describe("a node's proof", () => {
  it("verifies only with the node's key, over the node payload, untampered", () => {
    const n = nodeKey();
    const other = nodeKey();
    const sig = n.sign(nodeSigPayload("pc", N1));
    expect(verifySig(n.spki, nodeSigPayload("pc", N1), sig)).toBe(true);
    expect(verifySig(other.spki, nodeSigPayload("pc", N1), sig)).toBe(false);             // another node's key
    expect(verifySig(n.spki, nodeSigPayload("pc", N2), sig)).toBe(false);                  // another nonce
    expect(verifySig(n.spki, fleetSigPayload("pc", N1), n.sign(fleetSigPayload("pc", N1)))).toBe(true);
    expect(verifySig(n.spki, nodeSigPayload("pc", N1), n.sign(fleetSigPayload("pc", N1)))).toBe(false);   // domain separated
    const tampered = Buffer.from(sig, "base64");
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(verifySig(n.spki, nodeSigPayload("pc", N1), tampered.toString("base64"))).toBe(false);
    expect(verifySig("not a key", nodeSigPayload("pc", N1), sig)).toBe(false);
    expect(verifySig(n.spki, nodeSigPayload("pc", N1), "%%%")).toBe(false);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
    expect(parsePublicKey(rsa)).toBeNull();                                              // only Ed25519 keys are node keys
  });
});
