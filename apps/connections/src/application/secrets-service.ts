// The Secrets service on a node (ADR-0022; design §6, §14). A store writes the sealed value under a fresh vault ref, then
// runs the domain's check, writes the index and saves, all in one transaction of the SecretsDirectory (SC2, SC6), and
// removes the replaced version's file only after the commit (D2, decided on T-85). A refusal or a failure removes the new
// file; entries written before a rolled-back commit can only filter more, never less. No value passes through here: the
// vault answers with a keyed fingerprint, the index with keyed hashes.
import {
  err, findSecret, ok, renewSecret, storeSecret, type Actor, type GrantSubject, type Result, type SecretEvent, type SecretGrant,
  type SecretProblem, type ShapeInput,
} from "@morndo/domain";
import type {
  Clock, Ids, IndexWriter, SealedProblem, SealedStore, SecretsDirectory, SecretsState, VaultRefRow, WorkspaceRoots, WorkspaceRow,
} from "./ports.ts";

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
    let outcome: Result<Stored, SecretsRefusal>;
    try {
      const prepared = await index.prepare(ref);
      const at = clock.now();
      outcome = secrets.write<Result<Stored, SecretsRefusal>>(state => {
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
        index.write({
          add: { reference: request.reference, version, prepared },
          retire: before === null ? [] : [{ reference: request.reference, version: before }],
          at,
        });
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
    if (replaced !== null) vault.remove(replaced);
    return outcome;
  }

  grant(_reference: string, _grant: SecretGrant, _actor: Actor): Result<null, SecretsRefusal> { return err({ problem: "missing" }); }
  ungrant(_reference: string, _subject: GrantSubject, _actor: Actor): Result<null, SecretsRefusal> { return err({ problem: "missing" }); }
  disable(_reference: string, _actor: Actor): Result<null, SecretsRefusal> { return err({ problem: "missing" }); }
  enable(_reference: string, _actor: Actor): Result<null, SecretsRefusal> { return err({ problem: "missing" }); }
  revoke(_reference: string, _actor: Actor): Result<null, SecretsRefusal> { return err({ problem: "missing" }); }
  delete(_reference: string, _actor: Actor): Result<null, SecretsRefusal> { return err({ problem: "missing" }); }
  list(): SecretView[] { return []; }
  log(_reference: string | null): SecretEvent[] { return []; }
  addWorkspace(_path: string, _actor: Actor): Result<WorkspaceRow, SecretsRefusal> { return err({ problem: "missing" }); }
  workspaces(): readonly WorkspaceRow[] { return []; }
  sweep(): string[] { return []; }
}
