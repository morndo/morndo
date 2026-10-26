// An HTML page the owner attached reaches a lane on another machine through file.put, in 256 KiB chunks, byte for
// byte, up to the domain's 10 MiB (S1); past that, and when it isn't UTF-8, the node refuses it on the final chunk.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES } from "@morndo/domain";
import { LIMITS } from "@morndo/protocol";
import { tempHome } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

let home: { home: string; cleanup: () => void }; let h: Harness;
beforeEach(() => { home = tempHome("html-"); h = opsHarness({ home: home.home, socket: join(home.home, "no-tmux.sock") }); });
afterEach(() => { h.close(); home.cleanup(); });

async function send(upload: string, name: string, bytes: Buffer) {
  const C = LIMITS.chunkBytes;
  const chunks = Math.max(1, Math.ceil(bytes.length / C));
  let last: unknown;
  for (let i = 0; i < chunks; i++) {
    last = await h.call("file.put", { upload, offset: i * C, bytes: bytes.subarray(i * C, i * C + C).toString("base64"), final: i === chunks - 1, name }, { key: `hub:upload:${upload}:${i}` });
    if (i < chunks - 1) expect(last).toMatchObject({ ok: true });
  }
  return last as { ok: boolean; result?: { path: string }; error?: { code: string } };
}

describe("an HTML page through file.put", () => {
  it("arrives byte for byte at 2 MiB, over a note's 1 MiB", async () => {
    const page = Buffer.concat([Buffer.from("<!doctype html><p>Grüße</p><script>run()</script>"), Buffer.alloc(2 * 1024 * 1024, 0x61)]);
    const r = await send("upload-html-1", "report.html", page);
    expect(r).toMatchObject({ ok: true });
    const path = r.result?.path ?? "";
    expect(path.endsWith("-report.html") && existsSync(path) && readFileSync(path).equals(page)).toBe(true);
  });
  it("arrives at exactly 10 MiB and is refused one byte past it", async () => {
    expect(await send("upload-html-2", "full.html", Buffer.alloc(MAX_UPLOAD_BYTES, 0x61))).toMatchObject({ ok: true });
    expect(await send("upload-html-3", "over.html", Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x61))).toMatchObject({ ok: false, error: { code: "too_large" } });
  });
  it("is refused when it isn't UTF-8 (negative control)", async () => {
    expect(await send("upload-html-4", "latin1.html", Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c]))).toMatchObject({ ok: false, error: { code: "not_allowed" } });
  });
});
