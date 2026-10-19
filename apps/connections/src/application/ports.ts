// Ports for the connections application (ADR-0018). No secret bytes cross a port: a vault answers
// whether a ref exists and what its fingerprint is, and nothing else.
import type { Directory, Holder, Isolation, Policy, Pool, SecretDirectory } from "@morndo/domain";
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
export type SealedProblem = "not_age" | "stanzas" | "foreign" | "plaintext_vault" | "too_large";
// A ref's files not all removed, naming exactly which went and which are left, by file name; `missing` when the ref had
// no value file at all, plaintext or sealed (round 3, point 5).
export class RefNotRemoved extends Error {
  readonly ref: string;
  readonly removed: readonly string[];
  readonly left: readonly string[];
  readonly missing: boolean;
  constructor(ref: string, removed: readonly string[], left: readonly string[], missing: boolean, cause?: unknown) {
    const what = missing ? `no file of ${ref}, plaintext or sealed` : `${ref} not fully removed`;
    const why = cause === undefined ? "" : ` (${cause instanceof Error ? cause.message : "failed"})`;
    super(`${what}: removed ${removed.length > 0 ? removed.join(", ") : "nothing"}${left.length > 0 ? `; left ${left.join(", ")}` : ""}${why}`, { cause });
    this.name = "RefNotRemoved";
    this.ref = ref;
    this.removed = removed;
    this.left = left;
    this.missing = missing;
  }
}
export type SealedStore = {
  // Checks the age file and writes it as received under `ref`, by temp file and rename. Returns the value's keyed
  // fingerprint (HMAC-SHA-256 under the node's fingerprint key, 12 hex), never the value.
  storeSealed(ref: string, sealed: Uint8Array): Promise<{ ok: true; fingerprint: string } | { ok: false; problem: SealedProblem }>;
  // Opens nothing.
  has(ref: string): boolean;
  keyedFingerprint(ref: string): Promise<string | null>;
  // Removes every file of the ref, whichever vault wrote it, as both share the directory (round 3, point 6). Throws
  // RefNotRemoved when one can't be removed, and when the ref had no value file at all (a stray mark is removed all the
  // same), so a destroy never passes over a value silently; the caller decides whether a ref already gone is fine
  // (round 2, points 2 and 5; round 3, point 5).
  remove(ref: string): void;
  // The refs it holds that start with `prefix` and whose file was last written before `writtenBefore` (ms since the
  // epoch), for the startup sweep (D2).
  refs(prefix: string, writtenBefore: number): readonly string[];
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
  // The versions the index holds live, not yet retired: the only ones a sweep has to retire (round 3, point 7).
  live(): readonly { reference: string; version: number }[];
};

// Where each version's sealed file lives (null once removed), and the registered workspaces (design §6).
export type VaultRefRow = { reference: string; version: number; ref: string | null };
export type WorkspaceRow = { name: string; root: string; at: number; command: string };
export type SecretsState = { directory: SecretDirectory; vaults: readonly VaultRefRow[]; workspaces: readonly WorkspaceRow[] };
export type SecretsDirectory = {
  load(): SecretsState;
  // One BEGIN IMMEDIATE transaction: `change` reads the state as committed now; a `next` it returns is saved before the
  // commit, and a throw rolls everything back. So the ledger check and the insert are one write (SC2). The vault rows of
  // `next` set the refs they name, null clearing one; a version they leave out keeps its stored ref, and a new one has
  // none; a row that names no ledger entry, or one twice, is refused (review 9; round 2, point 6).
  write<T>(change: (state: SecretsState) => { next: SecretsState | null; result: T }): T;
};

// The repository a path belongs to: its git common directory, absolute, or null outside a repository (design §6).
export type WorkspaceRoots = { commonDir(path: string): string | null };

// ---- The account pool (ADR-0029). One row per runtime, saved only on the version it was read at.
export type PoolStore = {
  load(runtime: string): { pool: Pool; version: number };
  // false when `version` is no longer current, so a stale read cannot land.
  save(pool: Pool, version: number): boolean;
};
// A notice at most once per `everyMs` for one key; where it goes (a hub, the terminal) is the adapter's.
export type PoolNotices = { send(key: string, text: string, everyMs: number): void };
