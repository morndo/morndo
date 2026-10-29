// Web Push on node:crypto (ADR-0008 phase F): RFC 8291's encryption gives exactly the bytes of the RFC's own example;
// RFC 8292's example JWT verifies with our verifier; our own JWT verifies with our key and carries the claims the RFC
// asks for (aud the push service's origin, exp at most 24 hours ahead, sub); a user agent decrypts what we send; only
// the known push services are accepted; and the sender posts what RFC 8030 says. No real network: a local server.
import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPushContact, loadConfig } from "../src/config.ts";
import { UNUSABLE_KEY, encryptPayload, isP256Point, isPushService, loadOrCreateVapid, pushSender, verifyVapidJwt } from "../src/adapters/webpush.ts";

// The hub command is waited for until it exits by itself: how long a cold start of the whole hub takes depends on the load
// of the box (about 1 s idle, 10 to 30 s with the load average above 70), so no time is a pass criterion. The guard only ends
// a command that never exits (a hub that began serving would not), with what it had printed.
const HUB_EXIT_GUARD_MS = 120_000;
function runToExit(main: string, command: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--no-warnings", main, command], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    const guard = setTimeout(() => {
      stderr += `\n(the test ended it: no exit within ${HUB_EXIT_GUARD_MS / 1000} s)`;
      child.kill("SIGKILL");
    }, HUB_EXIT_GUARD_MS);
    child.on("close", status => { clearTimeout(guard); resolve({ status, stdout, stderr }); });
  });
}

const u = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "base64url");
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-push-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The user agent's side of RFC 8291, for the round trip: its key and secret open what we sealed.
function decrypt(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16), idlen = body.readUInt8(20), asPublic = body.subarray(21, 21 + idlen), sealed = body.subarray(21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync("sha256", secret, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const padded = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  expect(padded.at(-1)).toBe(2);                                        // the last record's delimiter
  return padded.subarray(0, padded.length - 1);
}

describe("RFC 8291 encryption", () => {
  it("gives exactly the RFC's example (section 5, appendix A)", () => {
    const body = encryptPayload({
      plaintext: Buffer.from("When I grow up, I want to be a watermelon"),
      uaPublic: u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
      authSecret: u("BTBZMqHH6r4Tts7J_aSIgg"),
      salt: u("DGv6ra1nlYgDCS1FRnbzlw"),
      ephemeral: u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
    });
    expect(body.toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
      "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
      "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
  });
  it("a user agent opens what we send with a fresh key and salt each time", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const plaintext = Buffer.from(JSON.stringify({ kind: 0, decisions: 2, workers: 1, linked: 0 }));
    const a = encryptPayload({ plaintext, uaPublic: ua.getPublicKey(), authSecret: auth });
    const b = encryptPayload({ plaintext, uaPublic: ua.getPublicKey(), authSecret: auth });
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, ua.getPrivateKey(), ua.getPublicKey(), auth).toString()).toBe(plaintext.toString());
    expect(() => decrypt(a, ua.getPrivateKey(), ua.getPublicKey(), Buffer.alloc(16, 8))).toThrow();   // another secret: no
  });
  it("refuses a key or secret of the wrong shape, and a payload over one record", () => {
    const ua = createECDH("prime256v1"); ua.generateKeys();
    expect(() => encryptPayload({ plaintext: Buffer.from("x"), uaPublic: ua.getPublicKey().subarray(1), authSecret: Buffer.alloc(16) })).toThrow(/P-256/);
    expect(() => encryptPayload({ plaintext: Buffer.from("x"), uaPublic: ua.getPublicKey(), authSecret: Buffer.alloc(15) })).toThrow(/16 bytes/);
    expect(() => encryptPayload({ plaintext: Buffer.alloc(3994), uaPublic: ua.getPublicKey(), authSecret: Buffer.alloc(16) })).toThrow(/too large/);
    // RFC 8291 section 4's limit exactly: 3993 octets make a 4096-octet body (review L6).
    expect(encryptPayload({ plaintext: Buffer.alloc(3993), uaPublic: ua.getPublicKey(), authSecret: Buffer.alloc(16) })).toHaveLength(4096);
  });
});

describe("RFC 8292 VAPID", () => {
  it("the RFC's example JWT verifies with its key, and a changed one doesn't", () => {
    const jwt = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA";
    const k = u("BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs");
    expect(verifyVapidJwt(jwt, k)).toBe(true);
    expect(verifyVapidJwt(jwt.replace("eyJhdWQi", "eyJhdWRi"), k)).toBe(false);
  });
  it("our key is made once, mode 0600; our JWT verifies with it and carries aud, exp at most 24 h ahead, and sub", () => {
    const v = loadOrCreateVapid(dir, "mailto:owner@example.test");
    expect(statSync(join(dir, "push-vapid.pem")).mode & 0o777).toBe(0o600);
    expect(loadOrCreateVapid(dir, "mailto:owner@example.test").publicKey.equals(v.publicKey)).toBe(true);
    const now = Date.UTC(2026, 9, 2, 12);
    const header = v.authorization("https://fcm.googleapis.com/fcm/send/abc", now);
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(m?.[2]).toBe(v.publicKey.toString("base64url"));
    const jwt = m?.[1] ?? "";
    expect(verifyVapidJwt(jwt, v.publicKey)).toBe(true);
    const [h, c] = jwt.split(".").slice(0, 2).map(x => JSON.parse(Buffer.from(x, "base64url").toString()) as Record<string, unknown>);
    expect(h).toEqual({ typ: "JWT", alg: "ES256" });
    expect(c).toEqual({ aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 3600, sub: "mailto:owner@example.test" });
    expect((c?.exp as number) - now / 1000).toBeLessThanOrEqual(24 * 3600);
  });
  it("the contact sent to push services never names the hub's own host, and is one they accept (review L2)", () => {
    // Apple's push service answered 403 BadJwtToken for a contact on a special-use name (2026-10-03): the old default
    // "mailto:push@morndo.invalid", and also ".test" and "https://localhost". It accepted these two forms.
    expect(loadConfig({ MORNDO_ORIGIN: "https://hub.example.test" }).pushContact).toBe("https://morndo.com");
    expect(loadConfig({ MORNDO_ORIGIN: "https://hub.example.test", MORNDO_PUSH_CONTACT: "mailto:me@example.com" }).pushContact).toBe("mailto:me@example.com");
    expect(loadConfig({ MORNDO_ORIGIN: "https://hub.example.test", MORNDO_PUSH_CONTACT: "https://example.org/contact" }).pushContact).toBe("https://example.org/contact");
  });
  it("a contact a push service would refuse is told apart, form by form", () => {
    for (const bad of ["mailto:push@morndo.invalid", "mailto:me@example.test", "https://morndo.invalid", "https://localhost", "https://hub.example", "mailto:me@box.local",
      "https://intranet", "https://192.168.1.5", "mailto:me@[127.0.0.1]", "https://[::1]",                                     // a single label, an address
      "mailto:push@morndo.invalid?subject=x", "mailto:push@morndo.invalid.", "https://morndo.invalid.", "https://localhost.", "https://morndo.com.",   // a query, a trailing dot
      " https://morndo.com", "https://morndo.com\n", "mailto: me@example.com", "https://user:secret@morndo.com",              // spaces, a login
      "https://a..b", "mailto:a@.com", "mailto:a@-x.com", "https://morndo.com\u200b", "https://morndo.com\\@evil.invalid", "https://:@morndo.com", "https://@morndo.com",   // empty labels, hidden characters, a login in disguise
      "https://hub.onion", "https://box.internal", "https://router.home.arpa", "mailto:me@x.alt",                              // more special-use names
      "http://morndo.com", "HTTPS://morndo.com", "MAILTO:me@example.com", "push@morndo.com", "mailto:nobody", "ftp://morndo.com", "not a contact", ""]) {
      expect(isPushContact(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const ok of ["https://morndo.com", "https://Morndo.com/contact", "https://xn--mnchen-3ya.de", "mailto:me@example.com", "mailto:first.last+push@mail.example.org"]) {
      expect(isPushContact(ok), ok).toBe(true);
    }
  });
  it("the hub won't serve with such a contact: one sentence, exit 78, and the console commands still work (review L6)", async () => {
    const main = join(import.meta.dirname, "../src/main.ts");
    const env = { ...process.env, MORNDO_HOME: dir, MORNDO_TMUX_SOCKET: "morndo-test-none", MORNDO_PUSH_CONTACT: "mailto:me@box.local" };
    expect(loadConfig(env).pushContact).toBe("mailto:me@box.local");                    // reading the settings never throws for it
    const serve = await runToExit(main, "serve", env);
    expect(serve.status).toBe(78);                                                       // EX_CONFIG, as for a database from a newer hub
    expect(serve.stderr).toMatch(/MORNDO_PUSH_CONTACT.*https URL or a mailto address/s);
    expect(serve.stderr).not.toMatch(/\n\s+at /);                                       // a message, not a stack trace
    const devices = await runToExit(main, "devices", env);
    expect(devices.status, devices.stderr).toBe(0);
  }, HUB_EXIT_GUARD_MS * 2 + 30_000);
  it("a key file someone else made is read, not replaced, and made private (review L8)", () => {
    const first = loadOrCreateVapid(dir, "mailto:push@morndo.invalid");
    chmodSync(join(dir, "push-vapid.pem"), 0o644);
    const second = loadOrCreateVapid(dir, "mailto:push@morndo.invalid");
    expect(second.publicKey.equals(first.publicKey)).toBe(true);
    expect(statSync(join(dir, "push-vapid.pem")).mode & 0o777).toBe(0o600);
  });
  it("one JWT per push service, reused until an hour is left", () => {
    const v = loadOrCreateVapid(dir, "mailto:owner@example.test");
    const now = Date.UTC(2026, 9, 2, 12);
    const a = v.authorization("https://fcm.googleapis.com/x", now);
    expect(v.authorization("https://fcm.googleapis.com/y", now + 10 * 3600_000)).toBe(a);   // 2 h left: the same
    expect(v.authorization("https://fcm.googleapis.com/y", now + 11 * 3600_000 + 1000)).not.toBe(a);
    expect(v.authorization("https://web.push.apple.com/z", now)).not.toBe(a);              // another origin
  });
});

describe("push services", () => {
  it("accepts Chrome's, Firefox's, Safari's and Edge's, nothing else", () => {
    for (const ok of ["https://fcm.googleapis.com/fcm/send/a", "https://updates.push.services.mozilla.com/wpush/v2/a", "https://web.push.apple.com/a", "https://wns2-par02p.notify.windows.com/w/?token=a"]) expect(isPushService(ok), ok).toBe(true);
    for (const no of ["http://fcm.googleapis.com/a", "https://fcm.googleapis.com.evil.example/a", "https://fcm.googleapis.com:8443/a", "https://127.0.0.1/a", "https://localhost/a", "https://example.com/a", "not a url"]) expect(isPushService(no), no).toBe(false);
    expect(isPushService("http://127.0.0.1:9/push", ["http://127.0.0.1:9"])).toBe(true);
  });
});

describe("the sender (RFC 8030)", () => {
  it("keeps the push service's reason code for a refusal, and nothing else of its answer", async () => {
    let answer: { status: number; body: string } = { status: 403, body: '{"reason":"BadJwtToken"}' };
    const server = createServer((req, res) => { req.resume(); req.on("end", () => res.writeHead(answer.status, { "content-type": "application/json" }).end(answer.body)); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const ua = createECDH("prime256v1"); ua.generateKeys();
      const send = pushSender(loadOrCreateVapid(dir, "mailto:owner@example.com"));
      const sub = { endpoint: `http://127.0.0.1:${port}/push/abc`, p256dh: ua.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 3).toString("base64url") };
      const o = { ttlSeconds: 60, topic: "decision", urgency: "high" } as const;
      expect(await send(sub, Buffer.from("{}"), o)).toEqual({ status: 403, reason: "BadJwtToken" });     // Apple's form
      answer = { status: 400, body: '{"reason":"BadTtl","more":"ignored"}' };
      expect(await send(sub, Buffer.from("{}"), o)).toEqual({ status: 400, reason: "BadTtl" });
      // Anything that isn't a short code is dropped: free text, markup, a long or nested value, a body that isn't JSON.
      for (const body of ['{"reason":"the device said <b>no</b> to user 42"}', `{"reason":"${"A".repeat(65)}"}`, '{"reason":{"code":"X"}}', "<html>Forbidden</html>", "", "x".repeat(100_000)]) {
        answer = { status: 403, body };
        expect(await send(sub, Buffer.from("{}"), o), body.slice(0, 40)).toEqual({ status: 403 });
      }
      // The answer is read up to 4096 bytes: a code in a body of exactly that size is kept, one byte more and nothing is.
      const sized = (n: number) => { const head = '{"reason":"BadJwtToken","pad":"'; return `${head}${"x".repeat(n - head.length - 2)}"}`; };
      answer = { status: 403, body: sized(4096) };
      expect(await send(sub, Buffer.from("{}"), o)).toEqual({ status: 403, reason: "BadJwtToken" });
      answer = { status: 403, body: sized(4097) };
      expect(await send(sub, Buffer.from("{}"), o)).toEqual({ status: 403 });
      answer = { status: 201, body: '{"reason":"Ignored"}' };                                         // delivered: no reason kept
      expect(await send(sub, Buffer.from("{}"), o)).toEqual({ status: 201 });
    } finally { server.close(); }
  });
  it("a push service that never answers, or stops in the middle of its answer, is given up on after the timeout", async () => {
    let mode: "silent" | "stalls" = "silent";
    const server = createServer((req, res) => { req.resume(); req.on("end", () => { if (mode === "stalls") { res.writeHead(403, { "content-type": "application/json" }); res.write('{"reason":"Bad'); } }); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const ua = createECDH("prime256v1"); ua.generateKeys();
      const send = pushSender(loadOrCreateVapid(dir, "mailto:owner@example.com"), Date.now, 400);
      const sub = { endpoint: `http://127.0.0.1:${port}/push/abc`, p256dh: ua.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 3).toString("base64url") };
      const o = { ttlSeconds: 60, topic: "decision", urgency: "high" } as const;
      const started = performance.now();
      expect(await send(sub, Buffer.from("{}"), o)).toEqual({ status: 0 });                           // no answer at all
      mode = "stalls";
      expect(await send(sub, Buffer.from("{}"), o)).toEqual({ status: 403 });                         // the status came, the reason never did
      expect(performance.now() - started).toBeLessThan(5000);
    } finally { server.closeAllConnections(); server.close(); }
  });
  it("posts the encrypted payload with TTL, Topic, Urgency, aes128gcm and VAPID, and says what the service answered", async () => {
    const seen: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
    let status = 201;
    const server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (d: Buffer) => parts.push(d));
      req.on("end", () => { seen.push({ headers: req.headers, body: Buffer.concat(parts) }); res.writeHead(status).end(); });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const ua = createECDH("prime256v1"); ua.generateKeys();
      const auth = Buffer.alloc(16, 3);
      const send = pushSender(loadOrCreateVapid(dir, "mailto:owner@example.test"));
      const sub = { endpoint: `http://127.0.0.1:${port}/push/abc`, p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") };
      expect(await send(sub, Buffer.from('{"kind":1}'), { ttlSeconds: 3600, topic: "worker", urgency: "high" })).toEqual({ status: 201 });
      const h = seen[0]?.headers;
      expect([h?.ttl, h?.topic, h?.urgency, h?.["content-encoding"]]).toEqual(["3600", "worker", "high", "aes128gcm"]);
      expect(h?.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
      expect(decrypt(seen[0]?.body ?? Buffer.alloc(0), ua.getPrivateKey(), ua.getPublicKey(), auth).toString()).toBe('{"kind":1}');
      // A key of the right size that isn't a point on P-256: never thrown, said (review H1).
      const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]);
      expect(isP256Point(offCurve)).toBe(false);
      expect(isP256Point(ua.getPublicKey())).toBe(true);
      expect(await send({ ...sub, p256dh: offCurve.toString("base64url") }, Buffer.from("{}"), { ttlSeconds: 60, topic: "worker", urgency: "normal" })).toEqual({ status: UNUSABLE_KEY });
      status = 410;
      expect(await send(sub, Buffer.from("{}"), { ttlSeconds: 60, topic: "worker", urgency: "normal" })).toEqual({ status: 410 });
      expect(await send({ ...sub, endpoint: "http://127.0.0.1:9/nobody" }, Buffer.from("{}"), { ttlSeconds: 60, topic: "worker", urgency: "normal" })).toEqual({ status: 0 });
    } finally { server.close(); }
  });
});
