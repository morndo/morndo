// The HoldWriter adapter's contract (design §5 hold.json, §6.2 steps 3 and 7): the hold lands at the path the
// services themselves read (service-kit's holdFile), in the wire's own shape, atomically — a service re-reading
// it every second never sees half a file, and a failed write leaves the hold that is already there. What a
// service sees is proven with the service's own reader, readHold.
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdFile, readHold } from "@morndo/service-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HoldFileWriter } from "../src/adapters/hold-file.ts";

let scratch = "";

beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

// The env is empty so the path is deterministic and never the account's own state directory.
const writer = () => {
  const home = mkdtempSync(join(scratch, "home-"));
  const env: NodeJS.ProcessEnv = {};
  return { home, env, path: holdFile(home, env), w: new HoldFileWriter({ home, env }) };
};

const NOW = 1_761_000_000_000;                      // a made-up instant: 2025-10-20T22:40:00Z, a whole second
const SINCE = "2025-10-20T22:40:00Z";

describe("HoldFileWriter (§5, §6.2 steps 3 and 7)", () => {
  it("writes a hold the services' own reader holds each named service to, and only those", () => {
    const t = writer();
    t.w.write({ services: ["hub", "fleet"], reason: "drain", version: "0.2.0", since: NOW });
    for (const service of ["hub", "fleet"] as const) {
      expect(readHold({ path: t.path, service, now: NOW + 1000 })).toEqual({
        kind: "held",
        hold: { services: ["hub", "fleet"], reason: "drain", version: "0.2.0", since: SINCE },
      });
    }
    expect(readHold({ path: t.path, service: "node", now: NOW + 1000 }))
      .toEqual({ kind: "ignored", why: "other-service" });
  });

  it("a probation hold reads back the same way", () => {
    const t = writer();
    t.w.write({ services: ["node"], reason: "probation", version: "0.3.0", since: NOW });
    expect(readHold({ path: t.path, service: "node", now: NOW + 1000 })).toMatchObject({
      kind: "held",
      hold: { reason: "probation", version: "0.3.0" },
    });
  });

  it("refuses a hold the wire would call malformed, and writes nothing", () => {
    const t = writer();
    expect(() => t.w.write({ services: ["hub"], reason: "drain", version: "0.2.0.1", since: NOW })).toThrow();
    expect(readHold({ path: t.path, service: "hub", now: NOW })).toEqual({ kind: "absent" });
  });

  it("clear() removes the hold: the services read it as absent", () => {
    const t = writer();
    t.w.write({ services: ["hub"], reason: "drain", version: "0.2.0", since: NOW });
    t.w.clear();
    expect(readHold({ path: t.path, service: "hub", now: NOW + 1000 })).toEqual({ kind: "absent" });
  });

  it("a write that cannot land leaves the hold that is already there (atomic: temp, rename)", () => {
    const t = writer();
    t.w.write({ services: ["hub"], reason: "drain", version: "0.2.0", since: NOW });
    mkdirSync(`${t.path}.tmp`);                                // a directory where the temp file goes: the rename cannot run
    expect(() => t.w.write({ services: ["hub"], reason: "drain", version: "0.3.0", since: NOW })).toThrow();
    expect(readHold({ path: t.path, service: "hub", now: NOW + 1000 }))
      .toMatchObject({ kind: "held", hold: { version: "0.2.0" } });
    rmSync(`${t.path}.tmp`, { recursive: true, force: true });
    t.w.write({ services: ["hub"], reason: "drain", version: "0.3.0", since: NOW });   // and it recovers
    expect(readHold({ path: t.path, service: "hub", now: NOW + 1000 }))
      .toMatchObject({ kind: "held", hold: { version: "0.3.0" } });
  });

  it("the hold file is private to its owner (0600)", () => {
    const t = writer();
    t.w.write({ services: ["hub"], reason: "drain", version: "0.2.0", since: NOW });
    expect((statSync(t.path).mode & 0o777).toString(8)).toBe("600");
  });
});
