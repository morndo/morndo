// Page commands. A role save calls RoutingService and nothing else: the service is what writes a chain.
import { findConnection, type Actor, type Mode, type Override, type RepoRule, type Result } from "@morndo/domain";
import type { NarrowCommand, PriorityCommand, RevokeCommand, RoleCommand } from "@morndo/protocol";
import { ConnectionsService } from "./connections-service.ts";
import { buildPage, type OutsideChain, type PageUsage } from "./page.ts";
import type { ConnectionLifecycle, Deps, Failure, PoolNames } from "./ports.ts";
import { RoutingService } from "./routing-service.ts";

type Out = Result<void, Failure>;
type Routing = Pick<RoutingService, "commitPriority" | "commitRole" | "reapply">;
type Register = Pick<ConnectionsService, "revoke" | "turnOff" | "setBudget" | "setRepo">;

export function applyPriority(routing: Routing, body: { mode: Mode; order: readonly string[] }, command: string): Out {
  return routing.commitPriority(body.mode, [...body.order], command);
}

export function applyRole(routing: Routing, body: { role: string; override: Override; order: readonly string[]; picks: readonly string[]; riskPicks?: readonly string[]; action: "save" | "reapply" | "keep-hand" }, command: string): Out {
  if (body.action === "reapply") return routing.reapply(body.role);
  const override = body.action === "keep-hand" ? "hand" : body.override;
  const priority = override === "own" ? { mode: "custom" as const, order: [...body.order] } : null;
  return routing.commitRole(body.role, override, priority, body.picks, body.riskPicks, command);
}

export function applyRevoke(connections: Pick<ConnectionsService, "revoke">, name: string, actor: Actor): Out {
  return connections.revoke(name, actor);
}

const operator: Actor = { kind: "operator" };

export function applyNarrow(connections: Register, body: { name: string; action: "off" | "lower-budget" | "deny"; budget?: number; deny?: string }, repo: RepoRule | null): Out {
  if (body.action === "off") return connections.turnOff(body.name);
  if (body.action === "lower-budget") {
    if (body.budget === undefined) return { ok: false, error: { problem: "budget" } };
    return connections.setBudget(body.name, { kind: "capped", amount: body.budget }, operator);
  }
  if (body.deny === undefined) return { ok: false, error: { problem: "repo" } };
  return connections.setRepo(body.name, { allow: [...(repo?.allow ?? [])], deny: [...(repo?.deny ?? []), body.deny] }, operator);
}

export type BoundCommands = {
  page(): ReturnType<typeof buildPage>;
  priority(body: PriorityCommand, command: string): { ok: true } | { ok: false; problem: string };
  role(body: RoleCommand, command: string): { ok: true } | { ok: false; problem: string };
  revoke(body: RevokeCommand, command: string): { ok: true } | { ok: false; problem: string };
  narrow(body: NarrowCommand, command: string): { ok: true } | { ok: false; problem: string };
};

const done = (result: Out): { ok: true } | { ok: false; problem: string } => (result.ok ? { ok: true } : { ok: false, problem: result.error.problem });

export function bindCommands(deps: Deps, usage: () => Readonly<Record<string, PageUsage>> = () => ({}), pools: () => readonly PoolNames[] = () => [], life?: ConnectionLifecycle): BoundCommands {
  const routing = new RoutingService(deps, pools);
  // A revoke from the page tells the key pools as a revoke at the machine does.
  const connections = new ConnectionsService(deps, life);
  const current = () => deps.store.load().version;
  const stale = (version: number) => version !== current();
  const outside = (): OutsideChain[] => deps.engines.chains().map(chain => ({ role: chain.role, chain: chain.chain, risk: chain.risk }));
  return {
    page: () => {
      const loaded = deps.store.load();
      return buildPage({
        version: loaded.version, directory: loaded.directory, policy: loaded.policy, presets: deps.catalog.presets(),
        alerts: deps.alerts.recent(), outside: outside(), usage: usage(), now: deps.clock.now(), pools: pools(),
      });
    },
    priority: (body, command) => (stale(body.version) ? { ok: false, problem: "conflict" } : done(applyPriority(routing, body, command))),
    role: (body, command) => (stale(body.version) ? { ok: false, problem: "conflict" } : done(applyRole(routing, body, command))),
    revoke: (body, command) => (stale(body.version) ? { ok: false, problem: "conflict" } : done(applyRevoke(connections, body.name, { kind: "principal", command }))),
    narrow: (body) => {
      if (stale(body.version)) return { ok: false, problem: "conflict" };
      const repo = findConnection(deps.store.load().directory, body.name)?.repo ?? null;
      return done(applyNarrow(connections, body, repo));
    },
  };
}
