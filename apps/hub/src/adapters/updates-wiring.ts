// The updates service from the hub's settings: the one place MORNDO_CONTROL_PLANE_NODE (config.controlPlaneNode) is
// handed to it, so a test can see the setting arrive (apps/hub/test/updates-wiring.test.ts).
import { UpdatesService } from "../application/updates-service.ts";
import type { Config } from "../config.ts";

export const updatesServiceFor = (config: Pick<Config, "controlPlaneNode">, deps: Omit<ConstructorParameters<typeof UpdatesService>[0], "ownNode">): UpdatesService =>
  new UpdatesService({ ...deps, ownNode: config.controlPlaneNode ?? null });
