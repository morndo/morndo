// What the published rehearsal trusts before it runs anything from a downloaded release, the way install.sh does:
// the signature of manifest.json (ssh-keygen -Y verify against the README's signer line), then the archive's size and
// sha256 as that signed manifest gives them. SHA256SUMS is not signed and is not read. Host side only.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface ArchiveEntry { name: string; size: number; sha256: string }

/** Throws unless `sig` is a valid signature of `manifest` by a key in `signers` for `identity` (also the namespace, as install.sh uses it). */
export function verifyManifest(p: { manifest: string; sig: string; signers: string; identity: string }): void {
  let body: Buffer;
  try { body = readFileSync(p.manifest); } catch (e) { throw new Error(`the manifest cannot be read: ${(e as Error).message}`); }
  const done = spawnSync("ssh-keygen", ["-Y", "verify", "-f", p.signers, "-I", p.identity, "-n", p.identity, "-s", p.sig], { input: body, encoding: "utf8", timeout: 60_000 });
  if (done.status !== 0) {
    throw new Error(`the manifest's signature does not verify (ssh-keygen exit ${done.status}): ${`${done.stdout ?? ""}${done.stderr ?? ""}`.trim().split("\n").slice(0, 2).join(" | ")}`);
  }
}

/** The platform's entry of an already verified manifest. Throws on another version, no entry, more than one, or a malformed entry. */
export function archiveEntry(manifestText: string, version: string, platform: string, product = "morndo"): ArchiveEntry {
  let doc: unknown;
  try { doc = JSON.parse(manifestText); } catch { throw new Error("the manifest is not JSON"); }
  const m = doc as { version?: unknown; artifacts?: unknown };
  if (m.version !== version) throw new Error(`the manifest's version is ${JSON.stringify(m.version ?? null)}, not ${version}`);
  const all = Array.isArray(m.artifacts) ? m.artifacts as Record<string, unknown>[] : [];
  const mine = all.filter(a => a !== null && typeof a === "object" && a.platform === platform);
  if (mine.length === 0) throw new Error(`the manifest has no ${platform} artifact`);
  if (mine.length > 1) throw new Error(`the manifest has more than one ${platform} artifact`);
  const a = mine[0]!;
  const expectedName = `${product}-${version}-${platform}.tar.gz`;
  if (a.name !== expectedName) throw new Error(`the manifest's artifact name is ${JSON.stringify(a.name ?? null)}, not ${expectedName}`);
  if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) throw new Error("the manifest's artifact sha256 is not 64 hex digits");
  if (typeof a.size !== "number" || !Number.isInteger(a.size) || a.size <= 0) throw new Error("the manifest's artifact size is not a positive integer");
  return { name: a.name, size: a.size, sha256: a.sha256 };
}

/** Throws unless the file is exactly the size and sha256 the manifest gives. */
export function checkArchive(path: string, entry: ArchiveEntry): void {
  const bytes = readFileSync(path);
  if (bytes.length !== entry.size) throw new Error(`the archive's size ${bytes.length} is not the ${entry.size} the signed manifest gives: refusing`);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== entry.sha256) throw new Error(`the archive's sha256 ${actual} is not the ${entry.sha256} the signed manifest gives: refusing`);
}
