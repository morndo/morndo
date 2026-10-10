// RelayFiles.copy must fsync the copied data before renaming it into place (durability: the event is 202'd only once
// the copy is on disk). A full power-cut repro needs a Linux loop device; here we assert the syscall contract by
// recording node:fs's fsyncSync and renameSync calls (real behaviour kept) and checking an fsync comes before the rename.
// (An ESM namespace can't be spied on, so node:fs is wrapped with vi.mock.)
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAgentDb } from "../src/db/open.ts";
import { nodeOpener } from "../src/ops/node-files.ts";
import { RelayFiles } from "../src/relay/relay-files.ts";

const calls = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  const fsyncSync: typeof real.fsyncSync = fd => { calls.order.push("fsync"); real.fsyncSync(fd); };
  const renameSync: typeof real.renameSync = (a, b) => { calls.order.push("rename"); real.renameSync(a, b); };
  return { ...real, fsyncSync, renameSync };
});

let base: string; let adb: ReturnType<typeof openAgentDb>;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), "relay-fsync-")); adb = openAgentDb(join(base, "agent.db")); });
afterEach(() => { adb.close(); rmSync(base, { recursive: true, force: true }); });

describe("RelayFiles.copy durability", () => {
  it("fsyncs before it renames the copy into place", async () => {
    mkdirSync(join(base, "work"));
    const src = join(base, "work", "f.bin");
    writeFileSync(src, Buffer.alloc(4096, 1));
    const order = calls.order;
    order.length = 0;                                                    // only what copy() itself does
    const home = base;
    const files = new RelayFiles({ dir: join(base, "rf"), db: adb.db, open: nodeOpener({ home, stateDir: join(base, "state"), configDir: join(base, ".config/morndo-node") }) });
    try { await files.copy(src); } catch { /* recorded either way */ }
    expect(order.indexOf("fsync")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("fsync")).toBeLessThan(order.indexOf("rename"));
  });
});
