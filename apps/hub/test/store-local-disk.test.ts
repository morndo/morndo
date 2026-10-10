// The hub's morndo.db only on this machine's own disk (service-kit local-disk.ts: SQLite's WAL mode needs it): with the
// guard saying "network file system", the Store refuses before it creates the file, and `morndo serve` would exit 78.
// The guard itself is tested in packages/service-kit; here it is replaced, since no test machine has an NFS mount.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@morndo/service-kit", async orig => {
  const real = await orig<typeof import("@morndo/service-kit")>();
  return { ...real, assertLocalDisk: (dir: string) => { throw new real.NotLocalDisk(`${dir} is on a network file system (NFS).`); } };
});
const { Store } = await import("../src/adapters/store.ts");
const { NotLocalDisk } = await import("@morndo/service-kit");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("the hub's database on a network file system", () => {
  it("is refused before the file is created", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-store-"));
    dirs.push(dir);
    expect(() => new Store(dir)).toThrow(NotLocalDisk);
    expect(existsSync(join(dir, "morndo.db"))).toBe(false);
  });

  it("does not create the data directory when the disk is refused", () => {
    const parent = mkdtempSync(join(tmpdir(), "morndo-store-"));
    dirs.push(parent);
    const dir = join(parent, "hub");
    expect(existsSync(dir)).toBe(false);
    expect(() => new Store(dir)).toThrow(NotLocalDisk);
    expect(existsSync(dir)).toBe(false);
  });
});
