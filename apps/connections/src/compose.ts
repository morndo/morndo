// Wires the store, the vault and the services. The plaintext type stays in this file.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Encrypter } from "age-encryption";
import type { EngineSettings, Runtime } from "./application/ports.ts";
import { bindCommands, type BoundCommands } from "./application/commands.ts";
import { ConnectionsService } from "./application/connections-service.ts";
import { LeaseService } from "./application/lease-service.ts";
import { RoutingService } from "./application/routing-service.ts";
import { FileAlerts } from "./adapters/alerts-file.ts";
import { FileCatalog } from "./adapters/catalog-file.ts";
import { CliEngines } from "./adapters/engines-bin.ts";
import { FileEngines } from "./adapters/engines-file.ts";
import { FileModels } from "./adapters/models.ts";
import { ProcProcesses } from "./adapters/processes.ts";
import { GitRepos } from "./adapters/repos.ts";
import { RunSpend } from "./adapters/spend.ts";
import { SqliteStore } from "./adapters/store-sqlite.ts";
import { AgeVault } from "./adapters/vault-age.ts";
import { readUsage } from "./adapters/usage-file.ts";
import { FileVault } from "./adapters/vault-file.ts";
import { SecretMaterial } from "./adapters/secret-material.ts";
import { GitWorkspaceRoots } from "./adapters/git-workspaces.ts";
import { NodeKeys } from "./adapters/node-keys.ts";
import { SecretIndexWriter } from "./adapters/secret-index-writer.ts";
import { SqliteSecrets } from "./adapters/secrets-sqlite.ts";
import { SecretsService } from "./application/secrets-service.ts";

export class SwitchRuntime implements Runtime {
  current: Runtime;
  constructor(current: Runtime) { this.current = current; }
  isolation() { return this.current.isolation(); }
  dialects() { return this.current.dialects(); }
  loginStatus(configDir: string | null) { return this.current.loginStatus(configDir); }
  launch(plan: Parameters<Runtime["launch"]>[0]) { return this.current.launch(plan); }
}

const idle: Runtime = {
  isolation: () => "none",
  dialects: () => [],
  loginStatus: () => Promise.resolve("unknown" as const),
  launch: () => Promise.resolve({ id: "" }),
};

export type Opened = {
  dir: string;
  db: string;
  vaultDir: string;
  identity: string;
  store: SqliteStore;
  vault: FileVault | AgeVault;
  connections: ConnectionsService;
  routing: RoutingService;
  commands: BoundCommands;
  leases: LeaseService;
  catalog: FileCatalog;
  engines: EngineSettings;
  models: FileModels;
  processes: ProcProcesses;
  runtime: SwitchRuntime;
  env: NodeJS.ProcessEnv;
  now(): number;
  close(): void;
  seal(ref: string, text: string): Promise<void>;
  open(ref: string): Promise<string>;
};

export function catalogPath(env: NodeJS.ProcessEnv): string {
  return env.MORNDO_CATALOG ?? join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
}

export function openHome(env: NodeJS.ProcessEnv): Opened {
  const dir = env.MORNDO_CONNECTIONS_HOME ?? join(env.HOME ?? "", ".config/morndo-connections");
  const db = join(dir, "connections.db");
  const vaultDir = join(dir, "vault");
  const identity = join(dir, "identity");
  const catalog = new FileCatalog(catalogPath(env));
  const store = new SqliteStore(db);
  const vault = env.MORNDO_VAULT === "file" ? new FileVault(vaultDir) : new AgeVault(vaultDir, identity);
  const engines = env.MORNDO_ENGINES_BIN ? new CliEngines(env.MORNDO_ENGINES_BIN, env) : new FileEngines(join(dir, "engines.json"));
  const models = new FileModels(join(dir, "models"));
  const processes = new ProcProcesses();
  const runtime = new SwitchRuntime(idle);
  const clock = { now: () => Date.now() };
  const deps = {
    clock, vault, runtime, models, spend: new RunSpend(), catalog, store,
    repos: new GitRepos(), alerts: new FileAlerts(join(dir, "alerts.log")), processes, engines,
  };
  return {
    dir, db, vaultDir, identity, store, vault, catalog, engines, models, processes, runtime, env,
    connections: new ConnectionsService(deps),
    routing: new RoutingService(deps),
    commands: bindCommands(deps, () => readUsage(join(dir, "usage.json"))),
    leases: new LeaseService(deps),
    now: () => clock.now(),
    close: () => store.close(),
    seal: async (ref, text) => { await vault.seal(ref, new SecretMaterial(new TextEncoder().encode(text))); },
    open: async ref => new TextDecoder().decode((await vault.open(ref)).bytes()),
  };
}

// ---- The node's Secrets (ADR-0022; design §6, §14)

export type SecretsHome = {
  service: SecretsService;
  // The node's age recipient, or null on the plaintext vault, which takes no sealed value (D1).
  recipient(): Promise<string | null>;
  // A value sealed to this node's own recipient, as `put` stores it; null on the plaintext vault.
  sealForNode(value: Uint8Array): Promise<Uint8Array | null>;
  commandId(): string;
  close(): void;
};

// The index the node's output paths read (design §8.1; packages/node-ops secret-index-file.ts).
export const secretIndexPath = (dir: string) => join(dir, "secret-index.json");

export function openSecrets(env: NodeJS.ProcessEnv): SecretsHome {
  const dir = env.MORNDO_CONNECTIONS_HOME ?? join(env.HOME ?? "", ".config/morndo-connections");
  const secrets = new SqliteSecrets(join(dir, "connections.db"));
  // A node key may be made only while no fingerprint or index entry made with it is on record (review 6).
  const keys = new NodeKeys(dir, undefined, () => !existsSync(secretIndexPath(dir)) && secrets.load().directory.ledger.length === 0);
  const age = env.MORNDO_VAULT === "file" ? null : new AgeVault(join(dir, "vault"), join(dir, "identity"), undefined, keys);
  const vault = age ?? new FileVault(join(dir, "vault"), undefined, keys);
  const random = (prefix: string) => `${prefix}${randomBytes(8).toString("hex")}`;
  const service = new SecretsService({
    clock: { now: () => Date.now() }, ids: { next: random }, vault,
    index: new SecretIndexWriter(secretIndexPath(dir), bytes => keys.index(bytes), vault), secrets, roots: new GitWorkspaceRoots(),
  });
  return {
    service,
    recipient: async () => (age ? age.recipient() : null),
    sealForNode: async value => {
      if (!age) return null;
      const encrypter = new Encrypter();
      encrypter.addRecipient(await age.recipient());
      return encrypter.encrypt(value);
    },
    commandId: () => random("cmd-"),
    close: () => secrets.close(),
  };
}
