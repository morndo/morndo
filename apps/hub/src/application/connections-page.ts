// The settings page's commands (ADR-0018 §9, §11). Widening ones need a fresh passkey. The role write is the
// connections RoutingService, reached through the commands port, never this hub's engine CLI.
import { mayCommand, type AccessPolicy } from "@morndo/domain";
import {
  commandNeedsStepUp, type CommandKind, type ConnectionsPage, type NarrowCommand, type PriorityCommand, type RevokeCommand, type RoleCommand,
} from "@morndo/protocol";
import type { Authenticated } from "./access-service.ts";

export type ConnectionCommands = {
  page(): Promise<ConnectionsPage>;
  priority(body: PriorityCommand, command: string): Promise<{ ok: true } | { ok: false; problem: string }>;
  role(body: RoleCommand, command: string): Promise<{ ok: true } | { ok: false; problem: string }>;
  revoke(body: RevokeCommand, command: string): Promise<{ ok: true } | { ok: false; problem: string }>;
  narrow(body: NarrowCommand, command: string): Promise<{ ok: true } | { ok: false; problem: string }>;
};

export type PageResult = { ok: true; view: ConnectionsPage } | { ok: false; problem: string };

export class ConnectionsPageService {
  readonly #commands: ConnectionCommands;
  readonly #policy: () => AccessPolicy;
  readonly #now: () => number;
  constructor(commands: ConnectionCommands, policy: () => AccessPolicy, now: () => number = Date.now) {
    this.#commands = commands; this.#policy = policy; this.#now = now;
  }

  view(): Promise<ConnectionsPage> { return this.#commands.page(); }

  async run(a: Authenticated, kind: CommandKind, body: PriorityCommand | RoleCommand | RevokeCommand | NarrowCommand): Promise<PageResult> {
    if (commandNeedsStepUp(kind) && !mayCommand(a.session, this.#now(), this.#policy())) return { ok: false, problem: "step_up" };
    const command = "hub";
    const result = await (kind === "priority" ? this.#commands.priority(body as PriorityCommand, command)
      : kind === "role" ? this.#commands.role(body as RoleCommand, command)
        : kind === "revoke" ? this.#commands.revoke(body as RevokeCommand, command)
          : this.#commands.narrow(body as NarrowCommand, command));
    if (!result.ok) return result;
    return { ok: true, view: await this.#commands.page() };
  }
}
