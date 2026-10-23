// Worker IDs across a fleet (docs/design/fleet-core/README.md §4): `<node>.<server>.<pane>`, parsed and formatted in
// one place. Synthetic IDs only.
import { describe, expect, it } from "vitest";
import { formatWorkerId, isNodeName, isWorkerOrLegacyId, menuEscalationId, parseWorkerId } from "../src/index.ts";

describe("worker IDs", () => {
  it("format and parse are each other's inverse", () => {
    expect(formatWorkerId({ node: "pc", server: "3fa2c1d0", pane: 12 })).toBe("pc.3fa2c1d0.12");
    expect(parseWorkerId("pc.3fa2c1d0.12")).toEqual({ node: "pc", server: "3fa2c1d0", pane: 12 });
    for (const ref of [{ node: "control-plane", server: "00000000", pane: 0 }, { node: "a".repeat(32), server: "ffffffff", pane: 999_999_999 }]) {
      expect(parseWorkerId(formatWorkerId(ref))).toEqual(ref);
    }
  });
  it("are URL-safe as they are", () => {
    const id = formatWorkerId({ node: "mac-studio", server: "0a1b2c3d", pane: 7 });
    expect(encodeURIComponent(id)).toBe(id);
  });
  it("parse refuses anything else, a legacy pane ID included (negative controls)", () => {
    for (const id of ["%3", "pc.3fa2c1d0", "PC.3fa2c1d0.1", "pc.3FA2C1D0.1", "pc.3fa2c1d.1", "pc.3fa2c1d0.1234567890", "pc.3fa2c1d0.-1",
      "pc.3fa2c1d0.1.5", `${"a".repeat(33)}.3fa2c1d0.1`, "pc.3fa2c1d0.12 ", " pc.3fa2c1d0.12", "pc_3fa2c1d0_12", "", "main:0.%1"]) {
      expect(parseWorkerId(id), id).toBeNull();
    }
  });
  it("one pane has one ID: the pane number has no leading zeros (the server's 8 hex digits keep theirs)", () => {
    for (const id of ["pc.3fa2c1d0.012", "pc.3fa2c1d0.00", "pc.3fa2c1d0.0000000001"]) expect(parseWorkerId(id), id).toBeNull();
    expect(parseWorkerId("pc.3fa2c1d0.0")).toEqual({ node: "pc", server: "3fa2c1d0", pane: 0 });
    expect(parseWorkerId("pc.00a2c1d0.10")).toEqual({ node: "pc", server: "00a2c1d0", pane: 10 });
    expect(formatWorkerId({ node: "pc", server: "3fa2c1d0", pane: 12 })).toBe("pc.3fa2c1d0.12");
  });
  it("format throws rather than build a wrong ID", () => {
    for (const ref of [{ node: "PC", server: "3fa2c1d0", pane: 1 }, { node: "pc", server: "xyz", pane: 1 }, { node: "pc", server: "3fa2c1d0", pane: 1.5 },
      { node: "pc", server: "3fa2c1d0", pane: -1 }, { node: "pc", server: "3fa2c1d0", pane: Number.NaN }, { node: "", server: "3fa2c1d0", pane: 1 },
      { node: "a.b", server: "3fa2c1d0", pane: 1 }]) {
      expect(() => formatWorkerId(ref), JSON.stringify(ref)).toThrow(TypeError);
    }
  });
  it("a worker ID or a legacy pane ID is either; nothing else is", () => {
    expect(isWorkerOrLegacyId("pc.3fa2c1d0.12")).toBe(true);
    expect(isWorkerOrLegacyId("%12")).toBe(true);
    for (const id of ["%", "12", "main:0", "%1;kill-server", "pc.3fa2c1d0.12\n"]) expect(isWorkerOrLegacyId(id), id).toBe(false);
  });
});

describe("menu escalation IDs", () => {
  it("dots become underscores; a legacy pane gives the ID the hub always gave it (menu-N)", () => {
    expect(menuEscalationId("pc.3fa2c1d0.12")).toBe("menu-pc_3fa2c1d0_12");
    const legacy = (pane: string) => `menu-${pane.replace(/^%/, "")}`;      // escalation-service.ts until now
    expect(menuEscalationId("%3")).toBe(legacy("%3"));
  });
});

describe("a node's name", () => {
  it("is NODE_NAME's shape and none of the reserved names: control-plane names the control plane's own machine", () => {
    for (const ok of ["pc", "srv01", "mac-studio", "a".repeat(32)]) expect(isNodeName(ok)).toBe(true);
    for (const bad of ["control-plane", "PC", "", "a".repeat(33), "pc.1"]) expect(isNodeName(bad)).toBe(false);
  });
});

