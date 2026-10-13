// The save rule for vault refs (the SecretsDirectory port, review 9 and round 2, point 6), as one pure function that
// both stores use, SQLite and the service tests' fake, so the two can't drift apart (round 3, point 8).
import type { SecretsState, VaultRefRow } from "./ports.ts";

const key = (reference: string, version: number) => JSON.stringify([reference, version]);

// One row per ledger entry of `next`, in its order: a row `next.vaults` names sets the ref, null clearing it; an entry it
// leaves out keeps the ref `before` holds for it, and a new one has none. A row that names no ledger entry, or one
// entry twice, is refused.
export function savedVaultRefs(before: SecretsState, next: SecretsState): VaultRefRow[] {
  const known = new Set(next.directory.ledger.map(e => key(e.reference, e.version)));
  const named = new Map<string, string | null>();
  for (const v of next.vaults) {
    const k = key(v.reference, v.version);
    if (!known.has(k) || named.has(k)) throw new Error(`the vault ref for ${v.reference} version ${v.version} names no ledger entry, or names one twice`);
    named.set(k, v.ref);
  }
  const stored = new Map(before.vaults.map(v => [key(v.reference, v.version), v.ref]));
  return next.directory.ledger.map(e => {
    const k = key(e.reference, e.version);
    return { reference: e.reference, version: e.version, ref: named.has(k) ? named.get(k) ?? null : stored.get(k) ?? null };
  });
}
