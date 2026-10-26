// How the hub's settings reach the updates service (apps/hub/src/adapters/updates-wiring.ts): MORNDO_CONTROL_PLANE_NODE
// ends up as the view's `controlPlane.node`, which is what folds the control plane's own node into This machine. The
// service has its own tests; this one fails when the setting stops reaching it.
import { describe, expect, it } from "vitest";
import type { AccessPolicy } from "@morndo/domain";
import { updatesServiceFor } from "../src/adapters/updates-wiring.ts";
import { loadConfig } from "../src/config.ts";
import type { FleetForUpdates, UpdaterCli } from "../src/application/updates-ports.ts";
import type { Store } from "../src/adapters/store.ts";

const fleet: FleetForUpdates = {
  rollout: async () => ({ ok: true, rollout: null, aboveControlPlane: [] }),
  nodes: async () => ({ ok: true, nodes: ["cp", "pc", "srv01"].map(name => ({ name, status: "online" as const, health: null, agent: "0.4.2", commit: null, proto: [1], update: null })) }),
  applyUpdate: async () => ({ ok: true }),
  resumeRollout: async () => ({ ok: true }),
};
const cli = { status: async () => null, state: async () => null } as unknown as UpdaterCli;
const deps = {
  fleet, cli, sign: () => "", store: {} as Store, policy: () => ({ stay: "12h", stepUp: "1h" }) as AccessPolicy,
  build: () => ({ version: "0.4.2", commit: null }),
};

describe("the updates service from the hub's settings", () => {
  it("the live shape: engine node pc, control plane node cp: the view names cp, so cp folds into This machine and pc stays a row", async () => {
    const config = loadConfig({ MORNDO_ENGINE_NODE: "pc", MORNDO_CONTROL_PLANE_NODE: "cp" });
    const view = await updatesServiceFor(config, deps).view();
    expect(view.controlPlane.node).toBe("cp");
    expect(view.nodes.map(n => n.name)).toEqual(["cp", "pc", "srv01"]);          // the page drops cp; the view still lists all
  });

  it("no setting, no node named, whatever the engine node is", async () => {
    const view = await updatesServiceFor(loadConfig({ MORNDO_ENGINE_NODE: "pc" }), deps).view();
    expect(view.controlPlane.node).toBeNull();
  });
});
