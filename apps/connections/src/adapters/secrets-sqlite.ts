// The node's Secrets in the Connections database (ADR-0022; design §6, "Metadata"): the held Secrets with their Grants,
// the fingerprint ledger with each version's vault ref, the events and the registered workspaces. It opens the file the
// Connections store opens, with the same checks, and runs the same migrations.
// A write is one BEGIN IMMEDIATE transaction: the change reads the state as committed now, and what it returns is saved
// before the commit, so the ledger check and the insert are one write (SC2). better-sqlite3, "transaction(function) ->
// function": a throw rolls back, and `.immediate` runs it with "BEGIN IMMEDIATE",
// https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md (13.0.3 installed), read 2026-10-12. BEGIN
// IMMEDIATE "start[s] a new write immediately", so a second writer waits (the timeout, 5 s) before it reads,
// https://www.sqlite.org/lang_transaction.html, read 2026-10-12.
import Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import type { LedgerEntry, Secret, SecretEvent, SecretGrant, SecretStatus, SecretVersion } from "@morndo/domain";
import type { SecretsDirectory, SecretsState, VaultRefRow, WorkspaceRow } from "../application/ports.ts";
import { openConnectionsDb } from "./store-sqlite.ts";

type SecretsHooks = { beforeSave?: () => void };
type SecretRow = {
  reference: string; status: SecretStatus; current: number | null; expiry: number | null; shape: string | null;
  warned: string; destinations: string; versions: string;
};
type LedgerRow = { reference: string; version: number; keyed_fingerprint: string; state: LedgerEntry["state"]; vault_ref: string | null };

const key = (reference: string, version: number) => JSON.stringify([reference, version]);

function toSecret(row: SecretRow, grants: readonly SecretGrant[]): Secret {
  const versions = JSON.parse(row.versions) as SecretVersion[];
  const current = row.current === null ? null : versions.find(v => v.number === row.current);
  if (current === undefined) throw new Error(`${row.reference}: its current version ${row.current} is not among its versions`);
  return {
    reference: row.reference, status: row.status, current, versions, grants,
    destinations: JSON.parse(row.destinations) as string[], expiry: row.expiry, shape: row.shape,
    warned: JSON.parse(row.warned) as string[],
  };
}

// Events are append-only: the next list holds every stored event, unchanged and in order, before any new one.
function extendsEvents(stored: readonly SecretEvent[], next: readonly SecretEvent[]): boolean {
  if (next.length < stored.length) return false;
  for (let i = 0; i < stored.length; i++) {
    if (next[i] !== stored[i] && !isDeepStrictEqual(next[i], stored[i])) return false;
  }
  return true;
}

// The ledger only grows: it outlives a Delete (SC8), so a revoked value stays refused (SC2). Every stored entry stays, in
// order, with its Reference, version and keyed fingerprint; only its state changes.
function ledgerGrows(stored: readonly LedgerEntry[], next: readonly LedgerEntry[]): boolean {
  if (next.length < stored.length) return false;
  for (let i = 0; i < stored.length; i++) {
    const a = stored[i];
    const b = next[i];
    if (!a || !b || a.reference !== b.reference || a.version !== b.version || a.fingerprint !== b.fingerprint) return false;
  }
  return true;
}

// Each vault row names one ledger entry, once; an entry no row names has no vault ref.
function vaultRefs(ledger: readonly LedgerEntry[], vaults: readonly VaultRefRow[]): Map<string, string | null> {
  const known = new Set(ledger.map(e => key(e.reference, e.version)));
  const refs = new Map<string, string | null>();
  for (const v of vaults) {
    const k = key(v.reference, v.version);
    if (!known.has(k) || refs.has(k)) throw new Error(`the vault ref for ${v.reference} version ${v.version} names no ledger entry, or names one twice`);
    refs.set(k, v.ref);
  }
  return refs;
}

export class SqliteSecrets implements SecretsDirectory {
  readonly #db: Database.Database;
  readonly #hooks: SecretsHooks;
  readonly #selectSecrets: Database.Statement;
  readonly #selectGrants: Database.Statement;
  readonly #selectLedger: Database.Statement;
  readonly #selectEvents: Database.Statement;
  readonly #selectWorkspaces: Database.Statement;
  readonly #clearSecrets: Database.Statement;
  readonly #clearGrants: Database.Statement;
  readonly #clearWorkspaces: Database.Statement;
  readonly #insertSecret: Database.Statement;
  readonly #insertGrant: Database.Statement;
  readonly #insertVersion: Database.Statement;
  readonly #updateVersion: Database.Statement;
  readonly #insertEvent: Database.Statement;
  readonly #insertWorkspace: Database.Statement;
  #closed = false;

  constructor(path: string, uid?: number, hooks?: SecretsHooks) {
    this.#hooks = hooks ?? {};
    this.#db = openConnectionsDb(path, uid);
    // Rows come back in the order they were written: the rewritten tables are emptied and refilled in order, and the
    // ledger and the events only grow.
    this.#selectSecrets = this.#db.prepare(
      "SELECT reference, status, current, expiry, shape, warned, destinations, versions FROM secrets ORDER BY rowid");
    this.#selectGrants = this.#db.prepare("SELECT reference, body FROM secret_grants ORDER BY rowid");
    this.#selectLedger = this.#db.prepare("SELECT reference, version, keyed_fingerprint, state, vault_ref FROM secret_versions ORDER BY rowid");
    this.#selectEvents = this.#db.prepare("SELECT body FROM secret_events ORDER BY seq");
    this.#selectWorkspaces = this.#db.prepare("SELECT name, root, at, command FROM secret_workspaces ORDER BY rowid");
    this.#clearSecrets = this.#db.prepare("DELETE FROM secrets");
    this.#clearGrants = this.#db.prepare("DELETE FROM secret_grants");
    this.#clearWorkspaces = this.#db.prepare("DELETE FROM secret_workspaces");
    this.#insertSecret = this.#db.prepare(
      "INSERT INTO secrets (reference, status, current, expiry, shape, warned, destinations, versions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    this.#insertGrant = this.#db.prepare("INSERT INTO secret_grants (reference, body) VALUES (?, ?)");
    this.#insertVersion = this.#db.prepare(
      "INSERT INTO secret_versions (reference, version, keyed_fingerprint, state, vault_ref) VALUES (?, ?, ?, ?, ?)");
    this.#updateVersion = this.#db.prepare("UPDATE secret_versions SET state = ?, vault_ref = ? WHERE reference = ? AND version = ?");
    this.#insertEvent = this.#db.prepare("INSERT INTO secret_events (type, reference, at, body) VALUES (?, ?, ?, ?)");
    this.#insertWorkspace = this.#db.prepare("INSERT INTO secret_workspaces (name, root, at, command) VALUES (?, ?, ?, ?)");
  }

  load(): SecretsState {
    return this.#db.transaction(() => this.#read())();
  }

  write<T>(change: (state: SecretsState) => { next: SecretsState | null; result: T }): T {
    return this.#db.transaction(() => {
      const state = this.#read();
      const { next, result } = change(state);
      if (next) {
        this.#hooks.beforeSave?.();
        this.#save(state, next);
      }
      return result;
    }).immediate();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #read(): SecretsState {
    const grants = new Map<string, SecretGrant[]>();
    for (const row of this.#selectGrants.all() as { reference: string; body: string }[]) {
      const list = grants.get(row.reference) ?? [];
      list.push(JSON.parse(row.body) as SecretGrant);
      grants.set(row.reference, list);
    }
    const held = (this.#selectSecrets.all() as SecretRow[]).map(row => toSecret(row, grants.get(row.reference) ?? []));
    const rows = this.#selectLedger.all() as LedgerRow[];
    const ledger = rows.map((r): LedgerEntry => ({ reference: r.reference, version: r.version, fingerprint: r.keyed_fingerprint, state: r.state }));
    const vaults = rows.map((r): VaultRefRow => ({ reference: r.reference, version: r.version, ref: r.vault_ref }));
    const events = (this.#selectEvents.all() as { body: string }[]).map(r => JSON.parse(r.body) as SecretEvent);
    const workspaces = (this.#selectWorkspaces.all() as WorkspaceRow[])
      .map((w): WorkspaceRow => ({ name: w.name, root: w.root, at: w.at, command: w.command }));
    return { directory: { held, ledger, events }, vaults, workspaces };
  }

  // `before` is what this transaction read, so its vaults line up with its ledger, one row per entry. Everything is
  // checked before the first write; a write SQLite refuses (a unique index, a check) rolls the transaction back.
  #save(before: SecretsState, next: SecretsState): void {
    const was = before.directory;
    const dir = next.directory;
    if (!extendsEvents(was.events, dir.events)) throw new Error("secret events are append-only: the next state drops or changes a stored event");
    if (!ledgerGrows(was.ledger, dir.ledger)) throw new Error("the fingerprint ledger only grows: the next state drops, moves or changes a stored entry");
    const refs = vaultRefs(dir.ledger, next.vaults);
    for (const s of dir.held) {
      const current = s.current;
      if (current !== null && !isDeepStrictEqual(s.versions.find(v => v.number === current.number), current)) {
        throw new Error(`${s.reference}: its current version is not one of its versions`);
      }
    }
    this.#clearGrants.run();
    this.#clearSecrets.run();
    for (const s of dir.held) {
      this.#insertSecret.run(s.reference, s.status, s.current?.number ?? null, s.expiry, s.shape,
        JSON.stringify(s.warned), JSON.stringify(s.destinations), JSON.stringify(s.versions));
      for (const g of s.grants) this.#insertGrant.run(s.reference, JSON.stringify(g));
    }
    for (const [i, e] of dir.ledger.entries()) {
      const k = key(e.reference, e.version);
      const old = was.ledger[i];
      // A row the change names sets the ref, null clearing it; an entry it leaves out keeps the stored one (review 9).
      const ref = refs.has(k) ? refs.get(k) ?? null : old ? before.vaults[i]?.ref ?? null : null;
      if (!old) this.#insertVersion.run(e.reference, e.version, e.fingerprint, e.state, ref);
      else if (old.state !== e.state || before.vaults[i]?.ref !== ref) this.#updateVersion.run(e.state, ref, e.reference, e.version);
    }
    for (let i = was.events.length; i < dir.events.length; i++) {
      const e = dir.events[i];
      if (e) this.#insertEvent.run(e.type, e.reference, e.at, JSON.stringify(e));
    }
    this.#clearWorkspaces.run();
    for (const w of next.workspaces) this.#insertWorkspace.run(w.name, w.root, w.at, w.command);
  }
}
