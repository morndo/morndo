// Merge liveness (B11): the domain's livenessOf over the nodes' builds, with each ancestry answer cached per
// (merge, build) pair — settled answers for good, unknown only until the operator may have updated the checkout.
// A spy for ancestry, a fake clock; synthetic commits.
import { describe, expect, it } from "vitest";
import { mergeLabel } from "@morndo/domain";
import { MergeLiveness } from "../src/application/merge-liveness.ts";

const SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const OTHER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BUILD1 = "1111111111111111111111111111111111111111";
const BUILD2 = "2222222222222222222222222222222222222222";
const BEHIND = "9999999999999999999999999999999999999999";
const ON_ABC = "abc1234deadbeef0123456789abcdef012345678";

describe("merge liveness (B11)", () => {
  it("asks ancestry once per distinct pair, across repeated calls and across shas sharing a build", () => {
    const asked: string[] = [];
    const l = new MergeLiveness({
      builds: () => [{ node: "pc", commit: BUILD1 }, { node: "srv01", commit: BUILD2 }],
      ancestry: (m, b) => { asked.push(`${m.slice(0, 7)}/${b.slice(0, 7)}`); return b === BUILD2 ? "not_ancestor" : "ancestor"; },
      now: () => 1000,
    });
    expect(l.of(SHA)).toEqual({ live: false, blockers: [{ node: "srv01", on: BUILD2 }] });
    expect(l.of(SHA)).toEqual({ live: false, blockers: [{ node: "srv01", on: BUILD2 }] });
    expect(l.of(OTHER)).toEqual({ live: false, blockers: [{ node: "srv01", on: BUILD2 }] });
    expect(asked).toEqual([`${SHA.slice(0, 7)}/${BUILD1.slice(0, 7)}`, `${SHA.slice(0, 7)}/${BUILD2.slice(0, 7)}`,
      `${OTHER.slice(0, 7)}/${BUILD1.slice(0, 7)}`, `${OTHER.slice(0, 7)}/${BUILD2.slice(0, 7)}`]);
    expect(l.of(SHA).live).toBe(false);                        // still no new call
    expect(asked).toHaveLength(4);
  });

  it("unknown is asked again only after its TTL; a build moving forward makes the merge live", async () => {
    let t = 1000;
    let asked = 0;
    let build = BEHIND;
    const l = new MergeLiveness({
      builds: () => [{ node: "pc", commit: build }],
      ancestry: () => { asked++; return build === BEHIND ? "unknown" : "ancestor"; },
      now: () => t,
      unknownTtlMs: 30_000,
    });
    expect(l.of(SHA)).toEqual({ live: false, blockers: [{ node: "pc", on: null }] });
    t += 10_000;
    expect(l.of(SHA).live).toBe(false);                        // inside the TTL: the cached unknown stands
    expect(asked).toBe(1);
    t += 21_000;                                               // past it: asked again
    expect(l.of(SHA).live).toBe(false);
    expect(asked).toBe(2);
    // the node reports a newer build: a new pair, and the merge is live (B11 at the hub level)
    build = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(l.of(SHA)).toEqual({ live: true });
    expect(asked).toBe(3);
  });

  it("the label names each blocker: a node behind, and a node unknown", () => {
    let asked = 0;
    const l = new MergeLiveness({
      builds: () => [{ node: "pc", commit: ON_ABC }, { node: "srv01", commit: null }],
      ancestry: () => { asked++; return "not_ancestor"; },
      now: () => 1000,
    });
    expect(mergeLabel([l.of(SHA)])).toBe("merged, not live: pc on abc1234, srv01 unknown");
    expect(asked).toBe(1);                                     // srv01's null commit is never asked of git
  });
});
