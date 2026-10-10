// The join-code lifecycle (spec 5.1, 9 "Unit"): single use, 10 minutes on the fleet's wall clock, bound to the name
// it was issued for, only its hash stored. Negative controls: a reused code, an expired code and a code used with
// another name are each refused.
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { openFleetDb } from "../src/adapters/db.ts";
import { NodesStore } from "../src/adapters/nodes-store.ts";
import { tempDir } from "./helpers/temp.ts";

const spki = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
const setup = () => {
  let now = 1_800_000_000_000;
  const db = openFleetDb(join(tempDir(), "fleet.db"));
  return { db, nodes: new NodesStore(db, () => now), tick: (ms: number) => { now += ms; } };
};
const codeOf = (r: ReturnType<NodesStore["issueCode"]>) => { if (!r.ok) throw new Error(r.refused); return r.code; };

describe("join codes", () => {
  it("a code registers its node with the joining key, once", () => {
    const { nodes } = setup();
    const key = spki();
    const code = codeOf(nodes.issueCode("pc"));
    expect(Buffer.from(code, "base64url")).toHaveLength(16);                        // 128 bits
    expect(nodes.redeem(code, "pc", key)).toEqual({ ok: true, node: "pc" });
    expect(nodes.active("pc")?.publicKey).toBe(key);
    expect(nodes.redeem(code, "pc", spki())).toEqual({ ok: false, refused: "used" });     // negative control: reuse
    expect(nodes.active("pc")?.publicKey).toBe(key);                                // the first key stays
  });

  it("expires after 10 minutes on the fleet's clock", () => {
    const { nodes, tick } = setup();
    const late = codeOf(nodes.issueCode("pc"));
    const inTime = codeOf(nodes.issueCode("pc"));
    tick(LIMITS.joinCodeTtlMs - 1);
    expect(nodes.redeem(inTime, "pc", spki())).toEqual({ ok: true, node: "pc" });
    const other = codeOf(nodes.issueCode("mac"));
    tick(LIMITS.joinCodeTtlMs);
    expect(nodes.redeem(other, "mac", spki())).toEqual({ ok: false, refused: "expired" });   // negative control: expired
    expect(nodes.redeem(late, "pc", spki())).toEqual({ ok: false, refused: "expired" });
    expect(nodes.active("mac")).toBeNull();
  });

  it("a code issued for one name can never register another", () => {
    const { nodes } = setup();
    const forA = codeOf(nodes.issueCode("node-a"));
    const forB = codeOf(nodes.issueCode("node-b"));
    expect(nodes.redeem(forA, "node-b", spki())).toEqual({ ok: false, refused: "wrong_node" });   // negative control: wrong name
    expect(nodes.list()).toEqual([]);                                                 // nothing stored
    expect(nodes.redeem(forA, "node-a", spki())).toEqual({ ok: true, node: "node-a" });   // the code stayed unused
    expect(nodes.redeem(forB, "node-b", spki())).toEqual({ ok: true, node: "node-b" });   // B's own code still works for B
    expect(nodes.list().map(n => n.name)).toEqual(["node-a", "node-b"]);
  });

  it("keeps only the code's hash", () => {
    const { db, nodes } = setup();
    const code = codeOf(nodes.issueCode("pc"));
    const rows = JSON.stringify(db.prepare("SELECT * FROM join_codes").all());
    expect(rows).not.toContain(code);
    expect(rows).not.toContain(Buffer.from(code, "base64url").toString("hex"));
    expect(rows).toMatch(/"hash":"[0-9a-f]{64}"/);
  });

  it("refuses unknown and malformed codes, bad keys and bad names", () => {
    const { nodes } = setup();
    expect(nodes.redeem(Buffer.alloc(16, 7).toString("base64url"), "pc", spki())).toEqual({ ok: false, refused: "unknown" });
    expect(nodes.redeem("short", "pc", spki())).toEqual({ ok: false, refused: "unknown" });
    expect(nodes.redeem(`${codeOf(nodes.issueCode("pc"))}=`, "pc", spki())).toEqual({ ok: false, refused: "unknown" });
    expect(nodes.redeem(codeOf(nodes.issueCode("pc")), "pc", "not-a-key")).toEqual({ ok: false, refused: "bad_key" });
    for (const name of ["PC", "", "a".repeat(33), "pc.1", "pc/x", "pc ü"]) expect(nodes.issueCode(name)).toEqual({ ok: false, refused: "bad_name" });
  });

  it("an active node gets no new code until it is revoked; a revoked node joins again with a new key", () => {
    const { nodes } = setup();
    const first = codeOf(nodes.issueCode("pc"));
    const second = codeOf(nodes.issueCode("pc"));
    expect(nodes.redeem(first, "pc", spki())).toEqual({ ok: true, node: "pc" });
    expect(nodes.redeem(second, "pc", spki())).toEqual({ ok: false, refused: "exists" });   // a second code can't swap the key
    expect(nodes.issueCode("pc")).toEqual({ ok: false, refused: "exists" });
    expect(nodes.revoke("pc")).toBe(true);
    expect(nodes.revoke("pc")).toBe(false);
    expect(nodes.active("pc")).toBeNull();
    const fresh = spki();
    expect(nodes.redeem(codeOf(nodes.issueCode("pc")), "pc", fresh)).toEqual({ ok: true, node: "pc" });
    expect(nodes.active("pc")?.publicKey).toBe(fresh);
  });

  it("revoking withdraws the node's unused codes", () => {
    const { nodes } = setup();
    expect(nodes.redeem(codeOf(nodes.issueCode("pc")), "pc", spki())).toEqual({ ok: true, node: "pc" });
    nodes.revoke("pc");
    const pending = codeOf(nodes.issueCode("pc"));
    nodes.revoke("pc");                                                              // nothing active to revoke, but the code goes
    expect(nodes.redeem(pending, "pc", spki())).toEqual({ ok: false, refused: "unknown" });
  });

  it("connection epochs only grow", () => {
    const { nodes } = setup();
    nodes.redeem(codeOf(nodes.issueCode("pc")), "pc", spki());
    expect([nodes.nextEpoch("pc"), nodes.nextEpoch("pc"), nodes.nextEpoch("pc")]).toEqual([1, 2, 3]);
    expect(() => nodes.nextEpoch("nobody")).toThrow(/no node/);
  });
});
