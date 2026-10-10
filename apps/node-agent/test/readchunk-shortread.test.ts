// readChunk must honour bytesRead: a rewrite to a shorter file between its fstat and its read must NOT be returned as
// a full-length NUL-padded chunk with eof=true. Forced window via FileHandle.prototype.stat.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { readChunk } from "../src/ops/node-files.ts";

let dir: string, file: string;
const OLD = Buffer.alloc(1000, 0x41);
const NEW = Buffer.alloc(400, 0x42);
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "readchunk-")); file = join(dir, "n.txt"); writeFileSync(file, OLD); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("readChunk honours bytesRead", () => {
  it("a shrink between fstat and read yields a short chunk that does not read as a clean full copy", async () => {
    const fh = await open(file, "r");
    const proto = Object.getPrototypeOf(fh) as { stat: (...a: unknown[]) => Promise<{ size: number }> };
    const realStat = proto.stat;
    let armed = true;
    proto.stat = function (this: unknown, ...a: unknown[]) {
      const p = realStat.apply(this, a) as Promise<{ size: number }>;
      if (!armed || !(new Error().stack ?? "").includes("readChunk")) return p;
      armed = false;
      return p.then(st => { writeFileSync(file, NEW); return st; });
    };
    try {
      const r = await readChunk(fh, 0, LIMITS.chunkBytes);
      const bytes = Buffer.from(r.bytes, "base64");
      // the bug returns 1000 bytes (600 NUL) with eof=true; the fix returns the 400 real bytes, no NUL tail, eof=false
      expect(bytes.filter(x => x === 0).length).toBe(0);
      expect(bytes.length).toBe(400);
      expect(r.eof).toBe(false);
    } finally { proto.stat = realStat; await fh.close(); }
  });
});
