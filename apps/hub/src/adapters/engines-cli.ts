// Anti-corruption adapter over the engine layer's CLI (engine-layer `bin/engines`, named by MORNDO_ENGINES): the one
// way the hub reads and changes which provider and model does each role's work (ADR-0013). Its settings file
// (~/.config/engines/engines.json, or $ENGINES_CONFIG) is the only copy; the hub never reads or writes it itself, so
// the CLI's checks and its atomic write apply to every change, from here as from the terminal or the manager.
//
// Calls (engine-layer README "For Morndo (the settings page): the stable interface", 9f3a28c, read 2026-10-07; later
// changes only add fields):
//   get --json                the roles: chain, risk_chain, other_provider, other_provider_effective (+ review_other_provider on review)
//   providers --json          each provider: enabled, installed, login, marks ("<key> until <when>"), models, efforts
//                             (null: any effort), kind
//   resolve ROLE --json       what would run now; exit 0 with a pick, 3 with none
//   option enabled            the kill switch, as JSON
//   set ROLE A,B,C [--force]  a role's chain
//   other-provider ROLE on|off --effective   the rule as the resolver reads it, in one atomic write
// A refusal is exit 2 with "engines: <why>" on stderr. Argparse also exits 2, printing usage: that is an unavailable
// CLI, not a refusal. Run with execFile and an argument list, never a shell
// (Node docs, child_process.execFile, read 2026-10-07).
import { createHash } from "node:crypto";
import { availabilityOf, chainArg, parseEngine, type Engine, type EngineProvider, type RoleEngines } from "@morndo/domain";
import { EnginesError, enginesText, runEngines } from "@morndo/node-ops";
import type { EnginesNow, EnginesView } from "@morndo/protocol";

export { EnginesError };

// What a save is checked against: the settings as read (their version) and the providers, without the resolver.
export type EnginesSettings = { version: string; roles: RoleEngines[]; providers: EngineProvider[] };

export type EnginesCli = {
  // Null when the CLI has what the page needs (engine-layer 9f3a28c: other-provider --effective, efforts null), else
  // why not, in words. There is no version flag; argparse's help for other-provider lists --effective from then on.
  probe(): Promise<string | null>;
  read(reuse?: { providers: EngineProvider[] }): Promise<EnginesView>;
  settings(): Promise<EnginesSettings>;
  setChain(role: string, chain: readonly string[], force: boolean): Promise<void>;
  setOtherProvider(role: string, on: boolean): Promise<void>;
};

// A page view resolves every role. The CLI has no batch resolve, so a few run at once rather than one process per role
// all at the same moment (a loaded box was timing the whole look out).
export const RESOLVE_AT_ONCE = 4;

// Like Promise.all, but a failure is thrown only once every run has ended, so no CLI run outlives the answer (one that
// crashes at once would otherwise leave the others running after it). The first failure in the list's order is thrown.
async function allEnded<T extends readonly unknown[] | []>(runs: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const settled = await Promise.allSettled(runs as readonly unknown[]);
  for (const s of settled) if (s.status === "rejected") throw s.reason;
  return settled.map(s => (s as PromiseFulfilledResult<unknown>).value) as { -readonly [P in keyof T]: Awaited<T[P]> };
}

// After a failure no further item starts; the ones already running end before it is thrown.
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const run = async () => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i] as T, i); } catch (e) { failed = true; throw e; }
    }
  };
  const workers = Math.min(Math.max(limit, 1), items.length);
  await allEnded(Array.from({ length: workers }, () => run()));
  return out;
}

export function enginesCli(program: string, env: NodeJS.ProcessEnv = process.env): EnginesCli {
  // Exit 0 (or one of `ok`) and its output, else the CLI's own reason. Exit 2 is a refusal ("engines: <why>"), except
  // argparse's usage errors, which are also exit 2: those mean the CLI's arguments changed, not that this change was
  // refused (argparse docs: it exits 2 and prints usage; read with the engines CLI, 2026-10-09).
  const call = async (args: string[], okCodes: number[] = [0]) => enginesText(await runEngines(program, args, env), okCodes);
  const json = (text: string, what: string): unknown => {
    try { return JSON.parse(text); } catch { throw new EnginesError("unavailable", `engines ${what} didn't answer in JSON`); }
  };

  // Two CLI runs: the roles (hashed for the version) and the providers.
  const settings = async (): Promise<EnginesSettings> => {
    const [rolesOut, providersOut] = await allEnded([call(["get", "--json"]), call(["providers", "--json"])]);
    return { version: createHash("sha256").update(rolesOut).digest("hex"), roles: rolesFrom(json(rolesOut, "get")), providers: providersFrom(json(providersOut, "providers")) };
  };

  return {
    async probe() {
      const help = await call(["other-provider", "--help"]);
      return /--effective\b/.test(help) ? null
        : `${program} is older than the Engines page needs: its other-provider has no --effective. Update the engine-layer CLI so other-provider lists --effective.`;
    },
    settings,
    // The page's look: the roles, the providers (unless the caller already has them), the kill switch, and what the
    // resolver would run now for each role, a few resolves at a time.
    async read(reuse) {
      const rolesOutP = call(["get", "--json"]);
      const providersOutP = reuse ? Promise.resolve<string | null>(null) : call(["providers", "--json"]);
      const [rolesOut, providersOut, enabledOut] = await allEnded([rolesOutP, providersOutP, call(["option", "enabled"])]);
      const roles = rolesFrom(json(rolesOut, "get"));
      const providers = reuse ? reuse.providers : providersFrom(json(providersOut ?? "", "providers"));
      const now = await mapLimit(roles, RESOLVE_AT_ONCE, async r => nowFrom(json(await call(["resolve", r.role, "--json"], [0, 3]), "resolve")));
      return {
        version: createHash("sha256").update(rolesOut).digest("hex"), providers,
        enabled: json(enabledOut, "option") === true,
        roles: roles.map((r, i) => ({ ...r, now: now[i] as EnginesNow })),
      };
    },
    async setChain(role, chain, force) {
      await call(["set", role, chainArg(chain), ...(force ? ["--force"] : [])]);
    },
    // The rule as the resolver applies it, in one atomic write: off with --effective also clears the settings'
    // review_other_provider for review; on sets the role's own flag. The CLI owns that rule, not the hub.
    async setOtherProvider(role, on) {
      await call(["other-provider", role, on ? "on" : "off", "--effective"]);
    },
  };
}

// ---- translation: the CLI's JSON into the domain's terms; a shape it doesn't know is refused, never guessed at.

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every(x => typeof x === "string") ? v : null);
const shape = (what: string) => new EnginesError("unavailable", `engines ${what} answered in a shape this hub doesn't know`);

function chainOf(v: unknown, what: string): Engine[] {
  const texts = strings(v);
  if (!texts?.length) throw shape(what);
  return texts.map(t => parseEngine(t) ?? (() => { throw shape(what); })());
}

export function rolesFrom(v: unknown): RoleEngines[] {
  if (!isObject(v)) throw shape("get");
  return Object.entries(v).map(([role, r]) => {
    if (!isObject(r)) throw shape("get");
    return {
      role, label: typeof r.label === "string" ? r.label : role,
      chain: chainOf(r.chain, "get"),
      riskChain: r.risk_chain === undefined ? null : chainOf(r.risk_chain, "get"),
      // What the resolver applies (both flags for review). A CLI without the field is older than the probe allows.
      otherProvider: typeof r.other_provider_effective === "boolean" ? r.other_provider_effective : (() => { throw shape("get"); })(),
    };
  });
}

const MARK = /^(\S+) until (.+)$/;

export function providersFrom(v: unknown): EngineProvider[] {
  if (!Array.isArray(v)) throw shape("providers");
  return v.map(p => {
    if (!isObject(p) || typeof p.provider !== "string") throw shape("providers");
    const name = p.provider;
    // efforts: null = the provider lists none, so the CLI takes any effort; [] = it takes none. Absent: a CLI older than
    // the probe allows (verify round, findings 4 and 5: no half-support).
    const models = strings(p.models), marks = strings(p.marks ?? []);
    const efforts = p.efforts === null ? null : strings(p.efforts);
    if (!models || (p.efforts !== null && !efforts) || !marks) throw shape("providers");
    const login = p.login === "ok" || p.login === "missing" ? p.login : "unknown";
    let until: string | null = null;
    const pausedModels: { model: string; until: string }[] = [];
    for (const m of marks) {
      const [, key = "", when = ""] = MARK.exec(m) ?? [];
      if (key === name) until = when;
      else if (key.startsWith(`${name}:`)) pausedModels.push({ model: key.slice(name.length + 1), until: when });
    }
    return {
      name, label: typeof p.label === "string" && p.label ? p.label : name, kind: p.kind === "studio" ? "studio" : "cli",
      models, efforts,
      availability: availabilityOf({ enabled: p.enabled !== false, installed: p.installed === true, login, providerMarked: until !== null }),
      until, pausedModels,
    };
  });
}

export function nowFrom(v: unknown): EnginesNow {
  if (!isObject(v) || !Array.isArray(v.skipped)) throw shape("resolve");
  const picked = isObject(v.picked) && typeof v.picked.entry === "string" ? v.picked.entry : null;
  return {
    engine: picked,
    skipped: v.skipped.filter(isObject).map(s => ({ engine: typeof s.entry === "string" ? s.entry : "", reason: typeof s.reason === "string" ? s.reason : "" })),
  };
}
