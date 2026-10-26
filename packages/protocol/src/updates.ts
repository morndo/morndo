// The hub's updates view and its command bodies (updates design §8.1, PR 6c): what GET /api/updates answers and
// what the three commands post. The view is an answer, not a signed document: it joins what the fleet says (the
// Rollout, each node) with what the control plane's own updater printed (`morndo update --status --json`) and the
// hub's own build — the hub is the control plane (§7), so its Version is the ceiling every node's Version answers
// against. Shapes only: the service that fills it is apps/hub/src/application/updates-service.ts.
import * as z from "./z.ts";
import { UpdateStatusSchema } from "./releases.ts";
import { SEMVER } from "./releases.ts";
import { NODE_NAME } from "./worker-id.ts";
import type { NodeUpdateHealth, RolloutWire, UpdateStateFile } from "./fleet.ts";
import type { DatabaseName } from "@morndo/domain";

// The argument lists the hub runs the control plane's updater CLI with (PR 6c): one place, so the hub, its tests
// and the updater's own command line cannot drift apart — the updater's first word is its command (`update`;
// apps/updater/src/cli.ts answers the usage text, exit 64, for anything else). `apply` takes the Version the
// Updates screen pressed, and `--staged` (round 2, R3) makes that the only one the run applies. The rollback's
// preview is read-only (what a rollback would drop); its command carries the word a restore demands (§11.4,
// review round 1): `--yes` answers the [y/N], never the typed word.
export const UPDATER_ARGS = {
  /** What this machine believes: `update --status --json`. */
  status: ["update", "--status", "--json"],
  /** Apply exactly the pressed Version, detached: `update --yes --detach --staged <v>`. */
  apply: (version: string): string[] => ["update", "--yes", "--detach", "--staged", version],
  /** What a rollback would drop, read-only: `update --rollback --preview --json`. */
  rollbackPreview: ["update", "--rollback", "--preview", "--json"],
  /** Back to the Version before, detached: `update --rollback --yes --detach [--typed <word>]`. */
  rollback: (word?: string): string[] => ["update", "--rollback", "--yes", "--detach", ...(word === undefined ? [] : ["--typed", word])],
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
  // `state`: the control plane's updater's last record (its state.json, as the fleet reads it too): why it waits,
  // which --status does not say. Null when there is none, or it is not the protocol's shape. `node`: the fleet node
  // the control plane's own node agent is (MORNDO_CONTROL_PLANE_NODE); the Updates page shows it inside This machine;
  // null when the hub is not told it.
  controlPlane: { version: string; commit: string | null; status: UpdaterStatus | null; state: UpdateStateFile | null; node?: string | null };
  rollout: RolloutWire | null;
  aboveControlPlane: RolloutWire[];
  nodes: UpdatesNode[];
};

// The machine a command names: "control-plane" (this machine, through its updater CLI) or a node's name (through
// the fleet). A Release's Version carries no build metadata, the same rule the Rollout's own words hold.
const releaseVersion = () => z.string().check(z.regex(SEMVER), z.refine(v => !v.includes("+"), "a Release's Version carries no build metadata"));
const machine = () => z.string().check(z.regex(NODE_NAME));
export const UpdatesApplyBody = z.strictObject({ machine: machine(), version: releaseVersion() });
export const UpdatesRollbackBody = z.strictObject({ machine: machine(), word: z.exactOptional(z.string().check(z.maxLength(32))) });
export const UpdatesResumeBody = z.strictObject({ version: releaseVersion() });

// What `update --rollback --preview --json` answers (§11.4, review round 1): the Versions a rollback would move
// between, and each database whose Backup a restore would put back, with the moment that Backup was taken — the
// span of writes the restore drops, the same moment the human text prints. Strict, as every wire shape here: a
// preview the hub cannot read whole is no preview (the service answers unavailable, never a guess).
const DB_WORDS = ["hub", "fleet", "node", "connections"] as const satisfies readonly DatabaseName[];
export const RollbackPreviewSchema = z.strictObject({
  from: releaseVersion(),
  to: releaseVersion(),
  restores: z.array(z.strictObject({ db: z.enum(DB_WORDS), at: z.string().check(z.iso.datetime()) })),
});
export type RollbackPreview = z.output<typeof RollbackPreviewSchema>;
