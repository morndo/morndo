// The Rollout the fleet carries (updates design §4.2 RL11/RL12, §4.3, §4.5, §7; ADR-0019 §7): the control plane
// commits only the Version it runs itself, one node's rollback halts the Rollout everywhere until the principal's
// word resumes it, and every change reaches the clients as the `rollout` event and every CAP_ROLLOUT agent as the
// `rollout` message. The words of the state machine are the domain's own: beginRollout starts a Version unhalted,
// haltRollout stays until resumeRollout (RL12) — here as the rows the store keeps, with the reason and the time the
// wire adds. Ordering is the domain's too (compareVersions): latest() is the highest Version, not the newest row.
// A node's updater report arrives with its health (§6.3): a rollback — its own or a failed one — alerts once per
// node and target and halts the Rollout of the Version it was leaving. A report with no target halts nothing: the
// fleet cannot know which Rollout the node fell out of, and the alert says what happened.
import { DEFAULT_SOAK_MINUTES, compareVersions, equalVersions, parseVersion } from "@morndo/domain";
import type { NodeUpdateHealth, RolloutWire } from "@morndo/protocol";
import type { RolloutsStore } from "../adapters/rollouts-store.ts";
import type { Audit } from "../adapters/audit.ts";
import type { EventHub } from "./events.ts";

// One write's answer: `changed` says whether the Rollout moved (a halt of an already-halted Rollout, or of a Version
// nobody committed, changes nothing and raises nothing); `rollout` is the Rollout as it stands after — the one
// written, or the latest when the write touched none.
export type RolloutWrite = { ok: true; changed: boolean; rollout: RolloutWire | null };
export type RolloutRefusal = { ok: false; refused: "not_allowed" | "not_halted"; message: string };

// The name a halt carries when the control plane's own updater rolled back: the fleet knows no node name for its own
// machine, and the name says where it happened.
export const CONTROL_PLANE_MACHINE = "control-plane";

export class Rollouts {
  #store: RolloutsStore;
  #audit: Audit;
  #events: EventHub;
  #push: { pushRollout(r: RolloutWire, offerFor: (node: string) => { version: string; attempt: string } | null): void };
  #own: { version: string; commit: string | null };
  #now: () => number;

  constructor(p: {
    store: RolloutsStore; audit: Audit; events: EventHub; push: { pushRollout(r: RolloutWire, offerFor: (node: string) => { version: string; attempt: string } | null): void };
    own: { version: string; commit: string | null }; now?: () => number;
  }) {
    this.#store = p.store;
    this.#audit = p.audit;
    this.#events = p.events;
    this.#push = p.push;
    this.#own = p.own;
    this.#now = p.now ?? Date.now;
  }

  controlPlane(): { version: string; commit: string | null } { return this.#own; }

  // The Rollout nodes follow: the highest Version at or below the control plane's own (the domain's compare, not
  // the newest row), or null. A halt above it — the control plane's own rollback from a Version it no longer runs —
  // never stands in for it (review of #107): no node may run above its control plane anyway (RL11).
  latest(): RolloutWire | null {
    return this.#store.list().filter(r => !this.aboveOwn(r.version)).reduce<RolloutWire | null>((high, r) => {
      const a = parseVersion(r.version), b = high === null ? null : parseVersion(high.version);
      return high === null || (a !== null && b !== null && compareVersions(a, b) > 0) ? r : high;
    }, null);
  }

  // The halted Rollouts above the control plane's Version, highest first: what the control plane rolled back from.
  // They stay until the principal resumes them (or a newer Release); the app shows them beside the Rollout.
  aboveControlPlane(): RolloutWire[] {
    return this.#store.list().filter(r => r.halted && this.aboveOwn(r.version))
      .sort((x, y) => compareVersions(parseVersion(y.version)!, parseVersion(x.version)!));
  }

  // The stored Rollout of a Version by precedence (SemVer §10: build metadata does not count), so no spelling of a
  // Version escapes its halt. The edges refuse build metadata already; this holds even for a row written before.
  #find(version: string): RolloutWire | null {
    const v = parseVersion(version);
    if (v === null) return null;
    return this.#store.list().find(r => { const w = parseVersion(r.version); return w !== null && compareVersions(v, w) === 0; }) ?? null;
  }

  // RL11, as the agent gate asks it: is this Version above the one the control plane runs?
  aboveOwn(version: string): boolean {
    const a = parseVersion(version), b = parseVersion(this.#own.version);
    return a !== null && b !== null && compareVersions(a, b) > 0;
  }

  // RL12: is the Rollout of this Version halted? A Version nobody committed is not.
  halted(version: string): boolean {
    return this.#find(version)?.halted ?? false;
  }

  // The control plane commits its own running Version (§4.3): a fleet never asks a node for a Version it doesn't run
  // itself. A commit starts the soak from now; a halt stays through it (RL12: only the principal's resume, or a newer
  // Release, lifts it), so a control plane the principal moved onto a halted Version by hand starts no node.
  committed(version: string, soakMinutes: number = DEFAULT_SOAK_MINUTES): RolloutWrite | RolloutRefusal {
    const a = parseVersion(version), b = parseVersion(this.#own.version);
    if (a === null || b === null || !equalVersions(a, b))
      return { ok: false, refused: "not_allowed", message: `the control plane runs ${this.#own.version}, not ${version}` };
    const was = this.#find(version);
    const r: RolloutWire = {
      version, controlPlaneCommittedAt: this.#now(), soakMinutes,
      halted: was?.halted ?? false, haltedBy: was?.haltedBy ?? null, haltReason: was?.haltReason ?? null, haltedAt: was?.haltedAt ?? null,
    };
    this.#store.put(r);
    return { ok: true, changed: true, rollout: this.#announce(r) };
  }

  // One machine's rollback (RL12) or the principal's hand stops the Rollout of a Version everywhere. Idempotent: a
  // halt of a halted Rollout is the halt it already is — one alert, however often it is asked. A Version the control
  // plane never committed is halted too, with no commit time: the control plane's own rollback comes before its
  // commit (review focus 2, "a rollback on cp halts nodes"), and a node must still learn that Version is halted.
  halt(version: string, machine: string, reason: string): RolloutWrite {
    const r = this.#find(version) ?? {
      version, controlPlaneCommittedAt: null, soakMinutes: DEFAULT_SOAK_MINUTES,
      halted: false, haltedBy: null, haltReason: null, haltedAt: null,
    };
    if (r.halted) return { ok: true, changed: false, rollout: r };
    const halted: RolloutWire = { ...r, halted: true, haltedBy: machine, haltReason: reason, haltedAt: this.#now() };
    this.#audit.alert("rollout_halted", null, { version, machine, reason });
    this.#store.put(halted);
    return { ok: true, changed: true, rollout: this.#announce(halted) };
  }

  // The principal's word (RL12): a resume clears the halt — the audit row for it is the route's, with the client.
  resume(version: string): RolloutWrite | RolloutRefusal {
    const r = this.#find(version);
    if (r === null || !r.halted) return { ok: false, refused: "not_halted", message: `the Rollout of ${version} is not halted` };
    const resumed: RolloutWire = { ...r, halted: false, haltedBy: null, haltReason: null, haltedAt: null };
    this.#store.put(resumed);
    return { ok: true, changed: true, rollout: this.#announce(resumed) };
  }

  // The store, for the tests' clock-driven pruning case.
  get store(): RolloutsStore { return this.#store; }

  // What a node may follow and the attempt id it reports a rollback of it under (welcome, the rollout message): the
  // Rollout nodes follow, once the control plane committed it and while it is not halted (review of #107, round 4).
  offerFor(node: string): { version: string; attempt: string } | null {
    const r = this.latest();
    if (r === null || r.controlPlaneCommittedAt === null || r.halted) return null;
    return { version: r.version, attempt: this.#store.issue(node, r.version, this.#now()) };
  }

  // The attempt id an update.apply to a node carries: the fleet's, never the caller's.
  issueFor(node: string, version: string): string { return this.#store.issue(node, version, this.#now()); }

  // A machine's updater report (§6.3): a node's in its health, the control plane's own from its updater's state file
  // (`own`). A rollback — succeeded or failed — halts the Version it was leaving only under an attempt id the fleet
  // issued that machine for that Version and has not spent (review of #107, round 4): a node gets its ids with its
  // offers, the control plane announces its own (random) one in its `applying` record. The id is spent only when the
  // report is accepted, so a report ignored for another reason does not use up a real id; a forged, foreign or spent
  // id halts nothing. It must also be plausible: the target newer than what the machine ran, and, for a node, not
  // above the control plane (RL11). An ignored report is alerted once per machine, id and reason in this process (the
  // report repeats with every health), and halts nothing.
  health(machine: string, update: NodeUpdateHealth, o: { own?: boolean } = {}): void {
    if (o.own && update.state === "applying" && update.attempt !== undefined && update.target !== undefined) {
      this.#store.register(machine, update.target, update.attempt, this.#now());
      return;
    }
    if (update.state !== "rolled_back" && update.state !== "rollback_failed") return;
    const kind = update.state === "rolled_back" ? "update_rolled_back" : "update_rollback_failed";
    const target = update.target ?? null;
    const reason = update.reason ?? update.failedCheck ?? null;
    const ignored = this.#refusal(machine, update, o.own === true);
    const detail = {
      machine, version: update.version, ...(target === null ? {} : { target }), ...(reason === null ? {} : { reason }),
      ...(update.attempt === undefined ? {} : { attempt: update.attempt }),
    };
    if (ignored !== null) {
      const key = `${machine}|${update.attempt ?? "-"}|${ignored}`;
      if (this.#ignoredSeen.has(key)) return;
      if (this.#ignoredSeen.size >= 1000) this.#ignoredSeen.clear();
      this.#ignoredSeen.add(key);
      this.#audit.alert(kind, o.own ? null : machine, { ...detail, ignored });
      return;
    }
    if (!this.#store.used(update.attempt!, this.#now())) return;
    this.#audit.alert(kind, o.own ? null : machine, detail);
    this.halt(target!, machine, reason ?? `${machine} reports a ${update.state === "rolled_back" ? "rollback" : "failed rollback"} without a reason`);
  }
  #ignoredSeen = new Set<string>();

  // Why a rollback report halts nothing, or null when it may.
  #refusal(machine: string, update: NodeUpdateHealth, own: boolean): string | null {
    if (update.target === undefined) return "it names no target";
    if (update.attempt === undefined) return "it carries no attempt id";
    const issued = this.#store.lookup(update.attempt);
    if (issued === null) return "the fleet never issued that attempt id";
    if (issued.usedAt !== null) return "that attempt was counted already";
    if (issued.machine !== machine) return "that attempt id was issued to another machine";
    const t = parseVersion(update.target), ran = parseVersion(update.version), was = parseVersion(issued.version);
    if (t === null || was === null || compareVersions(t, was) !== 0) return `that attempt id was issued for ${issued.version}, not ${update.target}`;
    if (ran === null || compareVersions(t, ran) <= 0) return `its target ${update.target} is not newer than ${update.version}, the Version it ran`;
    if (!own && this.aboveOwn(update.target)) return `${update.target} is above the control plane's ${this.#own.version}: no node runs it`;
    return null;
  }

  // Every change of the Rollout reaches the clients as the `rollout` event (node: "", the fleet's own) and every
  // connected agent that announced CAP_ROLLOUT as the `rollout` message (updates §7).
  #announce(r: RolloutWire): RolloutWire {
    this.#events.emit({ t: "rollout", node: "", body: r });
    this.#push.pushRollout(r, node => this.offerFor(node));
    return r;
  }
}
