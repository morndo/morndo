// The node's own key and the fleet's pinned key (ADR-0012 decision 4; spec §5.1, §5.2). Ed25519 through node:crypto
// (https://nodejs.org/docs/latest-v24.x/api/crypto.html, read 2026-10-06: generateKeyPairSync('ed25519'), sign(null, …),
// verify(null, …), keyObject.export({ format: 'der', type: 'spki' }), createPublicKey({ key, format: 'der',
// type: 'spki' })). Public keys travel as SPKI DER in base64; the private key stays in a PKCS#8 PEM file of mode 0600.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { ConfigError } from "./config.ts";

export type NodeKey = {
  publicKey: string;                    // SPKI DER, base64
  sign(payload: string): string;        // Ed25519 over the UTF-8 payload, base64
  pem(): string;                        // the private key, PKCS#8 PEM
};

function wrap(privateKey: KeyObject): NodeKey {
  return {
    publicKey: createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64"),
    sign: payload => sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64"),
    pem: () => privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

export function createNodeKey(): NodeKey {
  return wrap(generateKeyPairSync("ed25519").privateKey);
}

// The node's key from its file. A file that is missing (a link to nothing included), corrupt or half written, or not an
// Ed25519 key is a ConfigError, one sentence: `run` exits 78, since a restart would only meet the same file.
export function loadNodeKey(path: string): NodeKey {
  let pem: Buffer;
  try { pem = readFileSync(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigError(`${path} is missing or a link to nothing; this node has no key (join again: remove config.json, then morndo-node join)`);
    throw e;
  }
  let key: KeyObject;
  try { key = createPrivateKey(pem); }
  catch { throw new ConfigError(`${path} is not a readable private key (corrupt or half written); join again: remove config.json and the key, then morndo-node join`); }
  if (key.asymmetricKeyType !== "ed25519") throw new ConfigError(`${path} is not an Ed25519 private key`);
  return wrap(key);
}

// The fleet's public key from a join string or config.json, or null when it isn't an Ed25519 SPKI key.
export function fleetPublicKey(spkiBase64: string): KeyObject | null {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

export function signedBy(key: KeyObject, payload: string, sigBase64: string): boolean {
  try { return verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(sigBase64, "base64")); }
  catch { return false; }
}
