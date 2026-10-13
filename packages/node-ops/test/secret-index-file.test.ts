// The index file adapter (ADR-0022; design §8.1, §15.4): it reads the file the Secrets service writes only when it is a
// regular file this user owns with no group or other bits, and only when it parses whole.
import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexFileRefused, readSecretIndex } from "../src/secret-index-file.ts";
import { emptySecretIndex, indexValue, serializeIndex, withVersion, type SecretIndex } from "../src/secret-scan.ts";

const KEY = new Uint8Array(32).fill(9);
const keyed = (b: Uint8Array) => new Uint8Array(createHmac("sha256", KEY).update(b).digest());
const UID = process.getuid?.() ?? -1;

function sampleIndex(): SecretIndex {
  const r = indexValue(new TextEncoder().encode("sample-value-for-the-index"), keyed);
  if (r.kind !== "indexed") throw new Error("not indexed");
  return withVersion(emptySecretIndex(), "secret://example-app/payments-test", 1, r.entries);
}

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "secret-index-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const write = (name: string, text: string, mode: number) => {
  const path = join(dir, name);
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
};
const problem = (f: () => unknown) => {
  try { f(); return "read"; } catch (error) { return error instanceof IndexFileRefused ? error.problem : `other: ${String(error)}`; }
};

describe("readSecretIndex", () => {
  it("reads a 0600 file this user owns, and a 0400 one", () => {
    expect(readSecretIndex(write("index", serializeIndex(sampleIndex()), 0o600), UID)).toEqual(sampleIndex());
    expect(readSecretIndex(write("index-ro", serializeIndex(sampleIndex()), 0o400), UID)).toEqual(sampleIndex());
  });
  it("refuses a file looser than 0600", () => {
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o606, 0o610]) {
      expect(problem(() => readSecretIndex(write(`index-${mode.toString(8)}`, serializeIndex(sampleIndex()), mode), UID)), mode.toString(8)).toBe("mode");
    }
  });
  it("refuses a file another user owns", () => {
    expect(problem(() => readSecretIndex(write("index", serializeIndex(sampleIndex()), 0o600), UID + 1))).toBe("owner");
  });
  it("refuses a symlink, even to a good file, and a directory", () => {
    const good = write("good", serializeIndex(sampleIndex()), 0o600);
    symlinkSync(good, join(dir, "link"));
    expect(problem(() => readSecretIndex(join(dir, "link"), UID))).toBe("kind");
    mkdirSync(join(dir, "folder"), { mode: 0o700 });
    expect(problem(() => readSecretIndex(join(dir, "folder"), UID))).toBe("kind");
  });
  it("refuses a file that doesn't parse whole", () => {
    expect(problem(() => readSecretIndex(write("index", "{\"format\":1,\"versions\":[{}]}", 0o600), UID))).toBe("format");
  });
  it("reads no file as an empty index: the node has stored nothing yet", () => {
    expect(readSecretIndex(join(dir, "none"), UID)).toEqual(emptySecretIndex());
  });
});
