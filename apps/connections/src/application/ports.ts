// Ports for the connections application (ADR-0018). No secret bytes cross a port: a vault answers
// whether a ref exists and what its fingerprint is, and nothing else.
import type { Directory, Holder, Isolation, Policy, SecretDirectory } from "@morndo/domain";
import type { VendorPreset } from "@morndo/protocol";

export type Clock = { now(): number };

export type SecretVault = {
  has(ref: string): boolean;
  fingerprint(ref: string): Promise<string | null>;
  remove(ref: string): void;
};

export type RunPlan = {
  lease: string;
  connection: string;
  ref: string | null;
  configDir: string | null;
  model: string;
  effort: string;
  smallModel?: string;
  workspace: string;
  deny: readonly string[];
  reservation: number;
  probe: boolean;
  subscription?: boolean;
};

export type RunHandle = { readonly id: string };

export type Runtime = {
  isolation(): Isolation;
  dialects(): readonly string[];
  loginStatus(configDir: string | null): Promise<"ok" | "missing" | "unknown">;
  launch(plan: RunPlan): Promise<RunHandle>;
};

export type ModelRow = { id: string; efforts: readonly string[] | null };
export type ModelLister = { models(connection: { name: string; vendor: string }): readonly ModelRow[] };

export type SpendMeter = {
  fromRun(result: { cost: number | null }): number | null;
  reported(connection: string): number | null;
};

export type Catalog = { presets(): readonly VendorPreset[] };

export type ConnectionStore = {
  load(): { directory: Directory; policy: Policy; version: number };
  // false when `version` is no longer current, so a stale read cannot land.
  save(directory: Directory, policy: Policy, version: number): boolean;
};

export type RepoInspector = { inspect(path: string): { path: string; remotes: readonly string[] } };

export type Alert = { kind: string; name: string; detail: string };
export type AlertSink = { raise(alert: Alert): void; recent(): readonly Alert[] };

export type ProcId = { pid: number; startedAt: number; bootId: string };
export type Processes = {
  identity(pid: number): ProcId | null;
  ancestors(pid: number): readonly ProcId[];
  alive(id: ProcId): boolean;
};

export type ProviderEntry = { name: string; enabled: boolean };
export type ProviderRegistration = {
  name: string;
  kind: string;
  adapter: string;
  family: string;
  bin: readonly string[];
  probe: readonly string[];
  models: readonly string[];
  enabled: boolean;
  login: "ok" | "missing";
};
export type CommandShape = string | readonly string[] | null;

export function copyCommand(value: CommandShape): CommandShape {
  if (value === null) return null;
  return typeof value === "string" ? value : [...value];
}
export type EngineChain = { role: string; chain: readonly string[]; risk: readonly string[] | null };
export type EngineSettings = {
  chains(): readonly EngineChain[];
  setChain(role: string, entries: readonly string[], risk: readonly string[] | null): void;
  putProvider(entry: ProviderEntry): void;
  removeProvider(name: string): void;
  mark(name: string, reason: string, until: number): void;
  unmark(name: string): void;
  marks(): readonly { name: string; reason: string; until: number }[];
  providerNames(): readonly string[];
  provider(name: string): { bin: CommandShape; probe: CommandShape } | null;
  setProviderCommand(name: string, bin: CommandShape, probe: CommandShape): void;
  register(entries: readonly ProviderRegistration[]): void;
};

export type Deps = {
  clock: Clock;
  vault: SecretVault;
  runtime: Runtime;
  models: ModelLister;
  spend: SpendMeter;
  catalog: Catalog;
  store: ConnectionStore;
  repos: RepoInspector;
  alerts: AlertSink;
  processes: Processes;
  engines: EngineSettings;
};

export type Failure = { problem: string; role?: string; exit?: number };

export type LeaseRequest = {
  role: string;
  entry: string;
  holder: Holder;
  workspacePath: string;
  limit: number;
  reserve: number;
  margin: number;
  probe: boolean;
};

// ---- Secrets on the node (ADR-0022; design §6, §14). No port returns a value: a vault answers with keyed fingerprints,
// the index with keyed hashes, the store with metadata.

// Fresh ids: vault refs (`s-<random>`) and the Command id of a typed confirmation at the machine.
export type Ids = { next(prefix: string): string };

// Why a sealed value was refused before anything was written: not an age file, a header with other than one recipient
// stanza, a file this node's identity doesn't open, or a vault that would keep it as plaintext (decided on T-85).
export type SealedProblem = "not_age" | "stanzas" | "foreign" | "plaintext_vault";
export type SealedStore = {
  // Checks the age file and writes it as received under `ref`, by temp file and rename. Returns the value's keyed
  // fingerprint (HMAC-SHA-256 under the node's fingerprint key, 12 hex), never the value.
  storeSealed(ref: string, sealed: Uint8Array): Promise<{ ok: true; fingerprint: string } | { ok: false; problem: SealedProblem }>;
  // Opens nothing.
  has(ref: string): boolean;
  keyedFingerprint(ref: string): Promise<string | null>;
  remove(ref: string): void;
};

// A value's index entries, computed once from its vault file (keyed hashes only); `short` when it is under 8 bytes and
// so not indexed. What else it holds is the adapter's.
export type PreparedIndex = { readonly short: boolean };
export type IndexChange = {
  add: { reference: string; version: number; prepared: PreparedIndex } | null;
  retire: readonly { reference: string; version: number }[];
  at: number;
};
export type IndexWriter = {
  prepare(ref: string): Promise<PreparedIndex>;
  // One atomic write of the index file: the new version added, the retired ones marked, what 30 days no longer cover pruned.
  write(change: IndexChange): void;
};

// Where each version's sealed file lives (null once removed), and the registered workspaces (design §6).
export type VaultRefRow = { reference: string; version: number; ref: string | null };
export type WorkspaceRow = { name: string; root: string; at: number; command: string };
export type SecretsState = { directory: SecretDirectory; vaults: readonly VaultRefRow[]; workspaces: readonly WorkspaceRow[] };
export type SecretsDirectory = {
  load(): SecretsState;
  // One BEGIN IMMEDIATE transaction: `change` reads the state as committed now; a `next` it returns is saved before the
  // commit, and a throw rolls everything back. So the ledger check and the insert are one write (SC2).
  write<T>(change: (state: SecretsState) => { next: SecretsState | null; result: T }): T;
};

// The repository a path belongs to: its git common directory, absolute, or null outside a repository (design §6).
export type WorkspaceRoots = { commonDir(path: string): string | null };
