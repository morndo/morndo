// SSH signatures, one namespace per role (design §10.1, PROTOCOL.sshsig). The private key stays
// in the caller's 0600 file; this only runs ssh-keygen, which is what the first install uses too.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RELEASE_NAMESPACE = "release@morndo.github.io";
export const FEED_NAMESPACE = "feed@morndo.github.io";

export function allowedSignerLine(p: { identity: string; namespace: string; publicKey: string }): string {
  return `${p.identity} namespaces="${p.namespace}" ${p.publicKey}`;
}

export function signBytes(p: { bytes: Uint8Array; keyPath: string; namespace: string; dir: string }): Buffer {
  const payload = join(p.dir, `sign-${process.pid}-${Date.now()}`);
  const sig = `${payload}.sig`;
  writeFileSync(payload, p.bytes, { mode: 0o600 });
  const run = spawnSync("ssh-keygen", ["-Y", "sign", "-f", p.keyPath, "-n", p.namespace, payload], { encoding: "utf8" });
  try {
    if (run.status !== 0) throw new Error(`ssh-keygen -Y sign failed: ${run.stderr}`);
    return readFileSync(sig);
  } finally {
    rmSync(payload, { force: true });
    rmSync(sig, { force: true });
  }
}

export function verifyBytes(p: {
  bytes: Uint8Array; signature: Uint8Array; allowedSignersPath: string; identity: string; namespace: string;
}): void {
  const dir = mkdtempSync(join(tmpdir(), "morndo-verify-"));
  const payload = join(dir, "payload");
  const sig = join(dir, "payload.sig");
  try {
    writeFileSync(payload, p.bytes);
    writeFileSync(sig, p.signature);
    const run = spawnSync("ssh-keygen", [
      "-Y", "verify", "-f", p.allowedSignersPath, "-I", p.identity, "-n", p.namespace, "-s", sig,
    ], { input: p.bytes, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`ssh-keygen -Y verify failed: ${run.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
