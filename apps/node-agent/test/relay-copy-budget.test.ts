// Concurrent /file copies must not both pass one room check, and a file that grows after its size is taken must not
// be copied past that size. Uses RelayFiles directly with a fixed room() and an opener that appends after open.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAgentDb } from "../src/db/open.ts";
import { nodeOpener } from "../src/ops/node-files.ts";
import { RelayFiles } from "../src/relay/relay-files.ts";

const MiB = 1 << 20;
let base: string; let adb: ReturnType<typeof openAgentDb>;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), "relay-budget-")); adb = openAgentDb(join(base, "agent.db")); mkdirSync(join(base, "work")); });
afterEach(() => { adb.close(); rmSync(base, { recursive: true, force: true }); });

describe("RelayFiles budget under concurrency and growth", () => {
  it("two concurrent 20 MiB copies with a 30 MiB budget: one 503; held <= budget", async () => {
    writeFileSync(join(base, "work", "a.bin"), Buffer.alloc(20 * MiB));
    writeFileSync(join(base, "work", "b.bin"), Buffer.alloc(20 * MiB));
    const open = nodeOpener({ home: base, stateDir: join(base, "state"), configDir: join(base, ".config/morndo-node") });
    const files = new RelayFiles({ dir: join(base, "rf"), db: adb.db, open, room: (): number => 30 * MiB - files.bytes() });
    const [r1, r2] = await Promise.all([files.copy(join(base, "work", "a.bin")), files.copy(join(base, "work", "b.bin"))]);
    const statuses = [r1, r2].map(r => (r.ok ? 202 : r.status)).sort((x, y) => x - y);
    expect(statuses).toEqual([202, 503]);
  });
  it("a file that grows after its size is taken is copied only up to the checked size", async () => {
    const f = join(base, "work", "g.log");
    writeFileSync(f, Buffer.alloc(20 * MiB));
    const inner = nodeOpener({ home: base, stateDir: join(base, "state"), configDir: join(base, ".config/morndo-node") });
    const open = async (p: string) => { const c = await inner(p); appendFileSync(f, Buffer.alloc(4 * MiB)); return c; };
    const files = new RelayFiles({ dir: join(base, "rf"), db: adb.db, open, room: (): number => 21 * MiB - files.bytes() });
    const r = await files.copy(f);
    expect(r).toMatchObject({ ok: true, size: 20 * MiB });
  });
});
