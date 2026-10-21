// Signed Claude Code releases (T-346): a manifest is admitted only with a good signature by the trusted key, and a binary only
// when its sha256 is in such a manifest. The real signed manifest of 2.1.306 is a fixture (a public file, byte for byte as
// https://downloads.claude.ai/claude-code-releases/2.1.306/ serves it, read 2026-10-21); other keys are made here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessage, generateKey, readKey, sign } from "openpgp";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_RELEASE_FINGERPRINT, CLAUDE_RELEASE_PUBLIC_KEY } from "../src/adapters/claude-release-key.ts";
import {
  COMPILED_TRUST, compareVersions, installedVersions, isVersion, parseReleasePin, releaseAdmits, releaseCacheDir, releaseKey, syncReleases, verifyManifest,
  type Fetch, type Trust,
} from "../src/adapters/release-manifest.ts";

const fixtures = join(import.meta.dirname, "fixtures/claude-release");
const MANIFEST = readFileSync(join(fixtures, "2.1.306.manifest.json"));
const SIGNATURE = readFileSync(join(fixtures, "2.1.306.manifest.json.sig"));
const LINUX_X64 = "520bc6c1f40af466bd03a278b5ae1af1a2938bc7de5b9e5cb15526da20d71cfe";   // linux-x64 in that manifest
const AT = new Date("2026-10-22T00:00:00Z");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), "morndo-releases-")); dirs.push(dir); return dir; };

// A key of our own, and a manifest for `version` signed by it.
async function ownKey(): Promise<{ trust: Trust; sign: (data: Uint8Array) => Promise<Uint8Array> }> {
  const made = await generateKey({ type: "curve25519", userIDs: [{ name: "Test Release Signing", email: "release@example.test" }], format: "object" });
  const armoredKey = made.publicKey.armor();
  return {
    trust: { armoredKey, fingerprint: made.publicKey.getFingerprint() },
    sign: async data => sign({ message: await createMessage({ binary: data }), signingKeys: made.privateKey, detached: true, format: "binary" }) as Promise<Uint8Array>,
  };
}
const manifestFor = (version: string, checksums: Record<string, string>): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ version, platforms: Object.fromEntries(Object.entries(checksums).map(([name, checksum]) => [name, { binary: "claude", checksum, size: 1 }])) }, null, 2));
const SUM = "ab".repeat(32);

describe("the compiled-in release key", () => {
  it("is the key whose fingerprint Anthropic's docs give, and nothing else is trusted", async () => {
    expect(CLAUDE_RELEASE_FINGERPRINT.toUpperCase()).toBe("31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE");   // https://code.claude.com/docs/en/setup
    expect((await readKey({ armoredKey: CLAUDE_RELEASE_PUBLIC_KEY })).getFingerprint()).toBe(CLAUDE_RELEASE_FINGERPRINT);
    expect(await releaseKey()).not.toBeNull();
    expect(await releaseKey({ armoredKey: CLAUDE_RELEASE_PUBLIC_KEY, fingerprint: "0".repeat(40) })).toBeNull();   // bytes of another key than the trusted one
    expect(await releaseKey({ armoredKey: (await ownKey()).trust.armoredKey, fingerprint: CLAUDE_RELEASE_FINGERPRINT })).toBeNull();
    expect(await releaseKey({ armoredKey: "not a key", fingerprint: CLAUDE_RELEASE_FINGERPRINT })).toBeNull();
  });
});

describe("verifying a manifest", () => {
  it("admits the real signed manifest of 2.1.306 under the compiled-in key", async () => {
    const verified = await verifyManifest(MANIFEST, SIGNATURE, "2.1.306", COMPILED_TRUST, AT);
    expect(verified.ok).toBe(true);
    expect(verified.ok && verified.checksums).toContain(LINUX_X64);
    expect(verified.ok && verified.checksums).toHaveLength(8);
  });

  it("refuses a manifest changed by one byte, and a signature changed by one byte", async () => {
    const manifest = Buffer.from(MANIFEST);
    const digit = manifest.indexOf(Buffer.from(LINUX_X64)) + 3;
    manifest[digit] = (manifest[digit] ?? 0) ^ 1;                                       // one digit of a checksum
    expect(await verifyManifest(manifest, SIGNATURE, "2.1.306", COMPILED_TRUST, AT)).toMatchObject({ ok: false, why: "the manifest signature is not good" });
    const signature = Buffer.from(SIGNATURE);
    signature[400] = (signature[400] ?? 0) ^ 1;                                         // inside the armored body (the file is ASCII armor: a byte of its footer changes nothing, for gpg too)
    expect(await verifyManifest(MANIFEST, signature, "2.1.306", COMPILED_TRUST, AT)).toMatchObject({ ok: false });
    expect(await verifyManifest(MANIFEST, new Uint8Array(), "2.1.306", COMPILED_TRUST, AT)).toMatchObject({ ok: false });
  });

  it("refuses a manifest signed by another key, and a manifest whose key is not the trusted fingerprint", async () => {
    const other = await ownKey();
    const manifest = manifestFor("2.1.999", { "linux-x64": SUM });
    const signature = await other.sign(manifest);
    expect(await verifyManifest(manifest, signature, "2.1.999", other.trust, AT)).toMatchObject({ ok: true });          // the machinery works with its own key
    expect(await verifyManifest(manifest, signature, "2.1.999", COMPILED_TRUST, AT)).toMatchObject({ ok: false, why: "the manifest signature is not good" });   // wrong key
    expect(await verifyManifest(manifest, signature, "2.1.999", { armoredKey: other.trust.armoredKey, fingerprint: CLAUDE_RELEASE_FINGERPRINT }, AT)).toMatchObject({ ok: false, why: "the release key is not the trusted one" });
  });

  it("refuses a good signature on a manifest for another version, with no checksum, or that is not JSON", async () => {
    const own = await ownKey();
    const sign = async (bytes: Uint8Array) => ({ bytes, signature: await own.sign(bytes) });
    const other = await sign(manifestFor("2.1.998", { "linux-x64": SUM }));
    expect(await verifyManifest(other.bytes, other.signature, "2.1.999", own.trust, AT)).toMatchObject({ ok: false, why: "the manifest is for another version" });
    const empty = await sign(manifestFor("2.1.999", {}));
    expect(await verifyManifest(empty.bytes, empty.signature, "2.1.999", own.trust, AT)).toMatchObject({ ok: false, why: "the manifest lists no checksum" });
    const junk = await sign(manifestFor("2.1.999", { "linux-x64": "not-a-checksum" }));
    expect(await verifyManifest(junk.bytes, junk.signature, "2.1.999", own.trust, AT)).toMatchObject({ ok: false });
    const text = await sign(new TextEncoder().encode("not json"));
    expect(await verifyManifest(text.bytes, text.signature, "2.1.999", own.trust, AT)).toMatchObject({ ok: false, why: "the manifest is not JSON" });
  });

  it("knows no signed release before 2.1.89, and judges the key at the date asked", async () => {
    expect(await verifyManifest(MANIFEST, SIGNATURE, "2.1.88", COMPILED_TRUST, AT)).toMatchObject({ ok: false, why: "no signed release of that version" });
    expect(await verifyManifest(MANIFEST, SIGNATURE, "../2.1.306", COMPILED_TRUST, AT)).toMatchObject({ ok: false });
    expect(await verifyManifest(MANIFEST, SIGNATURE, "2.1.306", COMPILED_TRUST, new Date("2025-01-01T00:00:00Z"))).toMatchObject({ ok: false });   // the key did not exist yet
  });
});

describe("the cache the lease reads", () => {
  function cached(version = "2.1.306", manifest: Uint8Array = MANIFEST, signature: Uint8Array = SIGNATURE): string {
    const home = tmp();
    mkdirSync(join(releaseCacheDir(home), version), { recursive: true });
    writeFileSync(join(releaseCacheDir(home), version, "manifest.json"), manifest);
    writeFileSync(join(releaseCacheDir(home), version, "manifest.json.sig"), signature);
    return home;
  }

  it("admits a binary whose sha256 a cached, verified manifest lists", async () => {
    expect(await releaseAdmits(cached(), "2.1.306", LINUX_X64, COMPILED_TRUST, AT)).toEqual({ ok: true });
  });

  it("refuses a checksum that is not listed, a version with no cache, and a name that is not a version", async () => {
    expect(await releaseAdmits(cached(), "2.1.306", "0".repeat(64), COMPILED_TRUST, AT)).toMatchObject({ ok: false, why: "the binary's sha256 is not in the signed manifest" });
    expect(await releaseAdmits(tmp(), "2.1.306", LINUX_X64, COMPILED_TRUST, AT)).toMatchObject({ ok: false, why: "no cached manifest for that version" });
    expect(await releaseAdmits(cached(), "2.1.305", LINUX_X64, COMPILED_TRUST, AT)).toMatchObject({ ok: false });
    expect(await releaseAdmits(cached(), "../../etc", LINUX_X64, COMPILED_TRUST, AT)).toMatchObject({ ok: false });
  });

  it("verifies the cache again: a manifest planted in it, with its checksum added, proves nothing", async () => {
    const planted = Buffer.from(MANIFEST.toString("utf8").replace(LINUX_X64, "f".repeat(64)));
    expect(await releaseAdmits(cached("2.1.306", planted), "2.1.306", "f".repeat(64), COMPILED_TRUST, AT)).toMatchObject({ ok: false, why: "the manifest signature is not good" });
  });
});

describe("the node job that fills the cache", () => {
  const serve = (files: Record<string, Uint8Array>): { fetch: Fetch; calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      fetch: async url => {
        calls.push(url);
        const body = files[url];
        if (body === undefined) throw new Error("HTTP 404");
        return body;
      },
    };
  };
  const real = { "https://downloads.claude.ai/claude-code-releases/2.1.306/manifest.json": MANIFEST, "https://downloads.claude.ai/claude-code-releases/2.1.306/manifest.json.sig": SIGNATURE };

  it("fetches a version that is not cached, verifies it and writes it; the next run leaves it alone", async () => {
    const home = tmp();
    const server = serve(real);
    expect(await syncReleases({ home, versions: ["2.1.306"], fetch: server.fetch, at: AT })).toEqual([{ version: "2.1.306", status: "fetched" }]);
    expect(readFileSync(join(releaseCacheDir(home), "2.1.306", "manifest.json"))).toEqual(MANIFEST);
    expect(readdirSync(releaseCacheDir(home))).toEqual(["2.1.306"]);                    // no staging directory left
    expect(await releaseAdmits(home, "2.1.306", LINUX_X64, COMPILED_TRUST, AT)).toEqual({ ok: true });
    const again = serve(real);
    expect(await syncReleases({ home, versions: ["2.1.306"], fetch: again.fetch, at: AT })).toEqual([{ version: "2.1.306", status: "cached" }]);
    expect(again.calls).toEqual([]);                                                    // a verified cache costs no request
  });

  it("a fetch that fails leaves the old cache as it was, and the other versions still run", async () => {
    const home = tmp();
    mkdirSync(join(releaseCacheDir(home), "2.1.305"), { recursive: true });
    writeFileSync(join(releaseCacheDir(home), "2.1.305", "manifest.json"), "an old, unverifiable cache entry");
    const results = await syncReleases({ home, versions: ["2.1.305", "2.1.306"], fetch: serve(real).fetch, at: AT });
    expect(results).toEqual([{ version: "2.1.305", status: "failed", why: "HTTP 404" }, { version: "2.1.306", status: "fetched" }]);
    expect(readFileSync(join(releaseCacheDir(home), "2.1.305", "manifest.json"), "utf8")).toBe("an old, unverifiable cache entry");
    const down: Fetch = async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:443"); };
    expect(await syncReleases({ home, versions: ["2.1.304"], fetch: down, at: AT })).toEqual([{ version: "2.1.304", status: "failed", why: "fetch failed" }]);   // no address in the word
    expect(readdirSync(releaseCacheDir(home)).sort()).toEqual(["2.1.305", "2.1.306"]);
  });

  it("writes nothing for a manifest whose signature is not good", async () => {
    const home = tmp();
    const bad = serve({ ...real, "https://downloads.claude.ai/claude-code-releases/2.1.306/manifest.json": Buffer.from(MANIFEST.toString("utf8").replace(LINUX_X64, "f".repeat(64))) });
    expect(await syncReleases({ home, versions: ["2.1.306"], fetch: bad.fetch, at: AT })).toEqual([{ version: "2.1.306", status: "failed", why: "the manifest signature is not good" }]);
    expect(existsSync(releaseCacheDir(home)) ? readdirSync(releaseCacheDir(home)) : []).toEqual([]);
  });

  it("replaces a cache entry that no longer verifies, once the fetched one does", async () => {
    const home = tmp();
    mkdirSync(join(releaseCacheDir(home), "2.1.306"), { recursive: true });
    writeFileSync(join(releaseCacheDir(home), "2.1.306", "manifest.json"), "damaged");
    writeFileSync(join(releaseCacheDir(home), "2.1.306", "manifest.json.sig"), "damaged");
    expect(await syncReleases({ home, versions: ["2.1.306"], fetch: serve(real).fetch, at: AT })).toEqual([{ version: "2.1.306", status: "fetched" }]);
    expect(await releaseAdmits(home, "2.1.306", LINUX_X64, COMPILED_TRUST, AT)).toEqual({ ok: true });
  });
});

describe("versions and the owner's pin", () => {
  it("orders versions as numbers, and lists the installed ones from the floor up", () => {
    expect(compareVersions("2.1.306", "2.1.89")).toBeGreaterThan(0);
    expect(compareVersions("2.1.89", "2.1.89")).toBe(0);
    expect(compareVersions("2.0.999", "2.1.0")).toBeLessThan(0);
    expect(isVersion("2.1.306") && !isVersion("2.1") && !isVersion("2.1.306-beta") && !isVersion("../2.1.306")).toBe(true);
    const dir = tmp();
    for (const name of ["2.1.88", "2.1.89", "2.1.305", "2.1.306", "2.1.307.tmp", "latest"]) writeFileSync(join(dir, name), "");
    expect(installedVersions(dir, "2.1.89")).toEqual(["2.1.89", "2.1.305", "2.1.306"]);
    expect(installedVersions(dir, "2.1.306")).toEqual(["2.1.306"]);
    expect(installedVersions(join(dir, "missing"), "2.1.89")).toEqual([]);
  });

  it("reads a release pin only whole, with a floor of 2.1.89 or more", () => {
    const pin = { fingerprint: CLAUDE_RELEASE_FINGERPRINT, versionsDir: "/versions", floor: "2.1.300", baseUrls: { zai: "https://api.example.test/anthropic" } };
    expect(parseReleasePin(JSON.stringify(pin))).toEqual(pin);
    expect(parseReleasePin(JSON.stringify({ ...pin, floor: "2.1.88" }))).toBeNull();
    expect(parseReleasePin(JSON.stringify({ ...pin, floor: "latest" }))).toBeNull();
    expect(parseReleasePin(JSON.stringify({ ...pin, baseUrls: { zai: 5 } }))).toBeNull();
    expect(parseReleasePin(JSON.stringify({ versionsDir: "/versions", floor: "2.1.300", baseUrls: {} }))).toBeNull();
    expect(parseReleasePin("not json")).toBeNull();
    expect(parseReleasePin(null)).toBeNull();
  });
});
