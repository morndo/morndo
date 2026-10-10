// The fleet's audit trail (spec 6, 8): who did what to which node, append-only, in fleet.db. An alert is an audit row
// whose action is "alert.<kind>" and a warning in the log; as an Alert (the Contracts' type: id is the row's seq, kind
// is the action without "alert.") it goes to `onAlert` as it is raised (the service sends it to /v1/events) and is
// served by GET /v1/alerts; `morndo-fleet status` lists the last day's. The detail never holds a hook body, typed
// text, keystrokes, a key or a code.
// GET /v1/alerts serves the latest ALERTS_SERVED of the security kinds and, apart, the latest ALERTS_SERVED of the
// others, so no number of dead letters or lane conflicts can push an instance conflict, a changed source address or a
// clock offset out of view. Rows go after LIMITS.auditKeepMs (90 days), alerts included: prune() runs on start and
// daily (serve.ts).
import type Database from "better-sqlite3";
import { LIMITS, type Alert, type AlertKind } from "@morndo/protocol";
import type { Logger } from "./log.ts";

export type AuditEntry = { seq: number; at: number; actor: string; action: string; node: string | null; detail: Record<string, unknown> };
type Row = { seq: number; at: number; actor: string; action: string; node: string | null; detail: string };

const entry = (r: Row): AuditEntry => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> });
const alertOf = (e: AuditEntry): Alert => ({ id: e.seq, at: e.at, node: e.node, kind: e.action.slice("alert.".length) as AlertKind, detail: e.detail });

export const ALERTS_SERVED = 500;                        // GET /v1/alerts: the latest 500 of each class, oldest first
// The kinds that say someone may be posing as a node or a node's clock can't be trusted: capped apart from the others.
export const SECURITY_ALERTS: readonly AlertKind[] = ["instance_conflict", "source_changed", "clock_offset"];
const SECURITY_ACTIONS = SECURITY_ALERTS.map(k => `alert.${k}`);
// Every "alert.*" action, as a range the (action, seq) index can scan: "/" is the character after ".".
const ALERT_RANGE = "action >= 'alert.' AND action < 'alert/'";
const IN_SECURITY = `action IN (${SECURITY_ACTIONS.map(() => "?").join(", ")})`;

export class Audit {
  #db: Database.Database;
  #now: () => number;
  #log: Logger | null;
  #onAlert: (a: Alert) => void;

  constructor(db: Database.Database, o: { now?: () => number; log?: Logger; onAlert?: (a: Alert) => void } = {}) {
    this.#db = db;
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? null;
    this.#onAlert = o.onAlert ?? (() => {});
  }

  record(actor: string, action: string, node: string | null, detail: Record<string, unknown> = {}): void {
    this.#insert(actor, action, node, detail);
  }

  // e.g. alert("instance_conflict", "pc", { … }): the row's action is "alert.instance_conflict".
  alert(kind: AlertKind, node: string | null, detail: Record<string, unknown> = {}): Alert {
    const a = alertOf(this.#insert("fleet", `alert.${kind}`, node, detail));
    this.#log?.warn(`alert: ${kind}${node ? ` on node ${node}` : ""}`);
    this.#onAlert(a);
    return a;
  }

  recent(limit = 50): AuditEntry[] {
    return (this.#db.prepare("SELECT * FROM audit ORDER BY seq DESC LIMIT ?").all(limit) as Row[]).map(entry);
  }

  alerts(since: number): AuditEntry[] {
    return (this.#db.prepare(`SELECT * FROM audit WHERE ${ALERT_RANGE} AND at >= ? ORDER BY seq`).all(since) as Row[]).map(entry);
  }

  // The latest `limit` security alerts and the latest `limit` others, merged, oldest first.
  recentAlerts(limit = ALERTS_SERVED): Alert[] {
    const security = this.#db.prepare(`SELECT * FROM audit WHERE ${IN_SECURITY} ORDER BY seq DESC LIMIT ?`).all(...SECURITY_ACTIONS, limit) as Row[];
    const others = this.#db.prepare(`SELECT * FROM audit WHERE ${ALERT_RANGE} AND NOT ${IN_SECURITY} ORDER BY seq DESC LIMIT ?`).all(...SECURITY_ACTIONS, limit) as Row[];
    return [...security, ...others].sort((a, b) => a.seq - b.seq).map(r => alertOf(entry(r)));
  }

  // Deletes every row older than LIMITS.auditKeepMs, alerts included; returns how many went.
  prune(): number {
    return this.#db.prepare("DELETE FROM audit WHERE at < ?").run(this.#now() - LIMITS.auditKeepMs).changes;
  }

  of(action: string): AuditEntry[] {
    return (this.#db.prepare("SELECT * FROM audit WHERE action = ? ORDER BY seq").all(action) as Row[]).map(entry);
  }

  #insert(actor: string, action: string, node: string | null, detail: Record<string, unknown>): AuditEntry {
    const at = this.#now();
    const r = this.#db.prepare("INSERT INTO audit (at, actor, action, node, detail) VALUES (?, ?, ?, ?, ?)").run(at, actor, action, node, JSON.stringify(detail));
    return { seq: Number(r.lastInsertRowid), at, actor, action, node, detail };
  }
}
