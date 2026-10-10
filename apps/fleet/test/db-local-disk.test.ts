// fleet.db only on this machine's own disk (service-kit local-disk.ts: SQLite's WAL mode needs it): with the guard
// saying "network file system", openFleetDb refuses before it creates anything, and `morndo-fleet` would exit 78. The
// guard itself is tested in packages/service-kit; here it is replaced, since no test machine has an NFS mount.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers/temp.ts";

vi.mock("@morndo/service-kit", async orig => {
  const real = await orig<typeof import("@morndo/service-kit")>();
  return { ...real, assertLocalDisk: (dir: string) => { throw new real.NotLocalDisk(`${dir} is on a network file system (NFS).`); } };
});
const { openFleetDb } = await import("../src/adapters/db.ts");
const { NotLocalDisk } = await import("@morndo/service-kit");

describe("fleet.db on a network file system", () => {
  it("is refused before the file is created", () => {
    const path = join(tempDir(), "data", "fleet.db");
    expect(() => openFleetDb(path)).toThrow(NotLocalDisk);
    expect(existsSync(path)).toBe(false);
  });
});
