// The SecretsDirectory port's save rules, on the fake the service tests use and on SQLite, so the two can't drift apart
// (round 2 of PR #40, point 6). References and fingerprints are synthetic.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { storeSecret, type Actor, type SecretDirectory, type SecretGrant } from "@morndo/domain";
import { SqliteSecrets } from "../src/adapters/secrets-sqlite.ts";
import { MemorySecrets } from "../src/application/fakes.ts";
import type { SecretsDirectory, SecretsState, VaultRefRow } from "../src/application/ports.ts";

const REF = "secret://example-app/payments-test";
const OTHER = "secret://example-app/other-token";
const T = 1_700_000_000_000;
const principal: Actor = { kind: "principal", command: "c1" };
const nodeGrant: SecretGrant = { subject: { kind: "node" }, modes: ["exec"], until: { kind: "open" } };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const adapters: { name: string; make(): SecretsDirectory & { close?(): void } }[] = [
  { name: "MemorySecrets (the fake)", make: () => new MemorySecrets() },
  {
    name: "SqliteSecrets",
    make: () => {
      const root = mkdtempSync(join(tmpdir(), "morndo-secrets-contract-"));
      dirs.push(root);
      return new SqliteSecrets(join(root, "connections", "connections.db"));
    },
  },
];

function stored(dir: SecretDirectory, reference: string, fingerprint: string): SecretDirectory {
  const r = storeSecret(dir, { reference, fingerprint, shape: null, grants: [nodeGrant], expiry: null, destinations: [] }, principal, T);
  if (!r.ok) throw new Error(r.error.problem);
  return r.value;
}
const save = (s: SecretsDirectory, next: (state: SecretsState) => SecretsState) => s.write(state => ({ next: next(state), result: null }));
const refs = (s: SecretsDirectory): VaultRefRow[] => [...s.load().vaults];

describe.each(adapters)("SecretsDirectory save rules: $name", adapter => {
  it("a vault row the change leaves out keeps its stored ref; a new entry it names none for has none", () => {
    const s = adapter.make();
    try {
      save(s, state => ({ ...state, directory: stored(state.directory, REF, "aaaaaaaaaaaa"), vaults: [{ reference: REF, version: 1, ref: "s-0001" }] }));
      save(s, state => ({ ...state, directory: stored(state.directory, OTHER, "bbbbbbbbbbbb"), vaults: [] }));
      expect(refs(s)).toEqual([{ reference: REF, version: 1, ref: "s-0001" }, { reference: OTHER, version: 1, ref: null }]);
    } finally {
      s.close?.();
    }
  });
  it("a row the change names sets the ref, and naming it with none clears it", () => {
    const s = adapter.make();
    try {
      save(s, state => ({ ...state, directory: stored(state.directory, REF, "aaaaaaaaaaaa"), vaults: [{ reference: REF, version: 1, ref: "s-0001" }] }));
      save(s, state => ({ ...state, directory: stored(state.directory, OTHER, "bbbbbbbbbbbb"), vaults: [{ reference: OTHER, version: 1, ref: "s-0002" }] }));
      save(s, state => ({ ...state, vaults: [{ reference: REF, version: 1, ref: null }] }));
      expect(refs(s)).toEqual([{ reference: REF, version: 1, ref: null }, { reference: OTHER, version: 1, ref: "s-0002" }]);
    } finally {
      s.close?.();
    }
  });
  it("a row that names no ledger entry, or one entry twice, is refused, and nothing is saved", () => {
    const s = adapter.make();
    try {
      save(s, state => ({ ...state, directory: stored(state.directory, REF, "aaaaaaaaaaaa"), vaults: [{ reference: REF, version: 1, ref: "s-0001" }] }));
      expect(() => save(s, state => ({ ...state, vaults: [{ reference: OTHER, version: 1, ref: "s-0009" }] }))).toThrow(/names no ledger entry/);
      expect(() => save(s, state => ({ ...state, vaults: [{ reference: REF, version: 1, ref: null }, { reference: REF, version: 1, ref: "s-0009" }] })))
        .toThrow(/names no ledger entry, or names one twice/);
      expect(refs(s)).toEqual([{ reference: REF, version: 1, ref: "s-0001" }]);
    } finally {
      s.close?.();
    }
  });
});
