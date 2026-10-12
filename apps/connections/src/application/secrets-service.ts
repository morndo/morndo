// The Secrets service on a node (ADR-0022; design §6, §14). A store writes the sealed value under a fresh vault ref, then
// runs the domain's check, writes the index and saves, all in one transaction of the SecretsDirectory (SC2, SC6), and
// removes the replaced version's file only after the commit (D2, decided on T-85). A refusal or a failure removes the new
// file; entries written before a rolled-back commit can only filter more, never less. No value passes through here: the
// vault answers with a keyed fingerprint, the index with keyed hashes.
import {
  WORKSPACE_NAME, deleteSecret, disableSecret, enableSecret, err, findSecret, grantSecret, ok, renewSecret, revokeSecret, storeSecret,
  ungrantSecret, type Actor, type GrantSubject, type Result, type SecretDirectory, type SecretEvent, type SecretGrant, type SecretProblem,
  type SecretRefusal, type ShapeInput,
} from "@morndo/domain";
import type {
  Clock, Ids, IndexWriter, SealedProblem, SealedStore, SecretsDirectory, SecretsState, VaultRefRow, WorkspaceRoots, WorkspaceRow,
} from "./ports.ts";

// How long an unreferenced vault file is left alone: a store writes its file before its transaction, so a younger one may
// belong to a store in progress in another process (review 5).
export const SWEEP_GRACE_MS = 0;

export type SecretsDeps = { clock: Clock; ids: Ids; vault: SealedStore; index: IndexWriter; secrets: SecretsDirectory; roots: WorkspaceRoots };
export type StoreRequest = {
  reference: string; sealed: Uint8Array; shape: ShapeInput; grants: readonly SecretGrant[]; expiry: number | null;
  destinations: readonly string[]; renew: boolean;
};
export type Stored = { reference: string; version: number; at: number; sameAs: readonly string[]; indexed: boolean; renewed: boolean };
export type SecretsProblem = SecretProblem | SealedProblem | "not_repository" | "workspace_taken";
export type SecretsRefusal = { problem: SecretsProblem };

// The file of a version, if it still has one.
const refOf = (vaults: readonly VaultRefRow[], reference: string, version: number) =>
  vaults.find(v => v.reference === reference && v.version === version)?.ref ?? null;

// What `list` shows of a Secret: metadata only.
export type SecretView = {
  reference: string; status: string; version: number | null; storedAt: number | null; expiry: number | null; shape: string | null;
  grants: readonly SecretGrant[]; destinations: readonly string[];
};

export class SecretsService {
  readonly #deps: SecretsDeps;
  constructor(deps: SecretsDeps) { this.#deps = deps; }

  async store(request: StoreRequest, actor: Actor): Promise<Result<Stored, SecretsRefusal>> {
    const { vault, index, secrets, ids, clock } = this.#deps;
    const ref = ids.next("s-");
    const sealed = await vault.storeSealed(ref, request.sealed);
    if (!sealed.ok) return err({ problem: sealed.problem });
    let replaced: string | null = null;
    let retiring: number | null = null;
    let outcome: Result<Stored, SecretsRefusal>;
    try {
      const prepared = await index.prepare(ref);
      const at = clock.now();
      outcome = secrets.write<Result<Stored, SecretsRefusal>>(state => {
        if (!vault.has(ref)) throw new Error(`the vault file ${ref} was swept before its store committed`);
        const before = findSecret(state.directory, request.reference)?.current?.number ?? null;
        const input = {
          reference: request.reference, fingerprint: sealed.fingerprint, shape: request.shape, grants: request.grants,
          expiry: request.expiry, destinations: request.destinations,
        };
        const placed = (request.renew ? renewSecret : storeSecret)(state.directory, input, actor, at);
        if (!placed.ok) return { next: null, result: err({ problem: placed.error.problem }) };
        const version = findSecret(placed.value, request.reference)?.current?.number ?? 0;
        // The store's own event is the first new one; it names the other References that hold the same value.
        const event = placed.value.events[state.directory.events.length];
        const sameAs = event && "sameAs" in event ? event.sameAs : [];
        index.write({ add: { reference: request.reference, version, prepared }, retire: [], at });
        retiring = before;
        replaced = before === null ? null : refOf(state.vaults, request.reference, before);
        const vaults = state.vaults.map(v => v.reference === request.reference && v.version === before ? { ...v, ref: null } : v);
        const next: SecretsState = { ...state, directory: placed.value, vaults: [...vaults, { reference: request.reference, version, ref }] };
        return { next, result: ok({ reference: request.reference, version, at, sameAs, indexed: !prepared.short, renewed: request.renew }) };
      });
    } catch (error) {
      vault.remove(ref);
      throw error;
    }
    if (!outcome.ok) {
      vault.remove(ref);
      return outcome;
    }
    if (retiring !== null) this.#retire(request.reference, retiring);
    if (replaced !== null) vault.remove(replaced);
    return outcome;
  }

  // Grants, Disable and Enable change metadata only; the domain judges widening (SC7).
  grant(reference: string, grant: SecretGrant, actor: Actor): Result<null, SecretsRefusal> {
    return this.#change(dir => grantSecret(dir, reference, grant, actor, this.#deps.clock.now()));
  }

  ungrant(reference: string, subject: GrantSubject, actor: Actor): Result<null, SecretsRefusal> {
    return this.#change(dir => ungrantSecret(dir, reference, subject, actor, this.#deps.clock.now()));
  }

  disable(reference: string, actor: Actor): Result<null, SecretsRefusal> {
    return this.#change(dir => disableSecret(dir, reference, actor, this.#deps.clock.now()));
  }

  enable(reference: string, actor: Actor): Result<null, SecretsRefusal> {
    return this.#change(dir => enableSecret(dir, reference, actor, this.#deps.clock.now()));
  }

  // SC8: Revoke and Delete destroy the current value on this node. Its version is retired in the index (kept 30 days), its
  // file's ref is cleared in the same transaction, and the file is removed after the commit.
  revoke(reference: string, actor: Actor): Result<null, SecretsRefusal> {
    return this.#change(dir => revokeSecret(dir, reference, actor, this.#deps.clock.now()), reference);
  }

  delete(reference: string, actor: Actor): Result<null, SecretsRefusal> {
    return this.#change(dir => deleteSecret(dir, reference, actor, this.#deps.clock.now()), reference);
  }

  list(): SecretView[] {
    return this.#deps.secrets.load().directory.held.map(s => ({
      reference: s.reference, status: s.status, version: s.current?.number ?? null, storedAt: s.current?.storedAt ?? null,
      expiry: s.expiry, shape: s.shape, grants: s.grants, destinations: s.destinations,
    }));
  }

  log(reference: string | null): SecretEvent[] {
    return this.#deps.secrets.load().directory.events.filter(e => reference === null || e.reference === reference);
  }

  // A workspace is the repository a path belongs to, by its git common directory, so every worktree of it is one
  // workspace; a remote counts for nothing (design §6). Registering one widens, so it is the principal's.
  addWorkspace(path: string, actor: Actor): Result<WorkspaceRow, SecretsRefusal> {
    if (actor.kind !== "principal" || !actor.command) return err({ problem: "principal" });
    const root = this.#deps.roots.commonDir(path);
    if (root === null) return err({ problem: "not_repository" });
    const name = workspaceName(root);
    if (name === null) return err({ problem: "not_repository" });
    const at = this.#deps.clock.now();
    return this.#deps.secrets.write<Result<WorkspaceRow, SecretsRefusal>>(state => {
      if (state.workspaces.some(w => w.root === root)) return { next: null, result: err({ problem: "same" }) };
      if (state.workspaces.some(w => w.name === name)) return { next: null, result: err({ problem: "workspace_taken" }) };
      const row: WorkspaceRow = { name, root, at, command: actor.command };
      return { next: { ...state, workspaces: [...state.workspaces, row] }, result: ok(row) };
    });
  }

  workspaces(): readonly WorkspaceRow[] {
    return this.#deps.secrets.load().workspaces;
  }

  // D2: a crash between the vault write and the commit can leave a file no version refers to, and one between a commit
  // and its retirement in the index leaves a version live there. The sweep removes those files and retires every version
  // the ledger no longer holds current (retiring again keeps the first time), inside a write transaction, so no store
  // commits meanwhile; a store checks inside its own transaction that its file is still there.
  sweep(): string[] {
    const { secrets, vault, index, clock } = this.#deps;
    return secrets.write(state => {
      const kept = new Set<string>();
      for (const v of state.vaults) if (v.ref !== null) kept.add(v.ref);
      const gone = vault.refs("s-", clock.now()).filter(ref => !kept.has(ref));
      for (const ref of gone) vault.remove(ref);
      const retire = state.directory.ledger.filter(e => e.state !== "current").map(e => ({ reference: e.reference, version: e.version }));
      if (retire.length > 0) index.write({ add: null, retire, at: clock.now() });
      return { next: null, result: gone };
    });
  }

  // One domain change in one transaction. With `dropping`, the Reference's current version (if any) is retired in the
  // index and its file removed after the commit.
  #change(run: (dir: SecretDirectory) => Result<SecretDirectory, SecretRefusal>, dropping?: string): Result<null, SecretsRefusal> {
    const { secrets, vault } = this.#deps;
    let removed: string | null = null;
    let retiring: number | null = null;
    const result = secrets.write<Result<null, SecretsRefusal>>(state => {
      const r = run(state.directory);
      if (!r.ok) return { next: null, result: err({ problem: r.error.problem }) };
      let vaults = state.vaults;
      const version = dropping === undefined ? null : findSecret(state.directory, dropping)?.current?.number ?? null;
      if (dropping !== undefined && version !== null) {
        retiring = version;
        removed = refOf(vaults, dropping, version);
        vaults = vaults.map(v => v.reference === dropping && v.version === version ? { ...v, ref: null } : v);
      }
      return { next: { ...state, directory: r.value, vaults }, result: ok(null) };
    });
    if (result.ok && dropping !== undefined && retiring !== null) this.#retire(dropping, retiring);
    if (result.ok && removed !== null) vault.remove(removed);
    return result;
  }

  // A version leaves the index's live set only after the commit that retired it, in a write transaction of its own, which
  // keeps index writes one at a time. A rolled-back change thus never retires a live version; a crash between the commit
  // and this write leaves it live, filtering more, until the next sweep retires it.
  #retire(reference: string, version: number): void {
    const { secrets, index, clock } = this.#deps;
    secrets.write(() => {
      index.write({ add: null, retire: [{ reference, version }], at: clock.now() });
      return { next: null, result: null };
    });
  }
}

// The workspace's name: the repository directory's own name (the parent of a `.git` common dir), in the domain's
// grammar, or null when nothing of it fits.
function workspaceName(commonDir: string): string | null {
  const parts = commonDir.split("/").filter(p => p !== "");
  const last = parts.at(-1);
  const dir = last === ".git" ? parts.at(-2) : last?.replace(/\.git$/, "");
  const name = (dir ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);
  return WORKSPACE_NAME.test(name) ? name : null;
}
