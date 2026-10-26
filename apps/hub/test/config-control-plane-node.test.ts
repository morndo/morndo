// MORNDO_CONTROL_PLANE_NODE: the fleet node name of the node agent that runs beside the hub, on the control plane's own
// machine. The Updates page folds that node into "This machine". It is not MORNDO_ENGINE_NODE, which names the node
// the engine lanes run on (the live hub sets that to another machine). Unset or empty: no node is folded in.
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("MORNDO_CONTROL_PLANE_NODE", () => {
  it("is null unless set", () => {
    expect(loadConfig({}).controlPlaneNode).toBeNull();
    expect(loadConfig({ MORNDO_CONTROL_PLANE_NODE: "" }).controlPlaneNode).toBeNull();
  });

  it("is the node's name, apart from the engine node: the live shape has the engine lanes on pc and the control plane's own node cp", () => {
    const c = loadConfig({ MORNDO_ENGINE_NODE: "pc", MORNDO_CONTROL_PLANE_NODE: "cp" });
    expect(c.engineNode).toBe("pc");
    expect(c.controlPlaneNode).toBe("cp");
    expect(loadConfig({ MORNDO_ENGINE_NODE: "pc" }).controlPlaneNode).toBeNull();   // the engine node never stands in for it
  });
});
