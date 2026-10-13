// The node's keys (PLAN step 5, criteria 8 and 9; design §6). Values are synthetic; node:crypto is the oracle.
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { durable } from "../src/adapters/file-mode.ts";
import { NodeKeys } from "../src/adapters/node-keys.ts";
import { NOTHING_ON_RECORD } from "./fixtures/keys.ts";

const value = new TextEncoder().encode("synthetic-value-for-keys");
const realFsync = durable.fsync;
let roots: string[] = [];
const home = () => {
  const root = mkdtempSync(join(tmpdir(), "morndo-node-keys-"));
  roots.push(root);
  return join(root, "connections");
};
afterEach(() => {
  durable.fsync = realFsync;
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

describe("the node's keys (criterion 9)", () => {
  it("a fingerprint key and an index key, 32 random bytes each, 0600, beside the identity, made on first use", () => {
    const dir = home();
    const keys = new NodeKeys(dir, NOTHING_ON_RECORD);
    keys.fingerprint(value);
    keys.index(value);
    for (const name of ["fingerprint.key", "index.key"]) {
      const path = join(dir, name);
      expect(statSync(path).mode & 0o777, name).toBe(0o600);
      expect(readFileSync(path).length, name).toBe(32);
    }
    expect(readFileSync(join(dir, "fingerprint.key")).equals(readFileSync(join(dir, "index.key")))).toBe(false);
  });
  it("two creators racing end up with one key: the one that lost reads the winner's", () => {
    const dir = home();
    const first = new NodeKeys(dir, NOTHING_ON_RECORD);
    const second = new NodeKeys(dir, NOTHING_ON_RECORD);
    let raced = false;
    const real = durable.fsync;
    // While the first writes its temp file, the second creates and links its own key.
    durable.fsync = (fd: number) => {
      real(fd);
      if (!raced) { raced = true; second.fingerprint(value); }
    };
    const a = first.fingerprint(value);
    expect(raced).toBe(true);
    expect(a).toBe(second.fingerprint(value));
    expect(new NodeKeys(dir, NOTHING_ON_RECORD).fingerprint(value)).toBe(a);
  });
});

describe("the keyed fingerprint (criterion 8)", () => {
  it("is the first 12 hex characters of HMAC-SHA-256 under the fingerprint key", () => {
    const dir = home();
    const keys = new NodeKeys(dir, NOTHING_ON_RECORD);
    const got = keys.fingerprint(value);
    expect(got).toMatch(/^[0-9a-f]{12}$/);
    expect(got).toBe(createHmac("sha256", readFileSync(join(dir, "fingerprint.key"))).update(value).digest("hex").slice(0, 12));
  });
  it("is stable on one node and differs between two nodes for one value", () => {
    const one = home();
    expect(new NodeKeys(one, NOTHING_ON_RECORD).fingerprint(value)).toBe(new NodeKeys(one, NOTHING_ON_RECORD).fingerprint(value));
    expect(new NodeKeys(one, NOTHING_ON_RECORD).fingerprint(value)).not.toBe(new NodeKeys(home(), NOTHING_ON_RECORD).fingerprint(value));
  });
  it("the index's keyed hash is HMAC-SHA-256 under the index key, not the fingerprint key", () => {
    const dir = home();
    const keys = new NodeKeys(dir, NOTHING_ON_RECORD);
    const got = keys.index(value);
    expect(Buffer.from(got).toString("hex")).toBe(createHmac("sha256", readFileSync(join(dir, "index.key"))).update(value).digest("hex"));
    expect(Buffer.from(got).toString("hex").slice(0, 12)).not.toBe(keys.fingerprint(value));
  });
  it("a key file looser than 0600 is refused before it is used", async () => {
    const dir = home();
    new NodeKeys(dir, NOTHING_ON_RECORD).fingerprint(value);
    const { chmodSync } = await import("node:fs");
    chmodSync(join(dir, "fingerprint.key"), 0o644);
    expect(() => new NodeKeys(dir, NOTHING_ON_RECORD).fingerprint(value)).toThrow(/looser than a private file/);
  });
});

describe("a key file that isn't a key", () => {
  it("one of another length is refused, not used", () => {
    const dir = home();
    const keys = new NodeKeys(dir, NOTHING_ON_RECORD);
    keys.fingerprint(value);
    for (const name of ["fingerprint.key", "index.key"]) {
      writeFileSync(join(dir, name), new Uint8Array(16).fill(3), { mode: 0o600 });
    }
    expect(() => new NodeKeys(dir, NOTHING_ON_RECORD).fingerprint(value)).toThrow(/is not a 32-byte key/);
    expect(() => new NodeKeys(dir, NOTHING_ON_RECORD).index(value)).toThrow(/is not a 32-byte key/);
  });
});
