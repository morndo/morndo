// The Secrets service on a node (ADR-0022; design §6, §14). Not built yet.
import type { Actor, Result, SecretGrant, SecretProblem, ShapeInput } from "@morndo/domain";
import { err } from "@morndo/domain";
import type { Clock, Ids, IndexWriter, SealedProblem, SealedStore, SecretsDirectory, WorkspaceRoots } from "./ports.ts";

export type SecretsDeps = { clock: Clock; ids: Ids; vault: SealedStore; index: IndexWriter; secrets: SecretsDirectory; roots: WorkspaceRoots };
export type StoreRequest = {
  reference: string; sealed: Uint8Array; shape: ShapeInput; grants: readonly SecretGrant[]; expiry: number | null;
  destinations: readonly string[]; renew: boolean;
};
export type Stored = { reference: string; version: number; at: number; sameAs: readonly string[]; indexed: boolean; renewed: boolean };
export type SecretsProblem = SecretProblem | SealedProblem | "not_repository" | "workspace_taken";
export type SecretsRefusal = { problem: SecretsProblem };

export class SecretsService {
  readonly #deps: SecretsDeps;
  constructor(deps: SecretsDeps) { this.#deps = deps; }

  async store(_request: StoreRequest, _actor: Actor): Promise<Result<Stored, SecretsRefusal>> {
    void this.#deps;
    return err({ problem: "missing" });
  }
}
