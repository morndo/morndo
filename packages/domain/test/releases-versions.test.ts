// A Version is a SemVer 2.0.0 version (ADR-0019; the spec, §3: "A Version is one SemVer 2.0.0 string for the whole
// product"). The order here is the order of the spec's own §11, whose example chain is the test below verbatim.
import { describe, expect, it } from "vitest";
import { compareVersions, formatVersion, parseVersion } from "../src/releases.ts";

const v = (s: string) => {
  const p = parseVersion(s);
  if (!p) throw new Error(`${s} did not parse`);
  return p;
};
const lt = (a: string, b: string) => expect(compareVersions(v(a), v(b))).toBe(-1);
const eq = (a: string, b: string) => expect(compareVersions(v(a), v(b))).toBe(0);

describe("parseVersion", () => {
  it("parses core, pre-release and build (negative control: nothing else parses)", () => {
    expect(v("1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3, pre: null, build: null });
    expect(v("0.5.0-alpha.1")).toMatchObject({ pre: ["alpha", "1"], build: null });
    expect(v("1.0.0-x.7.z.92+001")).toMatchObject({ pre: ["x", "7", "z", "92"], build: "001" });
    for (const bad of ["", "1", "1.0", "1.0.0.0", "01.0.0", "1.01.0", "1.0.00", "1.0.0-", "1.0.0+", "1.0.0-01",
      "1.0.0-alpha..1", "1.0.0-alpha_1", "1.0.0+alpha..1", "v1.0.0", "1.0.0-α", " 1.0.0", "1.0.0 ", "1.0.0-alpha+"])
      expect(parseVersion(bad), bad).toBeNull();
  });
  it("build identifiers may carry leading zeros and a pre-release may carry letters after a zero", () => {
    expect(v("1.0.0+0a.00")).toBeTruthy();
    expect(v("1.0.0-0a")).toBeTruthy();
  });
  it("formats back to what it parsed (negative control: a round trip that changes the version)", () => {
    for (const s of ["1.2.3", "0.5.0-alpha.1", "1.0.0-x.7.z.92+001", "0.0.1-0", "2.0.0-rc.1+build.5"])
      expect(formatVersion(v(s)), s).toBe(s);
  });
});

describe("compareVersions (the spec's §11 chain, verbatim)", () => {
  it("1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0", () => {
    const chain = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
      "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 0; i + 1 < chain.length; i++) lt(chain[i]!, chain[i + 1]!);
  });
  it("numeric identifiers compare numerically, alphanumeric ones in ASCII order, and numeric sorts lower", () => {
    lt("1.0.0-2", "1.0.0-10");
    lt("1.0.0-alpha", "1.0.0-beta");
    lt("1.0.0-1", "1.0.0-alpha");
    lt("1.0.2", "1.0.10");
    lt("1.9.0", "1.10.0");
  });
  it("a larger set of pre-release fields has a higher precedence when the prefix is equal", () => {
    lt("1.0.0-alpha", "1.0.0-alpha.1");
  });
  it("a release outranks its own pre-releases; build metadata decides nothing", () => {
    lt("1.0.0-rc.1", "1.0.0");
    eq("1.0.0", "1.0.0+build.1");
    eq("1.0.0-alpha", "1.0.0-alpha+001");
    eq("1.0.0+build", "1.0.0+other");
  });
});
