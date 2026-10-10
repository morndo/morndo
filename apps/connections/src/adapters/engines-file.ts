// A file stand-in for engine marks until the engines CLI owns this (design PR 5).
// Writes go to a temp file, fsync, then rename, so a reader never sees a half-written file.
// A lock around the read-modify-write keeps two processes from wiping each other's marks.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { chainHolders } from "../application/providers.ts";
import { copyCommand, type CommandShape, type EngineChain, type EngineSettings, type ProviderEntry, type ProviderRegistration } from "../application/ports.ts";
import { writePrivate } from "./file-mode.ts";

type StoredProvider = ProviderEntry & {
  kind?: string;
  adapter?: string;
  family?: string;
  bin?: CommandShape;
  probe?: CommandShape;
  models?: string[];
  login?: string;
  efforts?: string[];
  label?: string;
};

type Saved = {
  providers: StoredProvider[];
  marks: { name: string; reason: string; until: number }[];
  chains: { role: string; chain: string[]; risk: string[] | null }[];
};

const empty = (): Saved => ({ providers: [], marks: [], chains: [] });

export function resetEngines(path: string): void {
  if (!existsSync(path)) return;
  const backup = `${path}.bak`;
  if (existsSync(backup)) unlinkSync(backup);
  renameSync(path, backup);
}

export function lockOwner(): { pid: number; started: string } {
  return { pid: process.pid, started: processStarted(process.pid) ?? "" };
}

export class FileEngines implements EngineSettings {
  readonly #path: string;
  readonly #lockWaitMs: number;
  constructor(path: string, options: { lockWaitMs?: number } = {}) {
    this.#path = path;
    this.#lockWaitMs = options.lockWaitMs ?? 5000;
  }

  chains(): readonly EngineChain[] { return this.#read().chains; }

  setChain(role: string, entries: readonly string[], risk: readonly string[] | null): void {
    this.#update(saved => {
      const chain = { role, chain: [...entries], risk: risk === null ? null : [...risk] };
      saved.chains = [...saved.chains.filter(row => row.role !== role), chain];
    });
  }

  putProvider(entry: ProviderEntry): void {
    this.#update(saved => {
      const prior = saved.providers.find(row => row.name === entry.name);
      saved.providers = [...saved.providers.filter(row => row.name !== entry.name), { ...prior, name: entry.name, enabled: entry.enabled }];
    });
  }

  removeProvider(name: string): void {
    this.#update(saved => {
      const roles = chainHolders(saved.chains, name);
      if (roles.length > 0) throw new Error(`${name} is still in ${roles.join(", ")}'s chain`);
      saved.providers = saved.providers.filter(row => row.name !== name);
    });
  }

  mark(name: string, reason: string, until: number): void {
    this.#update(saved => {
      saved.marks = [...saved.marks.filter(row => row.name !== name), { name, reason, until }];
    });
  }

  unmark(name: string): void {
    this.#update(saved => { saved.marks = saved.marks.filter(row => row.name !== name); });
  }

  marks(): readonly { name: string; reason: string; until: number }[] { return this.#read().marks; }

  providerNames(): readonly string[] { return this.#read().providers.map(row => row.name); }

  provider(name: string): { bin: CommandShape; probe: CommandShape } | null {
    const row = this.#read().providers.find(item => item.name === name);
    if (!row) return null;
    return { bin: row.bin ?? [], probe: row.probe ?? [] };
  }

  setProviderCommand(name: string, bin: CommandShape, probe: CommandShape): void {
    this.#update(saved => {
      const prior = saved.providers.find(row => row.name === name);
      if (!prior) throw new Error(`unknown provider '${name}'`);
      saved.providers = saved.providers.map(row => {
        if (row.name !== name) return row;
        const next = { ...row };
        const nextBin = copyCommand(bin);
        const nextProbe = copyCommand(probe);
        if (nextBin === null) delete next.bin;
        else next.bin = nextBin;
        if (nextProbe === null) delete next.probe;
        else next.probe = nextProbe;
        return next;
      });
    });
  }

  register(entries: readonly ProviderRegistration[]): void {
    if (entries.length === 0) return;
    this.#update(saved => {
      for (const entry of entries) {
        const prior = saved.providers.find(row => row.name === entry.name);
        const next: StoredProvider = {
          ...prior,
          name: entry.name,
          enabled: entry.enabled,
          kind: entry.kind,
          adapter: entry.adapter,
          family: entry.family,
          bin: [...entry.bin],
          probe: [...entry.probe],
          models: [...entry.models],
          login: entry.login,
        };
        if (prior?.efforts !== undefined) next.efforts = prior.efforts;
        if (prior?.label) next.label = prior.label;
        saved.providers = [...saved.providers.filter(row => row.name !== entry.name), next];
      }
    });
  }

  #update(change: (saved: Saved) => void): void {
    withLock(`${this.#path}.lock`, this.#lockWaitMs, () => {
      const saved = this.#read();
      change(saved);
      writePrivate(this.#path, new TextEncoder().encode(JSON.stringify(saved)), process.getuid?.() ?? -1);
    });
  }

  #read(): Saved {
    let text: string;
    try { text = readFileSync(this.#path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { throw damaged(this.#path, "not valid JSON"); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw damaged(this.#path, "not an engines file");
    const body = parsed as Partial<Record<keyof Saved, unknown>>;
    return {
      providers: entries(this.#path, "providers", body.providers, isProvider),
      marks: entries(this.#path, "marks", body.marks, isMark),
      chains: entries(this.#path, "chains", body.chains, isChain),
    };
  }
}

function damaged(path: string, detail: string): Error {
  return new Error(`${path} is damaged (${detail}). Move it aside as a backup, then run \`morndo-keys engines reset\` to start empty.`);
}

function entries<T>(path: string, label: string, value: unknown, row: (item: unknown) => item is T): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw damaged(path, `${label} must be a list`);
  if (!value.every(row)) throw damaged(path, `${label} has a bad entry`);
  return value;
}

function isProvider(item: unknown): item is StoredProvider {
  if (item === null || typeof item !== "object") return false;
  const row = item as StoredProvider;
  return typeof row.name === "string" && typeof row.enabled === "boolean";
}

function isMark(item: unknown): item is Saved["marks"][number] {
  if (item === null || typeof item !== "object") return false;
  const row = item as Saved["marks"][number];
  return typeof row.name === "string" && typeof row.reason === "string" && typeof row.until === "number";
}

function isChain(item: unknown): item is Saved["chains"][number] {
  if (item === null || typeof item !== "object") return false;
  const row = item as Saved["chains"][number];
  const names = (value: unknown): value is string[] => Array.isArray(value) && value.every(entry => typeof entry === "string");
  return typeof row.role === "string" && names(row.chain) && (row.risk === null || names(row.risk));
}

function processStarted(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return rest[19] ?? null;
  } catch {
    return null;
  }
}

function lockHeld(lock: string): boolean {
  let text = "";
  let fresh = false;
  try {
    text = readFileSync(lock, "utf8");
    fresh = Date.now() - statSync(lock).mtimeMs < 1000;
  } catch {
    return false;
  }
  try {
    const body = JSON.parse(text) as { pid?: number; started?: string };
    if (typeof body.pid !== "number" || typeof body.started !== "string") return fresh;
    const started = processStarted(body.pid);
    if (started === null) return false;
    return started === body.started;
  } catch {
    return fresh;
  }
}

function withLock<T>(lock: string, waitMs: number, body: () => T): T {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(lockOwner()));
        fsyncSync(fd);
        return body();
      } finally {
        closeSync(fd);
        try { unlinkSync(lock); } catch { /* the next writer already replaced it */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!lockHeld(lock)) {
        console.warn(`breaking stale engines lock ${lock}`);
        try { unlinkSync(lock); } catch { /* another writer took it */ }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`${lock} is held; retry`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}
