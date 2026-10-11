// Ports for the connections application (ADR-0018). No secret bytes cross a port: a vault answers
// whether a ref exists and what its fingerprint is, and nothing else.
import type { Directory, Holder, Isolation, Policy } from "@morndo/domain";
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
