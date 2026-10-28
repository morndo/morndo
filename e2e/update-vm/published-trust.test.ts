// The published rehearsal's trust chain (published-trust.ts): the Manifest's signature, then the archive named by it.
// A throwaway key made here signs made-up documents; ssh-keygen is the real one.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { archiveEntry, checkArchive, verifyManifest } from "./published-trust.ts";

const ID = "release@example.invalid";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const manifestOf = (over: { version?: string; artifacts?: unknown[] } = {}): string => JSON.stringify({
  schema: 1, product: "demo", version: over.version ?? "9.9.9",
  artifacts: over.artifacts ?? [
    { platform: "linux-arm64", name: "demo-9.9.9-linux-arm64.tar.gz", size: 3, sha256: "b".repeat(64) },
    { platform: "linux-x64", name: "demo-9.9.9-linux-x64.tar.gz", size: 5, sha256: "a".repeat(64) },
  ],
}, null, 2);

let dir: string;
let signers: string;
let otherSigners: string;
const signed = (name: string, text: string, key = join(dir, "key")): { manifest: string; sig: string } => {
  const manifest = join(dir, name);
  writeFileSync(manifest, text);
  const made = spawnSync("ssh-keygen", ["-Y", "sign", "-f", key, "-n", ID, manifest], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`ssh-keygen sign failed: ${made.stderr}`);
  return { manifest, sig: `${manifest}.sig` };
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "published-trust-"));
  for (const k of ["key", "other"]) {
    const made = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", k, "-f", join(dir, k)], { encoding: "utf8" });
    if (made.status !== 0) throw new Error(`ssh-keygen failed: ${made.stderr}`);
  }
  const line = (k: string) => `${ID} namespaces="${ID}" ${readFileSync(join(dir, `${k}.pub`), "utf8").trim()}\n`;
  signers = join(dir, "allowed_signers");
  otherSigners = join(dir, "other_signers");
  writeFileSync(signers, line("key"));
  writeFileSync(otherSigners, line("other"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("verifyManifest", () => {
  it("accepts a manifest signed by the README's key", () => {
    const f = signed("good.json", manifestOf());
    expect(() => verifyManifest({ ...f, signers, identity: ID })).not.toThrow();
  });
  it("refuses a manifest changed after signing", () => {
    const f = signed("tampered.json", manifestOf());
    writeFileSync(f.manifest, manifestOf({ artifacts: [{ platform: "linux-x64", name: "demo-9.9.9-linux-x64.tar.gz", size: 5, sha256: "c".repeat(64) }] }));
    expect(() => verifyManifest({ ...f, signers, identity: ID })).toThrow(/signature/);
  });
  it("refuses a manifest signed by another key", () => {
    const f = signed("other.json", manifestOf(), join(dir, "other"));
    expect(() => verifyManifest({ ...f, signers, identity: ID })).toThrow(/signature/);
    expect(() => verifyManifest({ ...f, signers: otherSigners, identity: ID })).not.toThrow();
  });
  it("refuses a missing signature file", () => {
    const f = signed("nosig.json", manifestOf());
    expect(() => verifyManifest({ manifest: f.manifest, sig: join(dir, "absent.sig"), signers, identity: ID })).toThrow(/signature/);
  });
});

describe("archiveEntry", () => {
  it("is the name, size and sha256 the manifest gives for the platform", () => {
    expect(archiveEntry(manifestOf(), "9.9.9", "linux-x64", "demo")).toEqual({ name: "demo-9.9.9-linux-x64.tar.gz", size: 5, sha256: "a".repeat(64) });
  });
  it("refuses another version than the one asked for", () => {
    expect(() => archiveEntry(manifestOf({ version: "9.9.8" }), "9.9.9", "linux-x64", "demo")).toThrow(/version/);
  });
  it("refuses a missing, repeated or oddly named platform entry, and a malformed hash or size", () => {
    expect(() => archiveEntry(manifestOf(), "9.9.9", "linux-riscv", "demo")).toThrow(/no linux-riscv/);
    const x = { platform: "linux-x64", name: "demo-9.9.9-linux-x64.tar.gz", size: 5, sha256: "a".repeat(64) };
    expect(() => archiveEntry(manifestOf({ artifacts: [x, x] }), "9.9.9", "linux-x64", "demo")).toThrow(/more than one/);
    expect(() => archiveEntry(manifestOf({ artifacts: [{ ...x, name: "../x.tar.gz" }] }), "9.9.9", "linux-x64", "demo")).toThrow(/name/);
    expect(() => archiveEntry(manifestOf({ artifacts: [{ ...x, sha256: "zz" }] }), "9.9.9", "linux-x64", "demo")).toThrow(/sha256/);
    expect(() => archiveEntry(manifestOf({ artifacts: [{ ...x, size: -1 }] }), "9.9.9", "linux-x64", "demo")).toThrow(/size/);
    expect(() => archiveEntry("not json", "9.9.9", "linux-x64", "demo")).toThrow(/manifest/);
  });
});

describe("checkArchive", () => {
  const bytes = Buffer.from("12345");
  const file = () => { const p = join(dir, "archive.bin"); writeFileSync(p, bytes); return p; };
  it("accepts the bytes the manifest describes", () => {
    expect(() => checkArchive(file(), { name: "x", size: 5, sha256: sha(bytes) })).not.toThrow();
  });
  it("refuses another size or another digest", () => {
    expect(() => checkArchive(file(), { name: "x", size: 6, sha256: sha(bytes) })).toThrow(/size/);
    expect(() => checkArchive(file(), { name: "x", size: 5, sha256: sha("other") })).toThrow(/sha256/);
  });
});
