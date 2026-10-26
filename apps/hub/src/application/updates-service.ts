// The hub's updates service (updates design §8.1, PR 6c): the owner's one screen over every machine's Version, and
// the three commands off it. Every command is a Command twice over — mayCommand, and a step-up check no older than
// CONTROL_FRESHNESS_MS, the control gate's own freshness — and each one that runs is audited (UpdateCommanded).
// The control plane ("this machine", named control-plane) is told through its updater CLI: apply only once
// --status --json says that Version stands staged, and detached — the CLI starts the move and answers at once. A
// node is told through the fleet's update.apply, carrying the hub's signed assertion for exactly that node and
// Version (§5.4); a node's rollback is refused (not_yet): it is that machine's own hand, never a remote one. No I/O
// here: the fleet, the CLI, the signer, the audit and the build are ports (updates-ports.ts).
import { CONTROL_FRESHNESS_MS, mayCommand, type AccessPolicy, type UpdateCommanded } from "@morndo/domain";
import type { FleetNode, PrincipalAsk, RollbackPreview, RolloutWire, UpdatesNode, UpdatesView } from "@morndo/protocol";
import type { Authenticated } from "./access-service.ts";
import type { FleetForUpdates, FleetWriteOutcome, UpdaterCli } from "./updates-ports.ts";
import type { Store } from "../adapters/store.ts";

export type UpdatesCommandOutcome =
  | { ok: true }
  | { ok: false; problem: "step_up" }
  // The control plane's updater does not say this Version stands staged: the hub commands only what its own machine
  // already holds ready (updates §4.3: a Release is staged before it is applied).
  | { ok: false; problem: "not_staged"; message: string }
  // The machine named is no machine the fleet lists: no one to command. An empty list proves nothing (the fleet
  // may just not be answerable), so only a list that answers and omits it refuses here.
  | { ok: false; problem: "unknown_machine"; message: string }
  // A node's rollback is its own hand: `morndo update --rollback` on that machine, never a remote one (§5.4).
  | { ok: false; problem: "not_yet"; message: string }
  // §11.4's typed word (review round 1): a rollback whose restore drops a database's writes runs only under the
  // word, and the hub's own --yes is not it. The answer carries what would be dropped, so the screen can show it
  // and ask for the word; nothing has run.
  | { ok: false; problem: "needs_word"; message: string; restores: RollbackPreview["restores"] }
  | { ok: false; problem: "refused"; code: string; message: string }
  | { ok: false; problem: "unavailable"; message: string };

// This machine's name on the updates screen: the machine the hub itself runs on, moved through its own updater CLI.
export const CONTROL_PLANE_MACHINE = "control-plane";

export class UpdatesService {
  #fleet: FleetForUpdates;
  #cli: UpdaterCli;
  #sign: (ask: PrincipalAsk, now: number) => string;
  #store: Store;
  #policy: () => AccessPolicy;
  #now: () => number;
  #build: () => { version: string; commit: string | null };
  // The fleet node this machine is (MORNDO_CONTROL_PLANE_NODE), so the Updates page can fold it into This machine;
  // null when the hub is not told it.
  #ownNode: string | null;
  // The Rollout as the fleet's last `rollout` event said (§7), for the view when the fleet can't be asked now.
  #rollout: RolloutWire | null = null;

  constructor(p: {
    fleet: FleetForUpdates; cli: UpdaterCli; sign: (ask: PrincipalAsk, now: number) => string;
    store: Store; policy: () => AccessPolicy; now?: () => number; build: () => { version: string; commit: string | null };
    ownNode?: string | null;
  }) {
    this.#fleet = p.fleet; this.#cli = p.cli; this.#sign = p.sign; this.#store = p.store;
    this.#policy = p.policy; this.#now = p.now ?? Date.now; this.#build = p.build; this.#ownNode = p.ownNode ?? null;
  }

  // What the screen shows (§8.1): the fleet's Rollout and nodes, the control plane's own updater status, and the
  // hub's own build — the hub is the control plane (§7), so its Version is what every node's answers against. A
  // fleet that can't be asked leaves its last word standing: the Rollout its last event carried, no nodes.
  async view(): Promise<UpdatesView> {
    const [status, state, r, n] = await Promise.all([this.#cli.status(), this.#cli.state(), this.#fleet.rollout(), this.#fleet.nodes()]);
    const build = this.#build();
    return {
      controlPlane: { version: build.version, commit: build.commit, status, state, node: this.#ownNode },
      rollout: r.ok ? r.rollout : this.#rollout,
      aboveControlPlane: r.ok ? r.aboveControlPlane : [],
      nodes: n.ok ? n.nodes.map(node) : [],
    };
  }

  async apply(a: Authenticated, machine: string, version: string): Promise<UpdatesCommandOutcome> {
    // The command gate first (round 2, R4): a session that may not command is answered before anything is asked —
    // no fleet round trip, no 10 s CLI status — so a refused command costs the caller nothing but the refusal.
    if (!this.#command(a)) return { ok: false, problem: "step_up" };
    if (machine === CONTROL_PLANE_MACHINE) {
      // Only what stands staged (§4.3): the updater swaps to a Version it holds, never one named over it.
      const status = await this.#cli.status();
      if (status === null) return { ok: false, problem: "unavailable", message: "the control plane's updater did not answer (update --status --json)" };
      if (status.staged !== version) {
        return { ok: false, problem: "not_staged", message: `what stands staged on the control plane is ${status.staged ?? "nothing"}` };
      }
      try { await this.#cli.applyDetached(version); }
      catch (e) { return { ok: false, problem: "unavailable", message: `the control plane's updater did not take the command: ${(e as Error).message}` }; }
      this.#audit(a, "update.apply", machine, version);
      return { ok: true };
    }
    // A node is checked against the screen the button was pressed on: the fleet's own node list, and nothing
    // wider. An empty list proves nothing (the fleet may just not be answerable); a fleet that cannot be asked
    // answers through the write it refuses next.
    const known = await this.#fleet.nodes();
    if (known.ok && known.nodes.length > 0 && !known.nodes.some(n => n.name === machine)) {
      return { ok: false, problem: "unknown_machine", message: `${machine} is no machine the fleet lists` };
    }
    const r = await this.#fleet.applyUpdate(machine, version, this.#sign({ op: "update.apply", version, node: machine }, this.#now()));
    return this.#done(r, a, "update.apply", machine, version);
  }

  async rollback(a: Authenticated, machine: string, word?: string): Promise<UpdatesCommandOutcome> {
    if (!this.#command(a)) return { ok: false, problem: "step_up" };
    if (machine !== CONTROL_PLANE_MACHINE) {
      return { ok: false, problem: "not_yet", message: `run morndo update --rollback on ${machine}` };
    }
    // What this rollback would drop (§11.4, review round 1), asked before anything runs: the hub's own command
    // answers --yes, which a terminal reads as the [y/N] alone — the typed word a restore demands has to come
    // from the principal, through the body, or the rollback stops here with what it would drop.
    const preview = await this.#cli.rollbackPreview();
    if (preview === null) {
      return { ok: false, problem: "unavailable", message: "the control plane's updater did not answer (update --rollback --preview --json)" };
    }
    if (preview.restores.length > 0 && word !== "rollback") {
      return {
        ok: false, problem: "needs_word",
        message: `rolling back to ${preview.to} restores a database's backup and drops the writes since; type rollback to go on`,
        restores: preview.restores,
      };
    }
    try { await this.#cli.rollbackDetached(word); }
    catch (e) { return { ok: false, problem: "unavailable", message: `the control plane's updater did not take the command: ${(e as Error).message}` }; }
    this.#audit(a, "update.rollback", machine, null);
    return { ok: true };
  }

  async resume(a: Authenticated, version: string): Promise<UpdatesCommandOutcome> {
    if (!this.#command(a)) return { ok: false, problem: "step_up" };
    const r = await this.#fleet.resumeRollout(version, this.#sign({ op: "rollout.resume", version }, this.#now()));
    return this.#done(r, a, "rollout.resume", "fleet", version);
  }

  // The fleet's `rollout` event (§7): the last word on where the Rollout stands, kept for a view the fleet can't
  // answer. No feed frame carries it to a client yet (the page is PR 6c part 2).
  onRolloutEvent(rollout: RolloutWire): void { this.#rollout = rollout; }

  // A Command twice over (AC7): the endpoint may command at all, and its step-up check is as fresh as the control
  // gate's own window — the same five minutes that let it move the fleet's connections.
  #command(a: Authenticated): boolean {
    const now = this.#now();
    return mayCommand(a.session, now, this.#policy()) && now - a.session.verifiedAt < CONTROL_FRESHNESS_MS;
  }

  #done(r: FleetWriteOutcome, a: Authenticated, command: "update.apply" | "rollout.resume", machine: string, version: string): UpdatesCommandOutcome {
    if (r.ok) { this.#audit(a, command, machine, version); return { ok: true }; }
    return r.problem === "refused"
      ? { ok: false, problem: "refused", code: r.code, message: r.message }
      : { ok: false, problem: "unavailable", message: r.message };
  }

  #audit(a: Authenticated, command: "update.apply" | "update.rollback" | "rollout.resume", machine: string, version: string | null): void {
    const event: UpdateCommanded = { type: "UpdateCommanded", command, endpointId: a.endpoint.id, machine, version, at: this.#now() };
    this.#store.record([event]);
  }
}

// A fleet node as the updates screen reads it (§8.1): its name and status, the Version its agent said, the
// protocol versions its hello named, and its updater's last report — not its health or commit, which the fleet's
// own screens carry.
const node = (n: FleetNode): UpdatesNode =>
  ({ name: n.name, status: n.status, version: n.agent, proto: n.proto, update: n.update });
