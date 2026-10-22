// The updates service's ports (updates design §8.1, PR 6c): the fleet, the control plane's updater CLI, and what a
// fleet write answers. Shapes only, no I/O — the adapters beside the service fill them (fleet-updates.ts,
// updater-cli.ts), so the service stays a decision: who may command, what stands staged, which assertion signs.
import type { FleetNode, RolloutWire, UpdateStateFile, UpdaterStatus } from "@morndo/protocol";

// The control plane's own updater, as the hub asks it: the CLI this tree installs beside the hub
// (`morndo-update`). `status` is `update --status --json`; null when it did not answer or its answer didn't fit —
// the view shows that as it is, and a command to the control plane refuses, because the hub will not move its own
// machine on a guess. The two detached commands start the move and return at once (PR 6c part 3): the hub never
// waits out an update of the machine it runs on. The argument lists are UPDATER_ARGS's (packages/protocol, R1),
// never spelled at a call site: the apply carries the pressed Version (R3's --staged).
export type UpdaterCli = {
  status(): Promise<UpdaterStatus | null>;
  state(): Promise<UpdateStateFile | null>;        // its state.json: the last record, why it waits; null without one
  applyDetached(version: string): Promise<void>;   // update --yes --detach --staged <v>, to exactly the pressed Version
  rollbackDetached(): Promise<void>;               // update --rollback --yes --detach, to the Version it ran before
};

// What a fleet write answers (§5.4): taken; the fleet's own refusal with its words; or no fleet to ask.
export type FleetWriteOutcome =
  | { ok: true }
  | { ok: false; problem: "refused"; code: string; message: string }
  | { ok: false; problem: "unavailable"; message: string };

// The fleet as the updates service needs it: the Rollout and the nodes for the view, the two writes for the
// commands, each carrying the hub's signed assertion for exactly its ask (§5.4) when the hub sends one. A read the
// fleet can't answer is `unavailable`, never a guess at what it would have said.
export type FleetForUpdates = {
  rollout(): Promise<{ ok: true; rollout: RolloutWire | null; aboveControlPlane: RolloutWire[] } | { ok: false; problem: "unavailable"; message: string }>;
  nodes(): Promise<{ ok: true; nodes: FleetNode[] } | { ok: false; problem: "unavailable"; message: string }>;
  applyUpdate(node: string, version: string, principal: string): Promise<FleetWriteOutcome>;
  resumeRollout(version: string, principal: string): Promise<FleetWriteOutcome>;
};
