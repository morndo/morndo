// SSH signatures, one namespace per role (design §10.1, PROTOCOL.sshsig). The private key stays
// in the caller's 0600 file; this only runs ssh-keygen, which is what the first install uses too.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RELEASE_NAMESPACE = "release@morndo.github.io";
export const FEED_NAMESPACE = "feed@morndo.github.io";

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
