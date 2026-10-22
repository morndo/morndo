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

export class Rollouts {
  #store: RolloutsStore;
  #audit: Audit;
  #events: EventHub;
  #push: { pushRollout(r: RolloutWire): void };
  #own: { version: string; commit: string | null };
  #now: () => number;

  constructor(p: {
    store: RolloutsStore; audit: Audit; events: EventHub; push: { pushRollout(r: RolloutWire): void };
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

  // A node's updater report from its health (§6.3): a rollback — succeeded or failed — is one alert per node and
  // target (the health repeats with every ping; the alert says it once) and halts the Rollout of the Version it was
  // leaving, the node's reason or failed check in the halt. A report with no target halts nothing (see the header).
  health(node: string, update: NodeUpdateHealth): void {
    if (update.state !== "rolled_back" && update.state !== "rollback_failed") return;
    const kind = update.state === "rolled_back" ? "update_rolled_back" : "update_rollback_failed";
    const target = update.target ?? null;
    const reason = update.reason ?? update.failedCheck ?? null;
    const action = `alert.${kind}`;
    const raised = this.#audit.of(action).some(a => a.node === node && (a.detail.target ?? null) === target);
    if (!raised)
      this.#audit.alert(kind, node, {
        version: update.version, ...(target === null ? {} : { target }), ...(reason === null ? {} : { reason }),
      });
    // A node never runs above its control plane (RL11), so a report of a rollback from above it is wrong on its face:
    // it is alerted, and halts nothing (review of #107: it would otherwise stand for the Rollout).
    if (target !== null && !this.aboveOwn(target)) this.halt(target, node, reason ?? `${node} reports a ${update.state === "rolled_back" ? "rollback" : "failed rollback"} without a reason`);
  }

  // Every change of the Rollout reaches the clients as the `rollout` event (node: "", the fleet's own) and every
  // connected agent that announced CAP_ROLLOUT as the `rollout` message (updates §7).
  #announce(r: RolloutWire): RolloutWire {
    this.#events.emit({ t: "rollout", node: "", body: r });
    this.#push.pushRollout(r);
    return r;
  }
}
