// The hub's ports onto the machines its workers run on (fleet core §3.1, ADR-0012). Each has a local implementation,
// this machine as the one node "local" (adapters/local-node.ts), and a fleet one (Task 14), chosen in main.ts by
// MORNDO_FLEET_SOCKET. Worker IDs are opaque here: "%N" locally, "<node>.<server>.<pane>" in a fleet.
import type { Upload } from "@morndo/domain";
import type { Frame, SendProblem, SessionInfo, Terminal as PaneTerminal } from "@morndo/node-ops";
import type { ErrorCode } from "@morndo/protocol";

// `typedAt`: when the node typed it, on the node's own clock, which that node's transcript times are on (echo matching).
// "node_offline": the fleet refused it before anything was typed (fleet core §5.3, §7; never from this machine's tmux).
// `store` (fleet, Task 14): the store of the node that answered, the agent database its keys are kept in (fleet core §3.1).
// `storeSeq`: that database's store sequence as it answered (final review I2; null when unknown), kept beside the store.
// A SendRefused problem is a definite refusal from the node or the fleet (below).
export type SendOutcome = { problem: SendProblem | "node_offline" | SendRefused | null; typedAt: number; store?: string | null; storeSeq?: number | null };
// A send the node or the fleet refused saying nothing ran (executed "no", its key released; fleet core §5.3; ADR-0012
// decision 7: "Refusals that happened before any side effect release the key"): a policy without pane.send ("denied"),
// arguments the protocol or the fleet's schema check refuses ("bad_args": a window name holding a control character, plan
// Review Focus 1), a message over the size limit ("too_large"), an agent that doesn't know the op ("unknown_op"), an
// agent's own failure before the side effect ("internal" with executed "no": a full disk before keys.start), or a route
// by a name ("name_taken", "lane_conflict"). Every error code but the ones the fleet adapters map to a SendProblem, and
// "uncertain", which is in doubt whatever its executed says. The caller releases its row and the owner sees the refusal,
// so a retry types once the cause is fixed (final review M1, widened by ruling; never from this machine's tmux).
export type SendRefused = Exclude<ErrorCode, "no_pane" | "menu_open" | "no_input_box" | "draft_present" | "busy" | "node_offline" | "timeout" | "uncertain">;
export const SEND_REFUSALS = ["denied", "bad_args", "too_large", "unknown_op", "internal", "name_taken", "lane_conflict"] as const satisfies readonly SendRefused[];
export type Tmux = {            // replaces the port of the same name; the adapters implement it
  // `offline`: its node is not online now; it stays listed with its last screen (fleet core §3.1, §7). Legacy: false.
  // `conflict` (fleet, Task 14): the lane registry has this name in conflict (two windows claim it); legacy never says.
  listWorkers(): Promise<{ id: string; name: string; location: string; node: string; offline: boolean; conflict?: boolean }[]>;
  capture(id: string): Promise<string | null>;
  captureMany(ids: string[]): Promise<Map<string, string | null>>;
  // `key`: the caller's idempotency key. A node that already typed it answers the stored outcome instead of typing again.
  send(id: string, text: string, key: string): Promise<SendOutcome>;
};
// What the worker's node knows of a key (op.status, Task 14): "done" with the node's own typedAt, or not (yet), or the
// node can't be asked. "unknown" names the store that answered: only the store that took the send can say it never
// started (a new or restored agent database has lost its keys, fleet core §3.1). And its store sequence now (null from an
// agent that sends none): lower than the one kept with the send, that store's database went backwards (final review I2).
export type SendStatus = (id: string, key: string) =>
  Promise<{ state: "unknown"; store: string; storeSeq: number | null } | { state: "started" | "offline" } | { state: "done"; typedAt: number }>;
// A send whose node may have typed it (executed "maybe": the connection dropped, or the fleet took it and never
// answered). `store`: the store it went to, null when no answer came; `storeSeq`: that store's sequence as the answer
// gave it, null when unknown. The caller keeps both with its row in doubt (Task 14; final review I2).
export class SendInDoubt extends Error {
  readonly store: string | null;
  readonly storeSeq: number | null;
  constructor(store: string | null, message: string, options?: ErrorOptions & { storeSeq?: number | null }) {
    super(message, options);
    this.name = "SendInDoubt";
    this.store = store;
    this.storeSeq = options?.storeSeq ?? null;
  }
}
export type Sessions = { byPane(): Promise<Map<string, SessionInfo>> };   // pane = worker ID
export type TranscriptSource = {
  size(sessionId: string): Promise<number | null>;
  read(sessionId: string, offset: number, max: number): Promise<{ bytes: Uint8Array; eof: boolean } | null>;
  locate(sessionId: string, needle: string): Promise<number | null>;
};
// A transcript source that can't answer now (its node offline, the fleet down or slow: Task 14's fleet source) throws
// this; null from size or read means the transcript is gone. Observation keeps a follow's place through it and reads on
// from there on the next poll; it starts a follow over only on null (fleet core §3.1).
export class SourceUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "SourceUnavailable"; }
}
export type RemoteFiles = { register(workerId: string, path: string): Promise<{ id: string | null; size: number | null }> };
export type UploadSink = { stage(upload: Upload, workerId: string): Promise<{ ok: true; path: string } | { ok: false; problem: "no_pane" | "too_large" | "node_offline" }> };
// Which nodes answer now (fleet core §3.1: a node that is not online is skipped at once). A node missing from the map is
// not online. Unset (legacy single-host mode), every node counts as online.
export type NodeState = "online" | "stale" | "offline";
export type NodeStates = () => Promise<ReadonlyMap<string, NodeState>>;

// One engine lane from this machine's registry. `status` is busy or idle. `engine` is set for an engine lane;
// a report without one does not govern the worker. The registry's `name` is the tmux window name.
export const LANE_STATUSES = ["busy", "idle"] as const;
export type LaneStatus = (typeof LANE_STATUSES)[number];
export type LaneReport = { name: string; status: LaneStatus; engine: string | null };
export type LaneStatuses = () => Promise<readonly LaneReport[]>;

// The terminal view's port: node-ops' Terminal, except that
// - keys may answer "uncertain": the node may have typed them (the connection dropped while they were out), so the app
//   says "may have been typed", never "refused" (Task 14);
// - a frame may be "unavailable": its node can't give one now (a timeout, the node offline, the fleet unreachable), so
//   the view stays open and asks again on its next tick. null is the pane gone, which closes it (final review M5).
export type Terminal = Omit<PaneTerminal, "keys" | "frame"> & {
  frame(id: string): Promise<Frame | null | "unavailable">;
  keys(id: string, data: string): Promise<boolean | "uncertain">;
};

// Every port the hub's services take, as one set: the legacy local adapters (local-ports.ts) or the fleet's
// (fleet-adapters.ts), chosen by MORNDO_FLEET_SOCKET (spec §10). `sendStatus` and `nodeStates` are the fleet's alone.
export type HubPorts = {
  tmux: Tmux; terminal: Terminal; sessions: Sessions | null; transcripts: TranscriptSource | null;
  files: RemoteFiles; uploads: UploadSink; sendStatus: SendStatus | null; nodeStates: NodeStates | null;
};
