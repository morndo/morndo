// In-memory ports. Tests move the clock and the runtime by hand. No ambient I/O.
import { emptyDirectory, emptyPolicy, emptySecretDirectory, type Directory, type Isolation, type Policy } from "@morndo/domain";
import type { VendorPreset } from "@morndo/protocol";
import { chainHolders } from "./providers.ts";
import { copyCommand, type Alert, type AlertSink, type Catalog, type Clock, type CommandShape, type ConnectionStore, type Deps, type EngineChain, type EngineSettings, type ModelLister, type ModelRow, type ProcId, type Processes, type ProviderEntry, type ProviderRegistration, type RepoInspector, type RunHandle, type RunPlan, type Runtime, type SecretVault, type SpendMeter } from "./ports.ts";
import type { IndexChange, IndexWriter, Ids, PreparedIndex, SecretsDirectory, SecretsState, WorkspaceRoots } from "./ports.ts";

export class ManualClock implements Clock {
  at: number;
  constructor(at: number) { this.at = at; }
  now(): number { return this.at; }
}

export class MemoryVault implements SecretVault {
  readonly refs = new Map<string, string>();
  put(ref: string, fingerprint: string): void { this.refs.set(ref, fingerprint); }
  has(ref: string): boolean { return this.refs.has(ref); }
  async fingerprint(ref: string): Promise<string | null> { return this.refs.get(ref) ?? null; }
  remove(ref: string): void { this.refs.delete(ref); }
}

export class MemoryRuntime implements Runtime {
  level: Isolation = "rules";
  spoken: readonly string[] = ["dialect-a"];
  login: "ok" | "missing" | "unknown" = "ok";
  reads = 0;
  readonly launches: RunPlan[] = [];
  isolation(): Isolation { this.reads += 1; return this.level; }
  dialects(): readonly string[] { this.reads += 1; return this.spoken; }
  loginStatus(): Promise<"ok" | "missing" | "unknown"> { return Promise.resolve(this.login); }
  async launch(plan: RunPlan): Promise<RunHandle> { this.launches.push(plan); return { id: plan.lease }; }
}

export class MemoryModels implements ModelLister {
  rows: readonly ModelRow[] = [{ id: "m", efforts: ["high"] }];
  readonly asked: string[] = [];
  models(connection: { name: string }): readonly ModelRow[] {
    this.asked.push(connection.name);
    return this.rows;
  }
}

export class MemorySpend implements SpendMeter {
  cost: number | null = null;
  figure: number | null = null;
  fromRun(): number | null { return this.cost; }
  reported(): number | null { return this.figure; }
}

export class MemoryCatalog implements Catalog {
  rows: readonly VendorPreset[] = [];
  presets(): readonly VendorPreset[] { return this.rows; }
}

export class MemoryStore implements ConnectionStore {
  directory: Directory = emptyDirectory();
  policy: Policy = emptyPolicy();
  version = 0;
  saves = 0;
  load(): { directory: Directory; policy: Policy; version: number } {
    return { directory: this.directory, policy: this.policy, version: this.version };
  }
  save(directory: Directory, policy: Policy, version: number): boolean {
    if (version !== this.version) return false;
    this.directory = directory;
    this.policy = policy;
    this.version += 1;
    this.saves += 1;
    return true;
  }
}

export class MemoryRepos implements RepoInspector {
  real = "/work/repo";
  remotes: readonly string[] = [];
  reads = 0;
  inspect(): { path: string; remotes: readonly string[] } { this.reads += 1; return { path: this.real, remotes: this.remotes }; }
}

export class MemoryAlerts implements AlertSink {
  readonly raised: Alert[] = [];
  raise(alert: Alert): void { this.raised.push(alert); }
  recent(): readonly Alert[] { return this.raised; }
}

export class MemoryProcesses implements Processes {
  readonly dead = new Set<number>();
  checks = 0;
  identity(pid: number): ProcId { return { pid, startedAt: 1, bootId: "boot" }; }
  ancestors(): readonly ProcId[] { return []; }
  alive(id: ProcId): boolean { this.checks += 1; return !this.dead.has(id.pid); }
}

export class MemoryEngines implements EngineSettings {
  readonly writes: { role: string; entries: readonly string[] }[] = [];
  failOn: number | null = null;
  readonly providers: ProviderEntry[] = [];
  readonly commands = new Map<string, { bin: CommandShape; probe: CommandShape }>();
  readonly markLog: { name: string; reason: string; until: number }[] = [];
  readonly unmarked: string[] = [];
  private current = new Map<string, { chain: readonly string[]; risk: readonly string[] | null }>();
  chains(): readonly EngineChain[] {
    return [...this.current].map(([role, row]) => ({ role, chain: row.chain, risk: row.risk }));
  }
  setChain(role: string, entries: readonly string[], risk: readonly string[] | null): void {
    if (this.failOn !== null && this.writes.length + 1 === this.failOn) throw new Error("blocked");
    this.writes.push({ role, entries });
    this.current.set(role, { chain: [...entries], risk });
  }
  tamper(role: string, chain: readonly string[]): void {
    const row = this.current.get(role);
    this.current.set(role, { chain: [...chain], risk: row?.risk ?? null });
  }
  forget(role: string): void { this.current.delete(role); }
  tamperRisk(role: string, risk: readonly string[] | null): void {
    const row = this.current.get(role);
    if (!row) return;
    this.current.set(role, { chain: row.chain, risk });
  }
  putProvider(entry: ProviderEntry): void {
    const rest = this.providers.filter(p => p.name !== entry.name);
    this.providers.splice(0, this.providers.length, ...rest, entry);
  }
  removeProvider(name: string): void {
    const roles = chainHolders(this.chains(), name);
    if (roles.length > 0) throw new Error(`${name} is still in ${roles.join(", ")}'s chain`);
    const rest = this.providers.filter(p => p.name !== name);
    this.providers.splice(0, this.providers.length, ...rest);
  }
  mark(name: string, reason: string, until: number): void { this.markLog.push({ name, reason, until }); }
  marks(): readonly { name: string; reason: string; until: number }[] { return this.markLog; }
  unmark(name: string): void {
    this.unmarked.push(name);
    const rest = this.markLog.filter(m => m.name !== name);
    this.markLog.splice(0, this.markLog.length, ...rest);
  }
  providerNames(): readonly string[] { return this.providers.map(row => row.name); }
  provider(name: string): { bin: CommandShape; probe: CommandShape } | null {
    if (!this.providers.some(row => row.name === name)) return null;
    return this.commands.get(name) ?? { bin: [], probe: [] };
  }
  setProviderCommand(name: string, bin: CommandShape, probe: CommandShape): void {
    if (!this.providers.some(row => row.name === name)) throw new Error(`unknown provider '${name}'`);
    this.commands.set(name, { bin: copyCommand(bin), probe: copyCommand(probe) });
  }
  register(entries: readonly ProviderRegistration[]): void {
    for (const entry of entries) {
      this.putProvider({ name: entry.name, enabled: entry.enabled });
      this.commands.set(entry.name, { bin: [...entry.bin], probe: [...entry.probe] });
    }
  }
}

export type Memory = {
  clock: ManualClock;
  vault: MemoryVault;
  runtime: MemoryRuntime;
  models: MemoryModels;
  spend: MemorySpend;
  catalog: MemoryCatalog;
  store: MemoryStore;
  repos: MemoryRepos;
  alerts: MemoryAlerts;
  processes: MemoryProcesses;
  engines: MemoryEngines;
  deps: Deps;
};

export function memory(at = 1_700_000_000_000): Memory {
  const clock = new ManualClock(at);
  const vault = new MemoryVault();
  const runtime = new MemoryRuntime();
  const models = new MemoryModels();
  const spend = new MemorySpend();
  const catalog = new MemoryCatalog();
  const store = new MemoryStore();
  const repos = new MemoryRepos();
  const alerts = new MemoryAlerts();
  const processes = new MemoryProcesses();
  const engines = new MemoryEngines();
  const deps: Deps = { clock, vault, runtime, models, spend, catalog, store, repos, alerts, processes, engines };
  return { clock, vault, runtime, models, spend, catalog, store, repos, alerts, processes, engines, deps };
}

// ---- Secrets on the node

export class CountingIds implements Ids {
  n = 0;
  next(prefix: string): string { this.n += 1; return `${prefix}${String(this.n).padStart(4, "0")}`; }
}

const copyState = (s: SecretsState): SecretsState => JSON.parse(JSON.stringify(s)) as SecretsState;

// One state; a write runs on a copy and lands only if the change returns without throwing, as the store's transaction.
export class MemorySecrets implements SecretsDirectory {
  state: SecretsState = { directory: emptySecretDirectory(), vaults: [], workspaces: [] };
  writes = 0;
  load(): SecretsState { return copyState(this.state); }
  write<T>(change: (state: SecretsState) => { next: SecretsState | null; result: T }): T {
    const { next, result } = change(copyState(this.state));
    if (next) { this.state = copyState(next); this.writes += 1; }
    return result;
  }
}

// Records each write; `short` says which vault refs hold a value under 8 bytes.
export class MemoryIndex implements IndexWriter {
  readonly changes: IndexChange[] = [];
  readonly prepared: string[] = [];
  readonly #short: (ref: string) => Promise<boolean>;
  constructor(short: (ref: string) => Promise<boolean> = () => Promise.resolve(false)) { this.#short = short; }
  async prepare(ref: string): Promise<PreparedIndex> {
    this.prepared.push(ref);
    return { short: await this.#short(ref) };
  }
  write(change: IndexChange): void { this.changes.push(change); }
}

// A path's repository: the longest registered prefix's common dir.
export class MemoryRoots implements WorkspaceRoots {
  readonly repos = new Map<string, string>();
  commonDir(path: string): string | null {
    let best: string | null = null;
    for (const root of this.repos.keys()) if ((path === root || path.startsWith(`${root}/`)) && (best === null || root.length > best.length)) best = root;
    return best === null ? null : this.repos.get(best) ?? null;
  }
}
