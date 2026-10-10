// The fleet's own Ed25519 key (spec 5.1, 5.2), pinned by every node from its join string, and the check of a node's
// proof. Node.js 24 crypto: generateKeyPairSync('ed25519'), sign(null, …) and verify(null, …) take no digest for
// Ed25519; public keys travel as SPKI DER in base64. https://nodejs.org/docs/latest-v24.x/api/crypto.html (read
// 2026-10-06).
import { randomBytes, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type FleetKey = { publicKey: string /* SPKI DER, base64 */; sign(payload: string): string /* base64 */ };

// The key file can't be used safely: others can read it. `morndo-fleet` exits 78 with the message.
export class KeyFileUnsafe extends Error {
  constructor(message: string) { super(message); this.name = "KeyFileUnsafe"; }
}

// The key file can't be used at all: corrupt or half written, a link to nothing, not an Ed25519 key. Also exit 78, one
// sentence: a restart would only meet the same file.
export class KeyFileUnreadable extends KeyFileUnsafe {
  constructor(message: string) { super(message); this.name = "KeyFileUnreadable"; }
}

// Writes a new key whole or not at all, and never over a key another process (the service, a console command) wrote
// first: the PEM goes to a temporary file in the same directory (0600, O_EXCL), is flushed to disk, and is then linked
// at `path`. link(2) is atomic and fails with EEXIST where rename(2) would replace, so whoever links first wins and the
// other uses that key. The temporary name goes either way, and the directory is flushed so the new name survives a
// power cut. False when a key (or anything) was already at `path`.
function writeKeyOnce(path: string, pem: string): boolean {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  let open = true;
  try {
    writeSync(fd, pem);
    fsyncSync(fd);
    closeSync(fd);
    open = false;
    try { linkSync(tmp, path); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
    const d = openSync(dir, "r");
    try { fsyncSync(d); } finally { closeSync(d); }
    return true;
  } finally {
    if (open) closeSync(fd);
    rmSync(tmp, { force: true });
  }
}

function read(path: string): KeyObject {
  let st;
  try { st = statSync(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new KeyFileUnreadable(`${path} is missing or a link to nothing; restore the fleet's key there (every node pins it), or remove the link`);
    throw e;
  }
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) throw new KeyFileUnsafe(`${path} has mode ${mode.toString(8)}; it must be readable by its owner only (chmod 600)`);
  try { return createPrivateKey(readFileSync(path)); }
  catch { throw new KeyFileUnreadable(`${path} is not a readable private key (corrupt or half written); restore the fleet's key there (every node pins it)`); }
}

// The key at `path`, created on first use (mode 0600, its directory 0700). A key file anyone but its owner can read is
// refused, never used: a node trusts whatever holds it. So is one that can't be read as an Ed25519 private key.
export function loadOrCreateFleetKey(path: string): FleetKey {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let privateKey: KeyObject | null = null;
  if (!existsSync(path)) {
    const created = generateKeyPairSync("ed25519").privateKey;
    if (writeKeyOnce(path, created.export({ type: "pkcs8", format: "pem" }).toString())) privateKey = created;   // else another process's
  }
  privateKey ??= read(path);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new KeyFileUnreadable(`${path} holds a ${privateKey.asymmetricKeyType ?? "unknown"} key, not Ed25519`);
  const key = privateKey;
  return {
    publicKey: createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64"),
    sign: payload => sign(null, Buffer.from(payload, "utf8"), key).toString("base64"),
  };
}

// A node's public key as it arrives in `join`: an Ed25519 SPKI DER key in base64, or null.
export function parsePublicKey(spkiBase64: string): KeyObject | null {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch { return null; }
}

// Whether `sigBase64` is the holder of `spkiBase64`'s signature over `payload`. Anything malformed is false, never a throw.
export function verifySig(spkiBase64: string, payload: string, sigBase64: string): boolean {
  const key = parsePublicKey(spkiBase64);
  if (!key) return false;
  try { return verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(sigBase64, "base64")); } catch { return false; }
}
