// Web Push for the hub (ADR-0008 phase F), on node:crypto only: the payload encrypted as RFC 8291 says (aes128gcm,
// one record), and the hub identified to the push service as RFC 8292 says (VAPID: an ES256 JWT and its P-256 key).
// Checked against both RFCs' own examples (webpush.test.ts). The VAPID key lives in the data dir, readable by this OS
// user only. We wrote our own instead of the `web-push` package (MPL-2.0, last published 2024-01-16): see ADR-0008.
import { createECDH, createCipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reasonCode } from "@morndo/domain";

export type PushSubscription = { endpoint: string; p256dh: string; auth: string };   // as the browser gave them, base64url
export type PushOptions = { ttlSeconds: number; topic: string; urgency: "very-low" | "low" | "normal" | "high" };
// What the push service said: its status, or 0 when it couldn't be reached; and for a refusal its reason code, where it
// gives one (Apple answers {"reason":"BadJwtToken"}). Only a short code is kept, never free text.
export type PushResult = { status: number; reason?: string };
export type PushSender = (s: PushSubscription, payload: Buffer, o: PushOptions) => Promise<PushResult>;
// A status of our own: the subscription's key can't be used (not a point on P-256): it can never be sent to.
export const UNUSABLE_KEY = -1;

// A browser's p256dh: 65 bytes, uncompressed, and a point on P-256 (a key that isn't would throw at encryption;
// review H1).
export function isP256Point(raw: Buffer): boolean {
  if (raw.length !== 65 || raw[0] !== 4) return false;
  try { publicKeyObject(raw); return true; } catch { return false; }
}

const RECORD_SIZE = 4096;

// RFC 8291 section 3: the user agent's key and secret, an ephemeral key of ours and a random salt give the content
// key and nonce; one record, its plaintext ended by the 0x02 delimiter; the header names the salt, the record size
// and our ephemeral public key. `ephemeral` and `salt` come in only from the RFC's example.
export function encryptPayload(p: { plaintext: Buffer; uaPublic: Buffer; authSecret: Buffer; salt?: Buffer; ephemeral?: Buffer }): Buffer {
  if (p.uaPublic.length !== 65 || p.uaPublic[0] !== 4) throw new Error("p256dh is not an uncompressed P-256 point");
  if (p.authSecret.length !== 16) throw new Error("auth is not 16 bytes");
  // RFC 8291 section 4: 4096 octets in all, so at most 3993 of plaintext after the 86-octet header, the 16-octet tag
  // and the delimiter (review L6).
  if (p.plaintext.length > 3993) throw new Error("payload too large for one record");
  const salt = p.salt ?? randomBytes(16);
  const ecdh = createECDH("prime256v1");
  if (p.ephemeral) ecdh.setPrivateKey(p.ephemeral); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(p.uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), p.uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, p.authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([p.plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, sealed]);
}

const json64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const publicKeyObject = (raw: Buffer): KeyObject => createPublicKey({
  key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33, 65).toString("base64url") }, format: "jwk",
});

// RFC 8292: verify a VAPID JWT against its key (for our tests and the RFC's example).
export function verifyVapidJwt(jwt: string, publicKey: Buffer): boolean {
  const [h, c, s] = jwt.split(".");
  if (!h || !c || !s) return false;
  return verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKeyObject(publicKey), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
}

export type Vapid = {
  publicKey: Buffer;                                       // 65 bytes, uncompressed: what the browser subscribes with
  authorization(endpoint: string, now: number): string;    // the Authorization header value for a push to `endpoint`
};

const VAPID_TTL_S = 12 * 3600;            // RFC 8292: exp at most 24 hours ahead; we use 12
const VAPID_REFRESH_S = 3600;             // reused until an hour is left (Apple: don't refresh more than once an hour)

// The hub's VAPID key, made once into the data dir (mode 0600), and a JWT per push service origin, reused while it
// has more than an hour left. `sub` is a contact URI the push service may use (RFC 8292 section 2.1).
export function loadOrCreateVapid(dataDir: string, sub: string): Vapid {
  const file = join(dataDir, "push-vapid.pem");
  if (!existsSync(file)) {
    const fresh = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    // "wx": a hub and a console command starting together make it once; the other reads that one (review L8).
    try { writeFileSync(file, fresh.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);   // readable by this OS user only, whoever made it
  const privateKey: KeyObject = createPrivateKey(readFileSync(file));
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x ?? "", "base64url"), Buffer.from(jwk.y ?? "", "base64url")]);
  if (publicKey.length !== 65) throw new Error("unexpected P-256 public key length");
  const tokens = new Map<string, { jwt: string; exp: number }>();
  return {
    publicKey,
    authorization(endpoint, now) {
      const aud = new URL(endpoint).origin;
      const s = Math.floor(now / 1000);
      let t = tokens.get(aud);
      if (!t || t.exp - s < VAPID_REFRESH_S) {
        const exp = s + VAPID_TTL_S;
        const input = `${json64({ typ: "JWT", alg: "ES256" })}.${json64({ aud, exp, sub })}`;
        const signature = sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" });
        t = { jwt: `${input}.${signature.toString("base64url")}`, exp };
        tokens.set(aud, t);
      }
      return `vapid t=${t.jwt}, k=${publicKey.toString("base64url")}`;
    },
  };
}

// Push services we send to, by host: Chrome's, Firefox's, Safari's and Edge's. Anything else is refused at subscribe,
// so a session can't make the hub post to an address of its choosing.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];
export function isPushService(endpoint: string, extra: readonly string[] = []): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (extra.includes(u.origin)) return true;                            // a test's own push service
  return u.protocol === "https:" && u.port === "" && PUSH_HOSTS.some(h => h.test(u.hostname));
}

// RFC 8030 section 5: one POST to the subscription's push resource, its payload encrypted, VAPID in the header.
export function pushSender(vapid: Vapid, now: () => number = Date.now, timeoutMs = 10_000): PushSender {
  return async (s, payload, o) => {
    let body: Buffer;
    try { body = encryptPayload({ plaintext: payload, uaPublic: Buffer.from(s.p256dh, "base64url"), authSecret: Buffer.from(s.auth, "base64url") }); }
    catch { return { status: UNUSABLE_KEY }; }
    try {
      const res = await fetch(s.endpoint, {
        method: "POST",
        headers: {
          TTL: String(o.ttlSeconds), Topic: o.topic, Urgency: o.urgency, "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream", Authorization: vapid.authorization(s.endpoint, now()),
        },
        body, signal: AbortSignal.timeout(timeoutMs), redirect: "error",
      });
      if (res.ok) { await res.arrayBuffer().catch(() => null); return { status: res.status }; }
      const reason = await refusalReason(res).catch(() => undefined);
      return reason === undefined ? { status: res.status } : { status: res.status, reason };
    } catch {
      return { status: 0 };
    }
  };
}

const MAX_REFUSAL_BYTES = 4096;

// The `reason` of a refusal's JSON body, if it is a short code (the domain's `reasonCode`). A larger or different answer
// is read no further and gives nothing. The sender's timeout covers this read too.
async function refusalReason(res: Response): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_REFUSAL_BYTES) { await reader.cancel().catch(() => null); return undefined; }
    parts.push(value);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { return undefined; }
  return reasonCode((body as { reason?: unknown } | null)?.reason);
}
