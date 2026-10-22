// The SSH-signature verifier's contract (design §4.6 Verifier, §13 "Contract"): every case signs with the real
// ssh-keygen (OpenSSH 9.6p1 here) using throwaway keys made in a temporary directory, so the adapter is proved
// against the same tool the release pipeline and the first install sign and verify with (scripts/release/sign.ts,
// §10.3). No key or certificate is committed: everything is made at run time and removed in afterAll.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SshSigVerifier, fingerprintOfPublicKeyLine } from "../src/adapters/verifier-sshsig.ts";
import { FEED_NAMESPACE, KEYS_NAMESPACE, RELEASE_NAMESPACE } from "../src/application/namespaces.ts";

const verifier = new SshSigVerifier();
// The message stands for a signed document (keys.json, a manifest, a feed); binary bytes so nothing is lost in any layer.
const message = Buffer.from("morndo updater verifier contract\n\0\x01\xfftail");

let dir = "";
const path = (name: string) => join(dir, name);

const run = (args: string[], input?: Uint8Array) =>
  spawnSync("ssh-keygen", args, { encoding: "utf8", ...(input === undefined ? {} : { input: Buffer.from(input) }) });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-upd-"));
  for (const name of ["root", "release", "other"]) {
    const made = run(["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", path(name)]);
    expect(made.status, made.stderr).toBe(0);
  }
  const rsa = run(["-q", "-t", "rsa", "-b", "2048", "-N", "", "-f", path("rsa")]);
  expect(rsa.status, rsa.stderr).toBe(0);
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

// Signs `file` (made from `bytes`) and returns the .sig bytes. ssh-keygen appends to an existing .sig when stdin is
// not a terminal, so it is removed first to keep each signature single.
const sign = (key: string, namespace: string, bytes: Uint8Array, extra: string[] = []): Uint8Array => {
  const file = path(`msg-${key}-${namespace.replace(/[^a-z]/g, "")}-${extra.join("")}.txt`);
  writeFileSync(file, bytes);
  rmSync(`${file}.sig`, { force: true });
  const done = run(["-Y", "sign", "-f", path(key), "-n", namespace, ...extra, file]);
  expect(done.status, done.stderr).toBe(0);
  return readFileSync(`${file}.sig`);
};

// The fingerprint ssh-keygen itself prints, so "equals ssh-keygen's" is checked against the tool, not our own formula.
const sshKeygenFingerprint = (key: string): string => {
  const done = run(["-lf", path(`${key}.pub`)]);
  expect(done.status, done.stderr).toBe(0);
  return done.stdout.trim().split(/\s+/)[1]!;
};

describe("SshSigVerifier against real ssh-keygen", () => {
  it("accepts a good signature: valid, the signer's fingerprint, the stated namespace — and ssh-keygen accepts it too", () => {
    const signature = sign("release", RELEASE_NAMESPACE, message);
    const [fact] = verifier.signatures(message, signature);
    expect(fact).toBeDefined();
    expect(fact!.valid).toBe(true);
    expect(fact!.reason).toBe("ok");
    expect(fact!.fingerprint).toBe(sshKeygenFingerprint("release"));
    expect(fact!.namespace).toBe(RELEASE_NAMESPACE);
    // The other direction of the contract: the same .sig passes ssh-keygen -Y verify with an allowed_signers file.
    const signers = path("allowed_signers");
    writeFileSync(signers, `signer namespaces="${RELEASE_NAMESPACE}" ${readFileSync(path("release.pub"), "utf8").trim()}\n`);
    const sigFile = path("good.sig");
    writeFileSync(sigFile, signature);
    const checked = run(["-Y", "verify", "-f", signers, "-I", "signer", "-n", RELEASE_NAMESPACE, "-s", sigFile], message);
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stdout).toMatch(/Good .release@morndo\.github\.io. signature/);
  });

  it("reports the signer's fingerprint when it is not the key the caller trusts (wrong key)", () => {
    const signature = sign("release", KEYS_NAMESPACE, message);
    const [fact] = verifier.signatures(message, signature);
    expect(fact!.valid).toBe(true);
    expect(fact!.fingerprint).toBe(sshKeygenFingerprint("release"));
    expect(fact!.fingerprint).not.toBe(sshKeygenFingerprint("root"));
  });

  it("reports the namespace the block was signed under, not the one the caller wants", () => {
    const signature = sign("root", FEED_NAMESPACE, message);
    const [fact] = verifier.signatures(message, signature);
    expect(fact!.valid).toBe(true);
    expect(fact!.namespace).toBe(FEED_NAMESPACE);
    expect(fact!.namespace).not.toBe(KEYS_NAMESPACE);
  });

  it("refuses a changed message (one byte flipped)", () => {
    const signature = sign("release", RELEASE_NAMESPACE, message);
    const changed = Buffer.from(message); changed[10]! ^= 1;
    const [fact] = verifier.signatures(changed, signature);
    expect(fact!.valid).toBe(false);
    expect(fact!.reason).toBe("bad signature");
  });

  it("refuses cut armor (the last 20 base64 characters gone, footer kept)", () => {
    const signature = sign("release", RELEASE_NAMESPACE, message);
    const text = Buffer.from(signature).toString("utf8");
    const end = text.lastIndexOf("-----END");
    const cut = `${text.slice(0, end - 20).replace(/\n/g, "")}\n${text.slice(end)}`;
    const [fact] = verifier.signatures(message, Buffer.from(cut));
    expect(fact!.valid).toBe(false);
    expect(fact!.reason).toMatch(/malformed/);
  });

  it("refuses a sha256 signature", () => {
    const signature = sign("release", RELEASE_NAMESPACE, message, ["-O", "hashalg=sha256"]);
    const [fact] = verifier.signatures(message, signature);
    expect(fact!.valid).toBe(false);
    expect(fact!.reason).toBe("unsupported hash");
  });

  it("refuses an RSA key's signature", () => {
    const signature = sign("rsa", RELEASE_NAMESPACE, message);
    const [fact] = verifier.signatures(message, signature);
    expect(fact!.valid).toBe(false);
    expect(fact!.reason).toBe("unsupported key");
  });

  it("reads two blocks in one file (two signers, files concatenated)", () => {
    const both = Buffer.concat([
      sign("root", RELEASE_NAMESPACE, message),
      sign("other", RELEASE_NAMESPACE, message),
    ]);
    const facts = verifier.signatures(message, both);
    expect(facts).toHaveLength(2);
    expect(facts.every(f => f.valid)).toBe(true);
    expect(new Set(facts.map(f => f.fingerprint))).toEqual(new Set([sshKeygenFingerprint("root"), sshKeygenFingerprint("other")]));
  });

  it("reports no signature for a file with no block", () => {
    const facts = verifier.signatures(message, Buffer.from("this is not a signature file\n"));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toEqual({ valid: false, fingerprint: "", namespace: "", reason: "no signature" });
  });

  it("reports malformed armor for garbage text around a block", () => {
    const signature = sign("release", RELEASE_NAMESPACE, message);
    const withJunk = Buffer.concat([Buffer.from("trusted: yes definitely\n"), signature, Buffer.from("\nsincerely, the feed\n")]);
    const facts = verifier.signatures(message, withJunk);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.valid).toBe(false);
    expect(facts[0]!.reason).toBe("malformed armor");
  });

  it("refuses a flipped byte inside the signature bytes", () => {
    const signature = sign("release", RELEASE_NAMESPACE, message);
    const text = Buffer.from(signature).toString("utf8");
    const lines = text.split("\n");
    const bodyStart = lines.findIndex(l => l.startsWith("-----BEGIN"));
    const bodyEnd = lines.findIndex(l => l.startsWith("-----END"));
    const body = lines.slice(bodyStart + 1, bodyEnd).join("");
    const blob = Buffer.from(body, "base64");
    blob[blob.length - 1]! ^= 1;   // the raw 64-byte signature ends the blob
    const rebuilt = [
      "-----BEGIN SSH SIGNATURE-----",
      ...Buffer.from(blob).toString("base64").match(/.{1,70}/g)!,
      "-----END SSH SIGNATURE-----",
      "",
    ].join("\n");
    const [fact] = verifier.signatures(message, Buffer.from(rebuilt));
    expect(fact!.valid).toBe(false);
    expect(fact!.reason).toBe("bad signature");
  });

  it("sha256File equals sha256 of the same bytes and sha256sum's output", async () => {
    const file = path("bytes.bin");
    writeFileSync(file, message);
    const digest = await verifier.sha256File(file);
    expect(digest).toBe(verifier.sha256(message));
    const summed = spawnSync("sha256sum", [file], { encoding: "utf8" });
    expect(summed.status, summed.stderr).toBe(0);
    expect(digest).toBe(summed.stdout.trim().split(/\s+/)[0]);
  });

  it("fingerprintOfPublicKeyLine equals ssh-keygen -lf", () => {
    for (const key of ["root", "release", "other", "rsa"]) {
      const line = readFileSync(path(`${key}.pub`), "utf8").trim();
      expect(fingerprintOfPublicKeyLine(line)).toBe(sshKeygenFingerprint(key));
    }
  });
});
