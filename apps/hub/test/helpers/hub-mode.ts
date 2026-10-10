// The hub's suites in both configurations (spec §9, "Hub: the existing suites, adapted where this spec changes types ...
// They run in both legacy and fleet configuration against a fake fleet"). A suite builds its local ports as the legacy
// hub sees them, keyed by tmux pane ids (fakes, or real adapters on a private tmux server). `portsFor("legacy", …)`
// hands them back as they are; `portsFor("fleet", …)` puts them behind the fake fleet (fake-fleet.ts) as one node and
// hands back the hub's fleet adapters over a real Unix socket. Worker ids differ by mode, so a suite names a pane as
// `ports.id("%1")`.
//   both modes (the default):  npx vitest run apps/hub
//   one mode:                  MORNDO_HUB_MODES=fleet npx vitest run apps/hub/test/steering-durable.test.ts
// The services are built here only (observationFor, steeringFor, escalationsFor), so a constructor change is one edit.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY, type AccessPolicy } from "@morndo/domain";
import { sessionRegistry, type Terminal } from "@morndo/node-ops";
import { formatWorkerId } from "@morndo/protocol";
import { FleetClient } from "../../src/adapters/fleet-client.ts";
import { fleetPorts, type FleetPorts, type FleetTimeouts, type LocalFileStore } from "../../src/adapters/fleet-adapters.ts";
import { localSessions, localTranscripts, localUploads } from "../../src/adapters/local-node.ts";
import type { LedgerRead } from "../../src/adapters/ledger.ts";
import type { Store } from "../../src/adapters/store.ts";
import type { Inbox } from "../../src/adapters/uploads.ts";
import type { HubPorts, RemoteFiles, Sessions, Tmux, TranscriptSource, UploadSink } from "../../src/application/ports.ts";
import { ObservationService } from "../../src/application/observation-service.ts";
import { SteeringService } from "../../src/application/steering-service.ts";
import { EscalationService, type Watch } from "../../src/application/escalation-service.ts";
import { localNode, startFakeFleet, type FakeFleet, type FakeNode, type NodeBackend } from "./fake-fleet.ts";

export type HubMode = "legacy" | "fleet";
export const HUB_MODES: HubMode[] = modes(process.env.MORNDO_HUB_MODES);
function modes(v: string | undefined): HubMode[] {
  const out = (v ?? "legacy,fleet").split(",").map(s => s.trim()).filter(Boolean);
  for (const m of out) if (m !== "legacy" && m !== "fleet") throw new Error(`MORNDO_HUB_MODES: unknown mode "${m}" (legacy, fleet)`);
  return out as HubMode[];
}

export type FleetRig = { fleet: FakeFleet; client: FleetClient; ports: FleetPorts; close(): Promise<void> };
// A fake fleet with these nodes, and the hub's fleet adapters on it, started (events subscribed, nodes looked at).
export async function fleetRig(nodes: FakeNode[], o: { files?: LocalFileStore; timeouts?: Partial<FleetTimeouts> } = {}): Promise<FleetRig> {
  const fleet = await startFakeFleet({ nodes });
  const client = new FleetClient(fleet.socketPath);
  const ports = fleetPorts(client, {
    files: o.files ?? null, stagingDir: mkdtempSync(join(tmpdir(), "morndo-staging-")), ...(o.timeouts ? { timeouts: o.timeouts } : {}),
  });
  await ports.start();
  return { fleet, client, ports, close: async () => { ports.stop(); await fleet.close(); } };
}

// `files` is the legacy hub's copier; in fleet mode a file is read on the node (`readFile`) and copied into `fileStore`,
// the hub's own store (files.ts), as the fleet adapters do.
export type LocalPorts = {
  tmux: Tmux; terminal?: Terminal; sessions?: Sessions; transcripts?: TranscriptSource; files?: RemoteFiles; uploads?: UploadSink;
  readFile?: NonNullable<NodeBackend["readFile"]>; inboxDir?: string; fileStore?: LocalFileStore;
};
// `id` and `close` are functions, not methods: a suite passes them on unbound (`id: p.id`).
export type ModePorts = HubPorts & { mode: HubMode; id: (pane: string) => string; rig: FleetRig | null; close: () => Promise<void> };

export const TEST_NODE = "test";
export const TEST_SERVER = "0a1b2c3d";
const NO_TERMINAL: Terminal = { frame: async () => null, keys: async () => false };
const NO_FILES: RemoteFiles = { register: async () => ({ id: null, size: null }) };

// "%3" as the fleet names it on this node: "test.0a1b2c3d.3". Anything else is passed on as it is.
export function workerIdOf(node: string, server: string, pane: string): string {
  const n = /^%(\d{1,9})$/.exec(pane)?.[1];
  return n === undefined ? pane : formatWorkerId({ node, server, pane: Number(n) });
}

export async function portsFor(mode: HubMode, local: LocalPorts): Promise<ModePorts> {
  if (mode === "legacy") {
    return {
      mode, tmux: local.tmux, terminal: local.terminal ?? NO_TERMINAL, sessions: local.sessions ?? null, transcripts: local.transcripts ?? null,
      files: local.files ?? NO_FILES, uploads: local.uploads ?? localUploads(), sendStatus: null, nodeStates: null,
      id: pane => pane, rig: null, close: async () => {},
    };
  }
  const backend: NodeBackend = { tmux: local.tmux };
  if (local.terminal) backend.terminal = local.terminal;
  if (local.sessions) backend.sessions = local.sessions;
  if (local.transcripts) backend.transcripts = local.transcripts;
  if (local.readFile) backend.readFile = local.readFile;
  if (local.inboxDir !== undefined) backend.inboxDir = local.inboxDir;
  const rig = await fleetRig([localNode(TEST_NODE, TEST_SERVER, backend)], local.fileStore ? { files: local.fileStore } : {});
  const p = rig.ports;
  return {
    mode, tmux: p.tmux, terminal: p.terminal, sessions: p.sessions, transcripts: p.transcripts, files: p.files, uploads: p.uploads,
    sendStatus: p.sendStatus, nodeStates: p.nodeStates, id: pane => workerIdOf(TEST_NODE, TEST_SERVER, pane), rig, close: () => rig.close(),
  };
}

// Sessions and transcripts from an agent config directory, as the legacy hub reads them (local-node.ts), as ports.
export function claudeDirPorts(dir: string): { sessions: Sessions; transcripts: TranscriptSource } {
  const registry = sessionRegistry(dir);
  return { sessions: localSessions(registry), transcripts: localTranscripts(registry) };
}

export function observationFor(p: HubPorts, o: { quietAfterMs: number; now?: () => number }): ObservationService {
  return new ObservationService(p.tmux, o.quietAfterMs, o.now ?? Date.now,
    { sessions: p.sessions, transcripts: p.transcripts, files: p.files, nodeStates: p.nodeStates });
}

export function steeringFor(p: HubPorts, o: {
  store: Store; now?: () => number; policy?: () => AccessPolicy; inbox?: Pick<Inbox, "get"> | null;
  waitingOn?: (workerId: string) => string; nameOf?: (workerId: string) => string | null;
}): SteeringService {
  return new SteeringService(o.store, p.tmux, o.now ?? Date.now, o.policy ?? (() => DEFAULT_POLICY), o.inbox ?? null,
    o.waitingOn ?? (() => "none"), o.nameOf ?? (() => null), p.uploads, p.sendStatus);
}

// An answer in doubt is settled as main.ts settles it: by a SteeringService on the same store and ports (op.status).
export function escalationsFor(p: HubPorts, o: { store: Store; watch: Watch; now?: () => number; managerName?: string; ledger?: (() => LedgerRead) | null }): EscalationService {
  const steering = steeringFor(p, { store: o.store, ...(o.now ? { now: o.now } : {}) });
  return new EscalationService({
    watch: o.watch, ledger: o.ledger ?? null, store: o.store, managerName: o.managerName ?? "manager",
    send: (pane, text, key) => p.tmux.send(pane, text, key), ...(o.now ? { now: o.now } : {}),
    settle: (key, workerId) => steering.settleInDoubt(key, workerId),
  });
}
