// The index writer (ADR-0022; design §8.1, §15.4): it indexes a vault file's value as keyed hashes only, and writes the
// index file every output path reads in one atomic write at 0600, refusing a file it would not read back.
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IndexFileRefused, RETIRED_KEPT_MS, emptySecretIndex, encodedForms, indexValue, liveEntries, readSecretIndex, scan, serializeIndex,
  withVersion, type IndexEntry,
} from "@morndo/node-ops";
import { durable } from "../src/adapters/file-mode.ts";
import { SecretIndexWriter } from "../src/adapters/secret-index-writer.ts";

const keyed = (b: Uint8Array) => new Uint8Array(createHmac("sha256", new Uint8Array(32).fill(7)).update(b).digest());
const UID = process.getuid?.() ?? -1;
const REF = "secret://example-app/payments-test";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 12);
const enc = (s: string) => new TextEncoder().encode(s);

// A vault that answers each ref with its bytes, and notes every open.
function fakeVault(values: ReadonlyMap<string, Uint8Array>) {
  const opened: string[] = [];
  return {
    opened,
    open: async (ref: string) => {
      opened.push(ref);
      const bytes = values.get(ref);
      if (!bytes) throw new Error(`no vault file ${ref}`);
      return { bytes: () => bytes };
    },
  };
}

// Whether `needle` occurs anywhere in `hay`, byte for byte.
const contains = (hay: Uint8Array, needle: Uint8Array) => Buffer.from(hay).indexOf(Buffer.from(needle)) !== -1;
const found = (text: string, entries: readonly IndexEntry[]) => scan(enc(text), entries, keyed).length > 0;
const problem = (f: () => unknown) => {
  try { f(); return "wrote"; } catch (error) { return error instanceof IndexFileRefused ? error.problem : `other: ${String(error)}`; }
};

let dir = "";
let path = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-index-writer-"));
  path = join(dir, "index", "secrets.json");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
// An index file put in place by hand, in a 0700 directory as the writer makes it.
const plant = (text: string, mode: number) => {
  mkdirSync(join(dir, "index"), { mode: 0o700 });
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
};

describe("SecretIndexWriter", () => {
  it("indexes a value under its Reference and version, and the scanner finds it through the file", async () => {
    const value = "fixture-value-for-the-index";
    const writer = new SecretIndexWriter(path, keyed, fakeVault(new Map([["s-a", enc(value)]])), UID);
    const prepared = await writer.prepare("s-a");
    writer.write({ add: { reference: REF, version: 1, prepared }, retire: [], at: T0 });
    const index = readSecretIndex(path, UID);
    expect(index.versions.map(v => [v.reference, v.version, v.retiredAt])).toEqual([[REF, 1, null]]);
    const expected = indexValue(enc(value), keyed);
    expect(index.versions[0]?.entries).toEqual(expected.kind === "indexed" ? expected.entries : null);
    expect(scan(enc(`log: ${value} end`), liveEntries(index, T0), keyed)).toEqual([{ start: 5, end: 5 + value.length }]);
  });

  it("opens the vault file once, and what it prepares holds nothing but whether the value is short", async () => {
    const vault = fakeVault(new Map([["s-a", enc("fixture-value-for-the-index")]]));
    const prepared = await new SecretIndexWriter(path, keyed, vault, UID).prepare("s-a");
    expect(vault.opened).toEqual(["s-a"]);
    expect(Object.keys(prepared)).toEqual(["short"]);
    expect(prepared.short).toBe(false);
  });

  it("writes no form of the value into the file, only keyed hashes (criterion 16)", async () => {
    // Over 20 bytes, with non-ASCII, "/", "+" and a space, so the percent, JSON and base64 forms all differ from raw.
    const value = enc("fixture/vä lue+ünïcode π-42");
    expect(value.length).toBeGreaterThan(20);
    const writer = new SecretIndexWriter(path, keyed, fakeVault(new Map([["s-a", value]])), UID);
    writer.write({ add: { reference: REF, version: 1, prepared: await writer.prepare("s-a") }, retire: [], at: T0 });
    expect(readSecretIndex(path, UID).versions).toHaveLength(1);
    const bytes = new Uint8Array(readFileSync(path));
    const forms = encodedForms(value);
    expect(new Set(forms.map(f => f.encoding))).toEqual(new Set(["raw", "hex", "percent", "json", "base64", "base64url"]));
    expect(forms.filter(f => contains(bytes, f.bytes)).map(f => `${f.encoding}/${String(f.alignment)}`)).toEqual([]);
  });

  it("keeps a retired version found for 30 days after its retirement, and not after", async () => {
    const old = "old-fixture-value-0001";
    const next = "new-fixture-value-0002";
    const writer = new SecretIndexWriter(path, keyed, fakeVault(new Map([["s-1", enc(old)], ["s-2", enc(next)]])), UID);
    writer.write({ add: { reference: REF, version: 1, prepared: await writer.prepare("s-1") }, retire: [], at: T0 });
    const t1 = T0 + DAY;
    writer.write({ add: { reference: REF, version: 2, prepared: await writer.prepare("s-2") }, retire: [{ reference: REF, version: 1 }], at: t1 });
    const index = readSecretIndex(path, UID);
    expect(index.versions.map(v => [v.version, v.retiredAt])).toEqual([[1, t1], [2, null]]);
    expect(found(`x ${old} y`, liveEntries(index, t1 + RETIRED_KEPT_MS))).toBe(true);
    expect(found(`x ${old} y`, liveEntries(index, t1 + RETIRED_KEPT_MS + 1))).toBe(false);
    expect(found(`x ${next} y`, liveEntries(index, t1 + RETIRED_KEPT_MS + 1))).toBe(true);
  });

  it("prunes on a write what 30 days no longer cover, and marks the Reference as pruned through that version", async () => {
    const writer = new SecretIndexWriter(path, keyed, fakeVault(new Map([["s-1", enc("old-fixture-value-0001")], ["s-2", enc("new-fixture-value-0002")]])), UID);
    writer.write({ add: { reference: REF, version: 1, prepared: await writer.prepare("s-1") }, retire: [], at: T0 });
    writer.write({ add: { reference: REF, version: 2, prepared: await writer.prepare("s-2") }, retire: [{ reference: REF, version: 1 }], at: T0 });
    writer.write({ add: null, retire: [], at: T0 + RETIRED_KEPT_MS });
    expect(readSecretIndex(path, UID).versions.map(v => v.version)).toEqual([1, 2]);
    writer.write({ add: null, retire: [], at: T0 + RETIRED_KEPT_MS + 1 });
    const index = readSecretIndex(path, UID);
    expect(index.versions.map(v => v.version)).toEqual([2]);
    expect(index.pruned).toEqual([{ reference: REF, through: 1 }]);
  });

  it("prepares a value under 8 bytes as short and adds nothing, but still writes the file", async () => {
    const writer = new SecretIndexWriter(path, keyed, fakeVault(new Map([["s-7", enc("7-bytes")], ["s-8", enc("8-bytes!")]])), UID);
    const short = await writer.prepare("s-7");
    expect(short.short).toBe(true);
    expect((await writer.prepare("s-8")).short).toBe(false);
    writer.write({ add: { reference: REF, version: 1, prepared: short }, retire: [], at: T0 });
    expect(existsSync(path)).toBe(true);
    expect(readSecretIndex(path, UID)).toEqual(emptySecretIndex());
  });

  it("writes the file at 0600", async () => {
    const writer = new SecretIndexWriter(path, keyed, fakeVault(new Map([["s-a", enc("fixture-value-for-the-index")]])), UID);
    writer.write({ add: { reference: REF, version: 1, prepared: await writer.prepare("s-a") }, retire: [], at: T0 });
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses an existing index at 0644 and leaves it as it was", async () => {
    const writer = new SecretIndexWriter(path, keyed, fakeVault(new Map([["s-a", enc("fixture-value-for-the-index")]])), UID);
    const prepared = await writer.prepare("s-a");
    plant(serializeIndex(emptySecretIndex()), 0o644);
    const before = readFileSync(path);
    expect(problem(() => writer.write({ add: { reference: REF, version: 1, prepared }, retire: [], at: T0 }))).toBe("mode");
    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it("refuses an index another user owns", async () => {
    plant(serializeIndex(emptySecretIndex()), 0o600);
    const other = new SecretIndexWriter(path, keyed, fakeVault(new Map()), UID + 1);
    expect(problem(() => other.write({ add: null, retire: [], at: T0 }))).toBe("owner");
  });

  it("leaves the old index readable when a write fails before its rename", async () => {
    const writer = new SecretIndexWriter(path, keyed, fakeVault(new Map([["s-1", enc("old-fixture-value-0001")], ["s-2", enc("new-fixture-value-0002")]])), UID);
    writer.write({ add: { reference: REF, version: 1, prepared: await writer.prepare("s-1") }, retire: [], at: T0 });
    expect(existsSync(path)).toBe(true);
    const before = readFileSync(path);
    const second = await writer.prepare("s-2");
    const real = durable.fsync;
    let failed = false;
    durable.fsync = fd => {
      if (!failed) { failed = true; throw new Error("disk full"); }
      real(fd);
    };
    try {
      expect(() => writer.write({ add: { reference: REF, version: 2, prepared: second }, retire: [], at: T0 })).toThrow(/disk full/);
    } finally { durable.fsync = real; }
    expect(readFileSync(path)).toEqual(before);
    expect(readSecretIndex(path, UID).versions.map(v => v.version)).toEqual([1]);
    expect(readdirSync(join(dir, "index")).filter(name => name.endsWith(".tmp"))).toEqual([]);
    writer.write({ add: { reference: REF, version: 2, prepared: second }, retire: [], at: T0 });
    expect(readSecretIndex(path, UID).versions.map(v => v.version)).toEqual([1, 2]);
  });

  it("refuses a prepared index it did not make, before it touches the file", async () => {
    const vault = fakeVault(new Map([["s-a", enc("fixture-value-for-the-index")]]));
    const writer = new SecretIndexWriter(path, keyed, vault, UID);
    const another = await new SecretIndexWriter(path, keyed, vault, UID).prepare("s-a");
    for (const prepared of [another, { short: false }, { short: true }]) {
      expect(() => writer.write({ add: { reference: REF, version: 1, prepared }, retire: [], at: T0 })).toThrow(/did not make/);
    }
    expect(existsSync(path)).toBe(false);
  });

  it("adds to the versions already in the file", async () => {
    const other = indexValue(enc("another-fixture-value"), keyed);
    if (other.kind !== "indexed") throw new Error("not indexed");
    plant(serializeIndex(withVersion(emptySecretIndex(), "secret://example-app/other", 3, other.entries)), 0o600);
    const writer = new SecretIndexWriter(path, keyed, fakeVault(new Map([["s-a", enc("fixture-value-for-the-index")]])), UID);
    writer.write({ add: { reference: REF, version: 1, prepared: await writer.prepare("s-a") }, retire: [], at: T0 });
    expect(readSecretIndex(path, UID).versions.map(v => [v.reference, v.version])).toEqual([["secret://example-app/other", 3], [REF, 1]]);
  });
});
