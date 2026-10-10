// Done keys in two phases (spec §5.3, "Idempotency"; ADR-0012 decision 7). `started` is committed before a side effect
// and `done` with its outcome after it, in the agent database. `started` is the one commit there synced to the disk
// (synchronous=FULL for that transaction; the database otherwise runs NORMAL, db/open.ts, spec §16.4): it alone must
// outlive a power loss, a crash of the machine or a disk that fails while the machine runs on, because a client may
// retry to another pane than the first attempt typed into (the hub's answers to the manager go by name), where no
// expectation check can tell. If the disk can't take it, the commit throws and nothing is typed (executor.ts). A lost
// `done` leaves `started`, so a repeat stays uncertain. A refusal before any side effect deletes the key, so a retry acts as if the first attempt
// never came. A repeat of a done key gets the stored outcome; of a started key, `uncertain`; of a key whose hash differs
// (other effect-determining arguments), `uncertain` too: that key's op may have run. The hash covers only what decides
// the effect (EFFECT_FIELDS), never `expect`, so a retry with a refreshed expectation is the same request. Keys are kept
// 7 days (LIMITS.doneKeyTtlMs). Disabled (the test hook noDoneKeys), nothing is recorded or consulted: a repeat acts
// again, the negative control for what the keys prevent.
// The store sequence (spec §5.3; final review I2): the database counts the keyed ops it has started (table store_seq),
// one more in the same transaction that commits each `started`, so the count can never say a `started` was written that
// isn't there, nor miss one that is. It is never lowered here; only a database put back from an older copy goes back.
// Every answer carries it (agent.ts), so the hub can tell such a database from the one its send went to, even when the
// copy kept the store id (cp over the file in place, a VM snapshot).
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { LIMITS, type OpName } from "@morndo/protocol";

// Runs one transaction with synchronous=FULL, then sets the connection back to NORMAL. In WAL mode FULL adds "an additional
// sync operation of the WAL file ... after each transaction commit" (https://www.sqlite.org/pragma.html#pragma_synchronous,
// read 2026-10-08), and a sync of the WAL file keeps every commit before it in that file too.
// Its own transaction only: SQLite refuses to change the setting inside one. A transaction left open (a rollback that
// failed) keeps FULL, slower but safe, rather than hiding the error behind the setting's.
export function synced<T>(db: Database.Database, transaction: () => T): T {
  if (db.inTransaction) throw new Error("synced() runs its own transaction; it can't be nested in another");
  db.pragma("synchronous = FULL");
  try { return transaction(); } finally { if (!db.inTransaction) db.pragma("synchronous = NORMAL"); }
}

export type Prior = { state: "none" } | { state: "started" } | { state: "done"; outcome: unknown } | { state: "mismatch" };
export type KeyStatus = { state: "unknown" } | { state: "started" } | { state: "done"; outcome: unknown };

// JSON with object keys sorted at every level, so the same arguments hash alike however a client ordered them.
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

// What decides each keyed op's effect (plan Contracts, "Behaviour the agent and the fleet agree on"). Never `expect`, a
// timeout or the request id.
export const EFFECT_FIELDS: { readonly [O in OpName]?: readonly string[] } = {
  "pane.send": ["workerId", "text"],
  "lane.start": ["name", "cwd", "account", "resume"],
  "lane.stop": ["name"],
  "worktree.add": ["repo", "name", "base"],
  "file.put": ["upload", "offset"],
  "job.notice": ["id", "lane", "text"],
  "connections.priority": ["version", "mode", "order"],
  "connections.role": ["version", "role", "override", "order", "picks", "action"],
  "connections.revoke": ["version", "name"],
  "connections.narrow": ["version", "name", "action", "budget", "deny"],
};

export const argsHash = (op: string, args: unknown): string => {
  const fields = EFFECT_FIELDS[op as OpName];
  const all = (args !== null && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const picked = fields ? Object.fromEntries(fields.map(f => [f, all[f]])) : args;
  return createHash("sha256").update(`${op}\n${stableJson(picked)}`).digest("hex");
};

type Row = { hash: string; state: "started" | "done"; outcome: string | null };

export class DoneKeys {
  #db: Database.Database;
  #now: () => number;
  #disabled: boolean;
  #seq: number;                                             // store_seq as last committed (this agent is its only writer)

  constructor(db: Database.Database, now: () => number = Date.now, o: { disabled?: boolean } = {}) {
    this.#db = db;
    this.#now = now;
    this.#disabled = o.disabled === true;
    this.#seq = (db.prepare("SELECT seq FROM store_seq WHERE one = 1").get() as { seq: number } | undefined)?.seq ?? 0;
  }

  // The store sequence now: how many keyed ops this database has started. Every answer carries it.
  seq(): number { return this.#seq; }

  #row(key: string): Row | undefined {
    if (this.#disabled) return undefined;
    return this.#db.prepare("SELECT hash, state, outcome FROM done_keys WHERE key = ?").get(key) as Row | undefined;
  }

  lookup(key: string, hash: string): Prior {
    const r = this.#row(key);
    if (!r) return { state: "none" };
    if (r.hash !== hash) return { state: "mismatch" };
    if (r.state === "started") return { state: "started" };
    return { state: "done", outcome: r.outcome === null ? null : JSON.parse(r.outcome) as unknown };
  }

  // Phase 1, committed and synced to the disk before the side effect, with the store sequence one higher in the same
  // transaction. False if the key appeared meanwhile (then the caller answers uncertain, and the sequence is unchanged).
  start(key: string, hash: string): boolean {
    if (this.#disabled) return true;
    const seq = synced(this.#db, () => this.#db.transaction((): number | null => {
      const fresh = this.#db.prepare("INSERT INTO done_keys (key, hash, state, at) VALUES (?, ?, 'started', ?) ON CONFLICT(key) DO NOTHING")
        .run(key, hash, this.#now()).changes === 1;
      if (!fresh) return null;
      return (this.#db.prepare("UPDATE store_seq SET seq = seq + 1 WHERE one = 1 RETURNING seq").get() as { seq: number }).seq;
    })());
    if (seq === null) return false;
    this.#seq = seq;                                        // only once committed
    return true;
  }

  // Phase 2, after the side effect.
  finish(key: string, outcome: unknown): void {
    if (this.#disabled) return;
    this.#db.prepare("UPDATE done_keys SET state = 'done', outcome = ?, at = ? WHERE key = ?").run(JSON.stringify(outcome), this.#now(), key);
  }

  // A refusal before any side effect: as if the key never came.
  release(key: string): void {
    if (this.#disabled) return;
    this.#db.prepare("DELETE FROM done_keys WHERE key = ? AND state = 'started'").run(key);
  }

  status(key: string): KeyStatus {
    const r = this.#row(key);
    if (!r) return { state: "unknown" };
    if (r.state === "started") return { state: "started" };
    return { state: "done", outcome: r.outcome === null ? null : JSON.parse(r.outcome) as unknown };
  }

  prune(): number {
    return this.#db.prepare("DELETE FROM done_keys WHERE at < ?").run(this.#now() - LIMITS.doneKeyTtlMs).changes;
  }
}
