// What a lane starts as (reliable lanes design §3.3, ADR-0027). Without `role` or `engine`, and without a default role, it
// is the node's `launch`, as before. Otherwise it is an engine (ADR-0013's provider:model[@effort]) started with the
// policy's launch command for that provider:
// - `engine` names it. With a default role on this node, naming one needs a `reason` (the fleet's audit keeps it).
// - `role` asks the engine layer's resolver what runs that role now (`<cli> resolve <role> --json`: exit 0 with a pick, 3
//   with none, engine-layer README; the hub's adapters/engines-cli.ts reads the same answer).
// - `policy.engines.defaultRole` is the role of a start that names neither, except a resume (it goes on as the session it
//   resumes) and a protected lane (the orchestrator restarting itself).
// - The engine layer's kill switch (`<cli> option enabled`: on only when it prints `true`, read as the hub reads it,
//   node-ops enginesEnabledOf) turns roles off: a default role is not applied, and a start that names a role or an
//   engine is refused. Output that isn't JSON is an engine layer that doesn't answer.
// Fail closed: a role nothing can fill now, a provider with no launch command here, a node without an engine layer, or a
// resolver that doesn't answer refuse the start. Nothing falls back quietly to `launch`. The answer names what ran and,
// for a role, what the resolver passed over first; the fleet raises engine_fallback when that list isn't empty.
// The launch command's words: `{model}`, `{effort}`, `{account}` and `{lane}` are filled in. A word that is only a
// placeholder whose value is missing is left out, with the option word just before it (`--effort {effort}` for a model
// without an effort); a placeholder inside a longer word whose value is missing refuses the start. An account given to a
// command without `{account}` is refused for a named engine, as for `launch`; for a role, whose pick the caller can't know,
// it goes only to a command that takes one. `resume` adds `--resume <session>`.
import { parseEngine, type Engine } from "@morndo/domain";
import { EnginesError, enginesEnabledOf, enginesText, runEngines } from "@morndo/node-ops";
import type { ErrorCode, LaneEngine, OpArgs } from "@morndo/protocol";
import type { Launch, Policy } from "../config.ts";

export type Skipped = { entry: string; reason: string };
export type Resolved = { picked: string | null; skipped: Skipped[] };
// The engine layer's CLI, as lane.start uses it. Tests replace it.
export type EngineLayer = {
  enabled(cli: string): Promise<boolean>;
  resolve(cli: string, role: string): Promise<Resolved>;
};

export type LaneLaunch = { via: Launch["via"]; command: string[]; engine?: LaneEngine };

// The node's own launch command for a start: `{account}` is the op's account, `resume` adds `--resume <session>`.
export function launchCommand(launch: Launch, a: { account?: string; resume?: string }): string[] | { refused: string } {
  const templated = launch.command.some(w => w.includes("{account}"));
  if (a.account !== undefined && !templated) return { refused: "this node's launcher takes no account (its command has no {account})" };
  if (a.account === undefined && templated) return { refused: "this node's launcher needs an account (its command has {account})" };
  const account = a.account;
  const words = account === undefined ? [...launch.command] : launch.command.map(w => w.replaceAll("{account}", account));
  return a.resume === undefined ? words : [...words, "--resume", a.resume];
}
export type Refusal = { refused: { code: ErrorCode; executed: "no"; message: string } };

const SKIPPED_MAX = 32;
const cut = (s: string) => s.slice(0, 200);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const refuse = (code: ErrorCode, message: string): Refusal => ({ refused: { code, executed: "no", message } });

export function engineLayer(env: NodeJS.ProcessEnv = process.env): EngineLayer {
  return {
    async enabled(cli) {
      return enginesEnabledOf(enginesText(await runEngines(cli, ["option", "enabled"], env)));
    },
    async resolve(cli, role) {
      const text = enginesText(await runEngines(cli, ["resolve", role, "--json"], env), [0, 3]);
      let v: unknown;
      try { v = JSON.parse(text); } catch { throw new EnginesError("unavailable", "engines resolve didn't answer in JSON"); }
      if (!isObject(v) || !Array.isArray(v.skipped)) throw new EnginesError("unavailable", "engines resolve answered without its skipped list");
      return {
        picked: isObject(v.picked) && typeof v.picked.entry === "string" ? v.picked.entry : null,
        skipped: v.skipped.filter(isObject).slice(0, SKIPPED_MAX)
          .map(s => ({ entry: cut(typeof s.entry === "string" ? s.entry : ""), reason: cut(typeof s.reason === "string" ? s.reason : "") })),
      };
    },
  };
}

// The words of an engine's launch command for this start, or why it can't start.
export function engineCommand(launch: Launch, engine: Engine, a: { name: string; account?: string; resume?: string }): string[] | { refused: string } {
  const value: Record<string, string | undefined> = { "{model}": engine.model || undefined, "{effort}": engine.effort || undefined, "{account}": a.account, "{lane}": a.name };
  const uses = (p: string) => launch.command.some(w => w.includes(p));
  if (a.account !== undefined && !uses("{account}")) return { refused: "this provider's launch command takes no account (it has no {account})" };
  if (uses("{lane}") && a.name.startsWith("-")) return { refused: "a lane started on an engine can't have a name that starts with \"-\"" };
  const words: string[] = [];
  for (const word of launch.command) {
    if (word in value && value[word] === undefined) {
      if (words.length > 1 && words.at(-1)?.startsWith("-")) words.pop();
      continue;
    }
    let out = word;
    for (const [p, v] of Object.entries(value)) {
      if (!out.includes(p)) continue;
      if (v === undefined) return { refused: `this provider's launch command needs ${p.slice(1, -1)}, and this start has none` };
      out = out.replaceAll(p, v);
    }
    words.push(out);
  }
  return a.resume === undefined ? words : [...words, "--resume", a.resume];
}

// The command this start runs, with the engine it names, or the refusal.
export async function laneLaunch(policy: Policy, a: OpArgs["lane.start"], layer: EngineLayer): Promise<LaneLaunch | Refusal> {
  const engines = policy.engines;
  if (a.role !== undefined && a.engine !== undefined) return refuse("bad_args", "name a role or an engine, not both");
  const defaulted = a.role === undefined && a.engine === undefined && a.resume === undefined && !policy.protected.includes(a.name)
    ? engines?.defaultRole : undefined;
  if (a.role === undefined && a.engine === undefined && defaulted === undefined) {
    const command = launchCommand(policy.launch, a);
    return Array.isArray(command) ? { via: policy.launch.via, command } : refuse("bad_args", command.refused);
  }
  if (!engines) return refuse("denied", "this node runs no engines (its policy has no engines)");
  if (a.engine !== undefined && engines.defaultRole !== undefined && a.reason === undefined) {
    return refuse("bad_args", `this node starts lanes on the role ${engines.defaultRole}; naming an engine instead needs a reason`);
  }
  const role = a.role ?? defaulted;
  if (role !== undefined && engines.cli === undefined) return refuse("denied", "this node has no engine layer to resolve a role (engines.cli)");
  let entry: string;
  let skipped: Skipped[] = [];
  try {
    if (engines.cli !== undefined && !(await layer.enabled(engines.cli))) {
      if (defaulted !== undefined) {
        const command = launchCommand(policy.launch, a);
        return Array.isArray(command) ? { via: policy.launch.via, command } : refuse("bad_args", command.refused);
      }
      return refuse("denied", "the engine layer is switched off on this node (engines option enabled)");
    }
    if (role === undefined) entry = a.engine as string;
    else {
      const r = await layer.resolve(engines.cli as string, role);
      if (r.picked === null) {
        const why = r.skipped.map(s => `${s.entry}: ${s.reason}`).join("; ");
        return refuse("denied", cut(`nothing can run the role ${role} on this node now${why ? ` (${why})` : ""}`));
      }
      entry = r.picked;
      skipped = r.skipped;
    }
  } catch (e) {
    if (e instanceof EnginesError && e.kind === "refused") return refuse("bad_args", cut(`the engine layer refused: ${e.message}`));
    return refuse("internal", cut(`the engine layer did not answer: ${e instanceof Error ? e.message : String(e)}`));
  }
  const engine = parseEngine(entry);
  if (!engine) return refuse("internal", cut(`the engine layer picked an entry this node can't read: ${entry}`));
  const launch = engines.launch[engine.provider];
  if (!launch) return refuse("denied", `this node has no launch command for the provider ${engine.provider} (engines.launch)`);
  // A role's pick is the resolver's, so its account goes only to a command that takes one.
  const { account: _account, ...withoutAccount } = a;
  const command = engineCommand(launch, engine, role !== undefined && !launch.command.some(w => w.includes("{account}")) ? withoutAccount : a);
  if (!Array.isArray(command)) return refuse("bad_args", command.refused);
  return {
    via: launch.via, command,
    engine: { entry, ...(role === undefined ? {} : { role }), ...(skipped.length ? { skipped } : {}) },
  };
}
