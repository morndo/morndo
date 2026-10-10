// file.put's staging sweeps every old file rarely, not once per 256 KiB chunk (EF6): a synchronous scan of two directories.
// The upload being written is still judged at each chunk. Synthetic uploads in a temporary directory.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { PARTIAL_TTL_MS, UploadInbox } from "../src/ops/upload-inbox.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-inbox-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const ctx = { ready: () => null } as never;
const chunk = Buffer.alloc(LIMITS.chunkBytes, 1).toString("base64");
const put = (inbox: UploadInbox, upload: string, i: number, final = false) => inbox.put({ upload, name: "a.bin", offset: i * LIMITS.chunkBytes, bytes: chunk, final } as never, ctx);

describe("an upload's chunks", () => {
  it("still refuse a chunk that doesn't fit the budget (negative control)", async () => {
    const inbox = new UploadInbox({ dir, room: () => 1000 });
    expect(await put(inbox, "u2", 0)).toMatchObject({ ok: false, error: { code: "too_large" } });
  });
  it("sweep at most once a minute: an old partial upload goes at the first chunk, a later one a minute on", async () => {
    let now = 1_000_000_000_000;
    const inbox = new UploadInbox({ dir, now: () => now });
    mkdirSync(join(dir, ".partial"), { recursive: true });
    const old = (name: string) => { const p = join(dir, ".partial", name); writeFileSync(p, "x"); const t = (now - PARTIAL_TTL_MS - 5000) / 1000; utimesSync(p, t, t); return p; };
    const first = old("stale-1");
    await put(inbox, "u3", 0);
    expect(existsSync(first)).toBe(false);
    const second = old("stale-2");
    await put(inbox, "u3", 1);
    expect(existsSync(second)).toBe(true);                       // swept a moment ago: not again yet
    now += 61_000;
    await put(inbox, "u3", 2);
    expect(existsSync(second)).toBe(false);
  });
  it("still forgets the upload being written when it has been idle for 10 minutes, at its next chunk", async () => {
    let now = 1_000_000_000_000;
    const inbox = new UploadInbox({ dir, now: () => now });
    await put(inbox, "u4", 0);
    const p = join(dir, ".partial", "u4");
    const t = (now - PARTIAL_TTL_MS - 5000) / 1000;
    utimesSync(p, t, t);
    expect(await put(inbox, "u4", 1)).toMatchObject({ ok: false, error: { code: "bad_args" } });
  });
});
