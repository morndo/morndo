// The agent's database only on this machine's own disk (fleet core §16.4; service-kit local-disk.ts): with the guard
// saying "network file system", openAgentDb refuses before it creates anything, and `morndo-node run` would exit 78.
// The guard itself is tested in packages/service-kit; here it is replaced, since no test machine has an NFS mount.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempHome } from "./helpers.ts";

vi.mock("@morndo/service-kit", async orig => {
  const real = await orig<typeof import("@morndo/service-kit")>();
  return { ...real, assertLocalDisk: (dir: string) => { throw new real.NotLocalDisk(`${dir} is on a network file system (NFS).`); } };
});
const { openAgentDb } = await import("../src/db/open.ts");
const { NotLocalDisk } = await import("@morndo/service-kit");

const homes: { cleanup: () => void }[] = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });

describe("the agent's database on a network file system", () => {
  it("is refused before the file is created", () => {
    const h = tempHome(); homes.push(h);
    const path = join(h.home, "state", "agent.db");
    expect(() => openAgentDb(path)).toThrow(NotLocalDisk);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(true);           // only its directory, which statfs needs to exist
  });
});
