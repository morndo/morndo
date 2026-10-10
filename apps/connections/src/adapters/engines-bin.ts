// EngineSettings over the engines CLI. Spawning and exit classification live in @morndo/node-ops.
// This process never opens the settings file (ADR-0013). The CLI reads ENGINES_CONFIG, or its own
// default path when that is unset. A command change asks the CLI for the stored provider and sends
// that object back with only bin and probe replaced, because provider set replaces the whole entry.
import { chainArg } from "@morndo/domain";
import { EnginesError, enginesText, runEnginesSync } from "@morndo/node-ops";
import { chainHolders } from "../application/providers.ts";
import { copyCommand, type CommandShape, type EngineChain, type EngineSettings, type ProviderEntry, type ProviderRegistration } from "../application/ports.ts";

export class CliEngines implements EngineSettings {
  readonly #bin: string;
  readonly #env: NodeJS.ProcessEnv;
  #clearRisk: boolean | null = null;
  constructor(bin: string, env: NodeJS.ProcessEnv) {
    this.#bin = bin;
    this.#env = env;
  }

  chains(): readonly EngineChain[] {
    const body = JSON.parse(this.#call(["get", "--json"])) as Record<string, { chain?: unknown; risk_chain?: unknown }>;
    return Object.entries(body).map(([role, row]) => ({
      role,
      chain: strings(row.chain),
      risk: row.risk_chain === undefined ? null : strings(row.risk_chain),
    }));
  }

  setChain(role: string, entries: readonly string[], risk: readonly string[] | null): void {
    this.#call(["set", role, chainArg(entries)]);
    if (risk && risk.length > 0) {
      this.#call(["set", role, chainArg(risk), "--risk"]);
      return;
    }
    if (this.#clearRisk === false) return;
    const prior = this.chains().find(row => row.role === role);
    if (!prior?.risk?.length) return;
    try {
      this.#call(["set", role, "--clear-risk"]);
      this.#clearRisk = true;
    } catch (error) {
      if (!usage(error)) throw error;
      this.#clearRisk = false;
    }
  }

  putProvider(entry: ProviderEntry): void {
    try { this.#call(["provider", "enable", entry.name, entry.enabled ? "on" : "off"]); }
    catch (error) {
      if (missing(error)) return;
      throw error;
    }
  }

  removeProvider(name: string): void {
    const roles = chainHolders(this.chains(), name);
    if (roles.length > 0) throw new Error(`${name} is still in ${roles.join(", ")}'s chain`);
    try { this.#call(["provider", "remove", name]); }
    catch (error) {
      if (missing(error)) return;
      throw error;
    }
  }

  mark(name: string, reason: string, until: number): void {
    this.#call(["mark", name, reason, "--until", String(Math.floor(until / 1000))]);
  }

  unmark(name: string): void {
    this.#call(["unmark", name]);
  }

  marks(): readonly { name: string; reason: string; until: number }[] {
    const body = JSON.parse(this.#call(["providers", "--json"])) as { held?: unknown }[];
    const now = Date.now();
    const rows: { name: string; reason: string; until: number }[] = [];
    for (const provider of body) {
      if (!Array.isArray(provider.held)) continue;
      for (const item of provider.held) {
        if (item === null || typeof item !== "object") continue;
        const row = item as { name?: unknown; reason?: unknown; until?: unknown };
        if (typeof row.name !== "string" || typeof row.reason !== "string" || typeof row.until !== "number") continue;
        const until = row.until * 1000;
        if (until <= now) continue;
        rows.push({ name: row.name, reason: row.reason, until });
      }
    }
    return rows;
  }

  providerNames(): readonly string[] {
    const body = JSON.parse(this.#call(["providers", "--json"])) as { provider?: unknown }[];
    return body.flatMap(row => typeof row.provider === "string" ? [row.provider] : []);
  }

  provider(name: string): { bin: CommandShape; probe: CommandShape } | null {
    const stored = this.#stored(name);
    if (!stored) return null;
    return { bin: commandShape(stored.bin), probe: commandShape(stored.probe) };
  }

  setProviderCommand(name: string, bin: CommandShape, probe: CommandShape): void {
    const current = this.#stored(name);
    if (!current) throw new Error(`unknown provider '${name}'`);
    const next: Record<string, unknown> = { ...current };
    writeCommand(next, "bin", bin);
    writeCommand(next, "probe", probe);
    this.#call(["provider", "set", name, "--json", JSON.stringify(next)]);
  }

  #stored(name: string): Record<string, unknown> | null {
    try {
      const body = JSON.parse(this.#call(["provider", "show", name, "--json"])) as unknown;
      if (body !== null && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
    } catch (error) {
      if (!unsupported(error)) throw error;
    }
    const body = JSON.parse(this.#call(["providers", "--json"])) as Record<string, unknown>[];
    const row = body.find(item => item.provider === name);
    if (!row) return null;
    const next: Record<string, unknown> = { ...row };
    delete next.provider;
    delete next.held;
    delete next.installed;
    return next;
  }

  register(entries: readonly ProviderRegistration[]): void {
    if (entries.length === 0) return;
    const rows = JSON.parse(this.#call(["providers", "--json"])) as Record<string, unknown>[];
    const items = entries.map(entry => ({ name: entry.name, ...owned(entry, rows.find(row => row.provider === entry.name)) }));
    try {
      this.#call(["provider", "set", "--batch", JSON.stringify(items)]);
    } catch (error) {
      if (!usage(error)) throw error;
      for (const item of items) {
        const { name, ...body } = item;
        this.#call(["provider", "set", name, "--json", JSON.stringify(body)]);
      }
    }
  }

  #call(args: readonly string[]): string {
    return enginesText(runEnginesSync(this.#bin, args, this.#env));
  }
}

function owned(entry: ProviderRegistration, current: Record<string, unknown> | undefined): Record<string, unknown> {
  const next: Record<string, unknown> = {
    kind: entry.kind, adapter: entry.adapter, family: entry.family,
    bin: [...entry.bin], probe: [...entry.probe], models: [...entry.models], enabled: entry.enabled,
    login: entry.login,
  };
  if (current && Array.isArray(current.efforts)) next.efforts = current.efforts;
  if (current && typeof current.label === "string" && current.label !== "") next.label = current.label;
  return next;
}

function usage(error: unknown): boolean {
  return unsupported(error)
    && /usage:|unrecognized arguments|invalid choice|arguments are required/i.test(message(error));
}

function unsupported(error: unknown): boolean {
  return error instanceof EnginesError && (error.kind === "unavailable" || error.kind === "refused")
    && /usage:|unrecognized arguments|invalid choice|arguments are required|unknown provider command/i.test(message(error));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function commandShape(value: unknown): CommandShape {
  if (typeof value === "string") return value;
  if (value == null) return null;
  return strings(value);
}

function writeCommand(target: Record<string, unknown>, key: string, value: CommandShape): void {
  const copied = copyCommand(value);
  if (copied === null) delete target[key];
  else target[key] = copied;
}

function missing(error: unknown): boolean {
  return error instanceof Error && error.message.includes("unknown provider");
}
