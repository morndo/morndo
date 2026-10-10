// The hub's identity key (ADR-0004: pinned by each Endpoint at pairing, like a Signal safety number).
// Ed25519 via node:crypto; the private key lives in the data dir, readable by this OS user only.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type HubIdentity = {
  publicKeyRaw: Buffer;          // 32 bytes
  fingerprint: string;           // sha256 of the raw public key, hex
  sign(data: Buffer): Buffer;
};

export function loadOrCreateIdentity(dataDir: string): HubIdentity {
  const file = join(dataDir, "hub-identity.pem");
  let privateKey: KeyObject;
  if (existsSync(file)) {
    privateKey = createPrivateKey(readFileSync(file));
  } else {
    privateKey = generateKeyPairSync("ed25519").privateKey;
    writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  }
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  const publicKeyRaw = Buffer.from(jwk.x ?? "", "base64url");
  if (publicKeyRaw.length !== 32) throw new Error("unexpected Ed25519 public key length");
  return {
    publicKeyRaw,
    fingerprint: createHash("sha256").update(publicKeyRaw).digest("hex"),
    sign: data => sign(null, data, privateKey),
  };
}
