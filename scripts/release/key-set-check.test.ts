// The build job checks the Key set's signature before it ships it: scripts/release/check-key-set.sh <signers> <dir> verifies
// <dir>/keys.json against <dir>/keys.json.sig with ssh-keygen, under the root identity and the keys@morndo.github.io
// namespace (trust/README.md), against a signer the workflow pins. A missing or empty signature, a changed keys.json, a
// signature by another key or in another namespace, and a missing signer all fail. The last case reads the repository's
// own trust/ with the signer and minimum version the workflow names, so the pin and the committed signature cannot drift
// apart. A validly signed but older set (a lower version, or one past its expiresAt) fails too: replaying it would ship
// keys that were rotated out.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./check-key-set.sh", import.meta.url));
const NAMESPACE = "keys@morndo.github.io";
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const sh = (cmd: string, args: string[], cwd?: string) => spawnSync(cmd, args, { encoding: "utf8", ...(cwd ? { cwd } : {}) });
const KEYS = '{\n  "schema": 1,\n  "version": 1,\n  "expiresAt": "2027-10-21T00:00:00Z",\n  "root": ["SHA256:a"],\n  "release": ["SHA256:b"],\n  "feed": ["SHA256:c"]\n}\n';

function world() {
  const dir = mkdtempSync(join(tmpdir(), "morndo-keyset-"));
  roots.push(dir);
  const key = (name: string) => {
    const r = sh("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", join(dir, name)]);
    expect(r.status, r.stderr).toBe(0);
    return `root@morndo.github.io namespaces="${NAMESPACE}" ${readFileSync(join(dir, `${name}.pub`), "utf8").split(" ").slice(0, 2).join(" ")}\n`;
  };
  const signers = join(dir, "root_allowed_signers");
  writeFileSync(signers, key("root"));
  key("other");
  const trust = join(dir, "trust");
  mkdirSync(trust);
  writeFileSync(join(trust, "keys.json"), KEYS);
  const sign = (file: string, withKey = "root", namespace = NAMESPACE) => {
    rmSync(`${file}.sig`, { force: true });
    const r = sh("ssh-keygen", ["-q", "-Y", "sign", "-f", join(dir, withKey), "-n", namespace, file]);
    expect(r.status, r.stderr).toBe(0);
  };
  sign(join(trust, "keys.json"));
  const check = (over: { signers?: string; dir?: string; min?: string | null } = {}) =>
    sh("sh", [SCRIPT, over.signers ?? signers, over.dir ?? trust, ...(over.min === null ? [] : [over.min ?? "1"])]);
  const publish = (text: string) => { writeFileSync(join(trust, "keys.json"), text); sign(join(trust, "keys.json")); };
  return { dir, trust, signers, sign, check, publish };
}

describe("check-key-set.sh", () => {
  it("passes a keys.json signed by the pinned root key in the keys namespace", () => {
    const w = world();
    const r = w.check();
    expect([r.status, r.stdout]).toEqual([0, expect.stringContaining("check-key-set: ok")]);
  });

  it("fails a keys.json that changed after it was signed", () => {
    const w = world();
    writeFileSync(join(w.trust, "keys.json"), `${KEYS} `);
    expect(w.check().status).not.toBe(0);
    writeFileSync(join(w.trust, "keys.json"), KEYS.replace('"version": 1', '"version": 2'));
    expect(w.check().status).not.toBe(0);
  });

  it("fails a missing signature, an empty one and a signature that is not one", () => {
    const w = world();
    rmSync(join(w.trust, "keys.json.sig"));
    const missing = w.check();
    expect(missing.status).not.toBe(0);
    expect(missing.stdout + missing.stderr).toMatch(/keys\.json\.sig/);
    writeFileSync(join(w.trust, "keys.json.sig"), "");
    expect(w.check().status).not.toBe(0);
    writeFileSync(join(w.trust, "keys.json.sig"), "not a signature\n");
    expect(w.check().status).not.toBe(0);
  });

  it("fails a missing or empty keys.json, a missing directory and a missing or empty signer", () => {
    const w = world();
    expect(w.check({ dir: join(w.dir, "nowhere") }).status).not.toBe(0);
    expect(w.check({ signers: join(w.dir, "no-such-signers") }).status).not.toBe(0);
    writeFileSync(join(w.dir, "empty-signers"), "");
    expect(w.check({ signers: join(w.dir, "empty-signers") }).status).not.toBe(0);
    writeFileSync(join(w.trust, "keys.json"), "");
    expect(w.check().status).not.toBe(0);
    rmSync(join(w.trust, "keys.json"));
    expect(w.check().status).not.toBe(0);
  });

  it("fails a signature by another key, and one made in another namespace", () => {
    const w = world();
    w.sign(join(w.trust, "keys.json"), "other");
    expect(w.check().status).not.toBe(0);
    w.sign(join(w.trust, "keys.json"), "root", "release@morndo.github.io");
    expect(w.check().status).not.toBe(0);
    w.sign(join(w.trust, "keys.json"));
    expect(w.check().status).toBe(0);   // control: the right key and namespace pass again
  });

  it("fails a validly signed older set: below the pinned minimum version, or past its expiresAt", () => {
    const w = world();
    expect(w.check({ min: "1" }).status).toBe(0);
    const stale = w.check({ min: "2" });
    expect(stale.status).not.toBe(0);
    expect(stale.stdout + stale.stderr).toMatch(/version 1, below the pinned minimum 2/);
    w.publish(KEYS.replace('"version": 1', '"version": 2'));
    expect(w.check({ min: "2" }).status).toBe(0);
    expect(w.check({ min: "3" }).status).not.toBe(0);
    w.publish(KEYS.replace("2027-10-21T00:00:00Z", "2020-01-01T00:00:00Z"));
    const expired = w.check();
    expect(expired.status).not.toBe(0);
    expect(expired.stdout + expired.stderr).toMatch(/expired/);
    w.publish(KEYS);
    expect(w.check().status).toBe(0);   // control: the unexpired set passes again
  });

  it("fails closed on a signed set whose version or expiry it cannot read, and on a missing or odd minimum version", () => {
    const w = world();
    w.publish(KEYS.replace(/ *"version": 1,\n/, ""));
    expect(w.check().status).not.toBe(0);
    w.publish(KEYS.replace(/ *"expiresAt": "[^"]*",\n/, ""));
    expect(w.check().status).not.toBe(0);
    w.publish(KEYS.replace('"version": 1', '"version": "1"'));
    expect(w.check().status).not.toBe(0);
    w.publish(KEYS);
    expect(w.check({ min: null }).status).not.toBe(0);
    for (const odd of ["", "x", "1.5", "-1", "0"]) expect(w.check({ min: odd }).status, `min ${JSON.stringify(odd)}`).not.toBe(0);
  });

  it("the repository's own trust/ verifies against the signer and minimum version the release workflow pins", () => {
    const release = readFileSync(".github/workflows/release.yml", "utf8");
    const pinned = /ROOT_ALLOWED_SIGNER: '([^']+)'/.exec(release);
    expect(pinned, "the workflow pins ROOT_ALLOWED_SIGNER").not.toBeNull();
    const min = /KEY_SET_MIN_VERSION: "(\d+)"/.exec(release);
    expect(min, "the workflow pins KEY_SET_MIN_VERSION").not.toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "morndo-pin-"));
    roots.push(dir);
    writeFileSync(join(dir, "root_allowed_signers"), `${pinned![1]}\n`);
    const r = sh("sh", [SCRIPT, join(dir, "root_allowed_signers"), "trust", min![1]!]);
    expect([r.status, r.stdout + r.stderr]).toEqual([0, expect.stringContaining("check-key-set: ok")]);
    // The pin is the version the tree ships now: raising keys.json's version without raising the pin would leave the
    // older sets (and the keys they list) acceptable, so the two are equal.
    const shipped = Number(/"version": (\d+)/.exec(readFileSync("trust/keys.json", "utf8"))![1]);
    expect(Number(min![1])).toBe(shipped);
  });
});
