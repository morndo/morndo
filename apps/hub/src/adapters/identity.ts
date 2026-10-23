// The hub's identity key (ADR-0004: pinned by each Endpoint at pairing, like a Signal safety number).
// Ed25519 via node:crypto; the private key lives in the data dir, readable by this OS user only.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

// The identity's public key where the fleet reads it (updates §5.4, PR 6c round 2, R2): <dataDir>/identity.pub, the
// 32 raw bytes as one line of base64, mode 0644. The fleet's principal check reads it afresh at each ask — the fleet
// starts before the hub — so this is written on every start, and atomically (a temp file beside it, then the
// rename): a file a hand moved or edited heals at the next start, and no reader sees half of one.
export function writeIdentityPub(dataDir: string, publicKeyRaw: Buffer): void {
  const file = join(dataDir, "identity.pub");
  const tmp = join(dataDir, `.identity.pub.${process.pid}.tmp`);
  writeFileSync(tmp, `${publicKeyRaw.toString("base64")}\n`, { mode: 0o644 });
  chmodSync(tmp, 0o644);                  // writeFileSync's mode meets the umask; the file's own word is 0644
  renameSync(tmp, file);
}
