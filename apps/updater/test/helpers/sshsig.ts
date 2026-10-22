// A signer for tests that need real SSH signatures at speed (PROTOCOL.sshsig): an Ed25519 key from node:crypto and
// the blob the protocol defines — the magic, version 1, public key, namespace, reserved, hash algorithm, signature —
// armored the way ssh-keygen armors it. The step-1 verifier (src/adapters/verifier-sshsig.ts) proves these verify;
// check-service.test.ts also cross-checks one against `ssh-keygen -Y verify`, so a fixture cannot drift from the tool
// the release pipeline signs with (scripts/release/sign.ts). Test code only: node:crypto stays out of the
// application layer (§4.7).
import { createHash, generateKeyPairSync, sign as ed25519Sign } from "node:crypto";

// An SSH string: uint32 big-endian length, then that many bytes (the verifier's own `string`, spelled here so the
// test helper stands alone).
const string = (bytes: Uint8Array): Buffer => {
  const head = Buffer.alloc(4 + bytes.length);
  head.writeUInt32BE(bytes.length, 0);
  head.set(bytes, 4);
  return head;
};
const ED25519 = string(Buffer.from("ssh-ed25519"));

export type SigningKey = {
  /** ssh-keygen's own fingerprint formula: SHA-256 of the key blob, base64, padding gone. */
  fingerprint: string;
  /** The public key as an OpenSSH .pub line, for allowed_signers files. */
  publicLine: string;
  /** The armored .sig text for `message` signed under `namespace`. */
  signature(message: Uint8Array, namespace: string): Buffer;
};

export function makeSigningKey(): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // An Ed25519 public key in JWK form carries the raw 32 bytes as `x`, base64url — nothing to parse by hand.
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const blob = Buffer.concat([ED25519, string(raw)]);
  return {
    fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
    publicLine: `ssh-ed25519 ${blob.toString("base64")} test`,
    signature(message, namespace) {
      // What is signed (PROTOCOL.sshsig): the magic, namespace, reserved, hash algorithm and H(message), each an
      // SSH string but the magic — the blob's version field is not part of it.
      const digest = createHash("sha512").update(message).digest();
      const signed = Buffer.concat([
        Buffer.from("SSHSIG"), string(Buffer.from(namespace)), string(new Uint8Array(0)),
        string(Buffer.from("sha512")), string(digest),
      ]);
      const signature = Buffer.concat([ED25519, string(ed25519Sign(null, signed, privateKey))]);
      const version = Buffer.alloc(4);
      version.writeUInt32BE(1, 0);
      const full = Buffer.concat([
        Buffer.from("SSHSIG"), version, string(blob), string(Buffer.from(namespace)), string(new Uint8Array(0)),
        string(Buffer.from("sha512")), string(signature),
      ]);
      const body = full.toString("base64").match(/.{1,70}/g) ?? [];
      return Buffer.from(`-----BEGIN SSH SIGNATURE-----\n${body.join("\n")}\n-----END SSH SIGNATURE-----\n`);
    },
  };
}
