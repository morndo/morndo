// The upload registry is persisted (ADR-0008 phase C): an image pasted before a hub restart can still be attached after
// it, within its day (S2); today a restart gave "unknown_upload". Real SQLite in a temp dir; two inboxes on one store
// stand for a restart.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UPLOAD_TTL_MS, endpointId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { uploadInbox } from "../src/adapters/uploads.ts";

let dir: string;
let store: Store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-uploads-reg-")); store = new Store(join(dir, "data")); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]); };
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])), chunk("IDAT", deflateSync(Buffer.from([0, 255, 128, 0]))), chunk("IEND", Buffer.alloc(0))]);
const T0 = Date.UTC(2026, 9, 2, 9);

describe("the upload registry across a restart", () => {
  it("an upload from before the restart is found after it, with its endpoint, path and type", async () => {
    const before = uploadInbox({ dir: join(dir, "inbox"), now: () => T0, registry: store });
    const r = await before.save(png, endpointId("ep1"));
    if (!r.ok) throw new Error(r.error);
    const after = uploadInbox({ dir: join(dir, "inbox"), now: () => T0 + 60_000, registry: store });
    expect(after.get(r.value.id)).toEqual(r.value);
  });
  it("past its day, the sweep forgets it", async () => {
    let now = T0;
    const inbox = uploadInbox({ dir: join(dir, "inbox"), now: () => now, registry: store });
    const r = await inbox.save(png, endpointId("ep1"));
    if (!r.ok) throw new Error(r.error);
    now = T0 + UPLOAD_TTL_MS + 1;
    inbox.sweep();
    expect(uploadInbox({ dir: join(dir, "inbox"), now: () => now, registry: store }).get(r.value.id)).toBeUndefined();
  });
  it("without a registry it still works in memory (unit tests)", async () => {
    const inbox = uploadInbox({ dir: join(dir, "inbox") });
    const r = await inbox.save(png, endpointId("ep1"));
    expect(r.ok && inbox.get(r.value.id)?.mime).toBe("image/png");
  });
});
