import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileRefused, durable, writeNew, writePrivate } from "../src/adapters/file-mode.ts";

describe("writeNew", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("keeps the first file when a second create loses", () => {
    dir = mkdtempSync(join(tmpdir(), "morndo-file-mode-"));
    const path = join(dir, "identity");
    const first = new TextEncoder().encode("AGE-SECRET-KEY-1first\n");
    const second = new TextEncoder().encode("AGE-SECRET-KEY-1second\n");
    const uid = process.getuid?.() ?? -1;
    expect(writeNew(path, first, uid)).toBe(true);
    expect(writeNew(path, second, uid)).toBe(false);
    expect(readFileSync(path)).toEqual(Buffer.from(first));
  });

  it("fsyncs the new file and its directory", () => {
    dir = mkdtempSync(join(tmpdir(), "morndo-file-mode-"));
    const seen: number[] = [];
    const real = durable.fsync;
    durable.fsync = fd => { seen.push(fd); real(fd); };
    try { writePrivate(join(dir, "secret"), new TextEncoder().encode("synthetic-key"), process.getuid?.() ?? -1); }
    finally { durable.fsync = real; }
    expect(seen).toHaveLength(2);
  });

  it("removes the temp file when the write fails", () => {
    dir = mkdtempSync(join(tmpdir(), "morndo-file-mode-"));
    const real = durable.fsync;
    durable.fsync = () => { throw new Error("disk full"); };
    try {
      expect(() => writePrivate(join(dir, "secret"), new TextEncoder().encode("synthetic-key"), process.getuid?.() ?? -1)).toThrow(/disk full/);
    } finally { durable.fsync = real; }
    expect(readdirSync(dir).filter(name => name.includes(".tmp"))).toEqual([]);
  });

  it("removes the temp file when the new file is refused", () => {
    dir = mkdtempSync(join(tmpdir(), "morndo-file-mode-"));
    const nested = join(dir, "vault");
    expect(() => writeNew(join(nested, "identity"), new TextEncoder().encode("synthetic-key"), -1)).toThrow(FileRefused);
    expect(readdirSync(dir, { recursive: true }).map(String).filter(name => name.includes(".tmp"))).toEqual([]);
  });
});
