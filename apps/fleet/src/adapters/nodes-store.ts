// The node registry and its join codes (spec 5.1, 6). A code is 16 random bytes, shown once in the join string, bound
// to one node name, single use, and valid for LIMITS.joinCodeTtlMs on the fleet's wall clock (the only clock in this
// rule, Review Focus 4). Only its SHA-256 is stored. A join names its node, and a code redeems only for the name it was
// issued for. A join is matched by comparing the hash against every stored one with timingSafeEqual, without stopping
// at the first match.
// A join and a revocation (the node's key, given or taken) and the next connection epoch (a fencing token: it only grows)
// are synced to the disk (db.ts `synced`, spec §6): each must outlive the machine. Issuing a code, `seen` and the source
// are not: a lost code is issued again, and the others are refreshed on the next connection.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { LIMITS, isNodeName } from "@morndo/protocol";
import { synced } from "./db.ts";
import { parsePublicKey } from "./keys.ts";

export type NodeRow = {
  name: string; publicKey: string; createdAt: number; revokedAt: number | null; lastSeenAt: number | null;
  lastSource: string | null; agentVersion: string | null; connEpoch: number;
  lastProto: number[] | null;                          // the protocols its last hello named (migration 17)
};
export type Issued = { ok: true; code: string; expiresAt: number } | { ok: false; refused: "bad_name" | "exists" };
export type Redeemed = { ok: true; node: string } | { ok: false; refused: "unknown" | "expired" | "used" | "wrong_node" | "exists" | "bad_key" };

type Row = {
  name: string; public_key: string; created_at: number; revoked_at: number | null; last_seen_at: number | null;
  last_source: string | null; agent_version: string | null; conn_epoch: number; last_proto?: string | null;
};
const protoFrom = (text: string | null | undefined): number[] | null => {
  if (typeof text !== "string") return null;
  try { const v: unknown = JSON.parse(text); return Array.isArray(v) && v.every(n => Number.isInteger(n)) ? v as number[] : null; }
  catch { return null; }
};
const nodeFrom = (r: Row): NodeRow => ({
  name: r.name, publicKey: r.public_key, createdAt: r.created_at, revokedAt: r.revoked_at, lastSeenAt: r.last_seen_at,
  lastSource: r.last_source, agentVersion: r.agent_version, connEpoch: r.conn_epoch, lastProto: protoFrom(r.last_proto),
});

type CodeRow = { hash: string; node: string; expires_at: number; used_at: number | null };

const CODE_BYTES = 16;
const KEEP_USED_CODES_MS = 24 * 3_600_000;
const hashOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest();

export class NodesStore {
  #db: Database.Database;
  #now: () => number;

  constructor(db: Database.Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  // A code for `name`: refused for a name that isn't NODE_NAME, a reserved one (control-plane), or a node that is registered and not revoked (revoke
  // it first). A revoked name can be joined again, with a new key.
  issueCode(name: string): Issued {
    if (!isNodeName(name)) return { ok: false, refused: "bad_name" };          // the shape, and no reserved name
    if (this.active(name)) return { ok: false, refused: "exists" };
    const now = this.#now();
    const bytes = randomBytes(CODE_BYTES);
    const expiresAt = now + LIMITS.joinCodeTtlMs;
    this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM join_codes WHERE expires_at < ?").run(now - KEEP_USED_CODES_MS);
      this.#db.prepare("INSERT INTO join_codes (hash, node, expires_at, used_at) VALUES (?, ?, ?, NULL)").run(hashOf(bytes).toString("hex"), name, expiresAt);
    })();
    return { ok: true, code: bytes.toString("base64url"), expiresAt };
  }

  // A join by `node`: the code's node takes `publicKey`. Single use: the code is marked used in the same transaction.
  // A code issued for another name is refused and stays unused (nothing is stored).
  redeem(code: string, node: string, publicKey: string): Redeemed {
    const bytes = Buffer.from(code, "base64url");
    if (bytes.length !== CODE_BYTES || bytes.toString("base64url") !== code) return { ok: false, refused: "unknown" };
    if (!parsePublicKey(publicKey)) return { ok: false, refused: "bad_key" };
    const hash = hashOf(bytes);
    return synced(this.#db, () => this.#db.transaction((): Redeemed => {
      const now = this.#now();
      const rows = this.#db.prepare("SELECT hash, node, expires_at, used_at FROM join_codes").all() as CodeRow[];
      const matches = rows.filter(row => timingSafeEqual(Buffer.from(row.hash, "hex"), hash));   // every row compared
      const match = matches[0];
      if (!match) return { ok: false, refused: "unknown" };
      if (match.used_at !== null) return { ok: false, refused: "used" };
      if (now >= match.expires_at) return { ok: false, refused: "expired" };
      if (match.node !== node) return { ok: false, refused: "wrong_node" };
      if (this.active(match.node)) return { ok: false, refused: "exists" };
      this.#db.prepare("UPDATE join_codes SET used_at = ? WHERE hash = ?").run(now, match.hash);
      this.#db.prepare(`INSERT INTO nodes (name, public_key, created_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET public_key = excluded.public_key, revoked_at = NULL, last_source = NULL`).run(match.node, publicKey, now);
      return { ok: true, node: match.node };
    }).immediate());
  }

  node(name: string): NodeRow | null {
    const r = this.#db.prepare("SELECT * FROM nodes WHERE name = ?").get(name) as Row | undefined;
    return r ? nodeFrom(r) : null;
  }

  active(name: string): NodeRow | null {
    const n = this.node(name);
    return n && n.revokedAt === null ? n : null;
  }

  list(): NodeRow[] {
    return (this.#db.prepare("SELECT * FROM nodes ORDER BY name").all() as Row[]).map(nodeFrom);
  }

  // Revokes a registered node and withdraws its unused codes. False when there was no active node of that name.
  revoke(name: string): boolean {
    return synced(this.#db, () => this.#db.transaction(() => {
      const changed = this.#db.prepare("UPDATE nodes SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL").run(this.#now(), name).changes > 0;
      this.#db.prepare("DELETE FROM join_codes WHERE node = ? AND used_at IS NULL").run(name);
      return changed;
    }).immediate());
  }

  // The next connection epoch of a node (a fencing token: it only grows, across restarts too).
  nextEpoch(name: string): number {
    const r = synced(this.#db, () => this.#db.prepare("UPDATE nodes SET conn_epoch = conn_epoch + 1 WHERE name = ? RETURNING conn_epoch").get(name)) as { conn_epoch: number } | undefined;
    if (!r) throw new Error(`no node ${name}`);
    return r.conn_epoch;
  }

  seen(name: string, agentVersion?: string, proto?: number[]): void {
    if (agentVersion === undefined) this.#db.prepare("UPDATE nodes SET last_seen_at = ? WHERE name = ?").run(this.#now(), name);
    else if (proto === undefined) this.#db.prepare("UPDATE nodes SET last_seen_at = ?, agent_version = ? WHERE name = ?").run(this.#now(), agentVersion, name);
    else this.#db.prepare("UPDATE nodes SET last_seen_at = ?, agent_version = ?, last_proto = ? WHERE name = ?")
      .run(this.#now(), agentVersion, JSON.stringify(proto), name);
  }

  // Records where a node connected from; returns the previous source when it was a different one (an alert, spec 8).
  recordSource(name: string, source: string): string | null {
    const before = this.node(name)?.lastSource ?? null;
    this.#db.prepare("UPDATE nodes SET last_source = ? WHERE name = ?").run(source, name);
    return before !== null && before !== source ? before : null;
  }
}
