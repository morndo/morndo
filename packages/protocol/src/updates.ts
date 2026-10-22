// The hub's updates view and its command bodies (updates design §8.1, PR 6c): what GET /api/updates answers and
// what the three commands post. The view is an answer, not a signed document: it joins what the fleet says (the
// Rollout, each node) with what the control plane's own updater printed (`morndo update --status --json`) and the
// hub's own build — the hub is the control plane (§7), so its Version is the ceiling every node's Version answers
// against. Shapes only: the service that fills it is apps/hub/src/application/updates-service.ts.
import * as z from "./z.ts";
import { UpdateStatusSchema } from "./releases.ts";
import { SEMVER } from "./releases.ts";
import { NODE_NAME } from "./worker-id.ts";
import type { NodeUpdateHealth, RolloutWire } from "./fleet.ts";

// The argument lists the hub runs the control plane's updater CLI with (PR 6c): one place, so the hub, its tests
// and the updater's own command line cannot drift apart — the updater's first word is its command (`update`;
// apps/updater/src/cli.ts answers the usage text, exit 64, for anything else). `apply` takes the Version the
// Updates screen pressed, and `--staged` (round 2, R3) makes that the only one the run applies.
export const UPDATER_ARGS = {
  /** What this machine believes: `update --status --json`. */
  status: ["update", "--status", "--json"],
  /** Apply exactly the pressed Version, detached: `update --yes --detach --staged <v>`. */
  apply: (version: string): string[] => ["update", "--yes", "--detach", "--staged", version],
  /** Back to the Version before, detached: `update --rollback --yes --detach`. */
  rollback: ["update", "--rollback", "--yes", "--detach"],
};

// What `morndo update --status --json` prints, as the hub passes it on (§8.1): null when the updater did not answer.
export type UpdaterStatus = z.output<typeof UpdateStatusSchema>;
export type UpdatesNodeStatus = "online" | "stale" | "offline";
export type UpdatesNode = {
  name: string;
  status: UpdatesNodeStatus;
  version: string | null;                 // the agent's Version; null before it said one
  proto: number[] | null;                 // the protocol versions its hello named; null when it is not connected
  update: NodeUpdateHealth | null;        // its updater's last report; null before any
};
export type UpdatesView = {
  controlPlane: { version: string; commit: string | null; status: UpdaterStatus | null };
  rollout: RolloutWire | null;
  aboveControlPlane: RolloutWire[];
  nodes: UpdatesNode[];
};

// The machine a command names: "control-plane" (this machine, through its updater CLI) or a node's name (through
// the fleet). A Release's Version carries no build metadata, the same rule the Rollout's own words hold.
const releaseVersion = () => z.string().check(z.regex(SEMVER), z.refine(v => !v.includes("+"), "a Release's Version carries no build metadata"));
const machine = () => z.string().check(z.regex(NODE_NAME));
export const UpdatesApplyBody = z.strictObject({ machine: machine(), version: releaseVersion() });
export const UpdatesRollbackBody = z.strictObject({ machine: machine() });
export const UpdatesResumeBody = z.strictObject({ version: releaseVersion() });
