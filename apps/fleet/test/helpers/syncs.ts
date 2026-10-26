// Every change of a fleet.db connection's synchronous setting, in order (spec §6: what is synced runs its own
// transaction under FULL, between a "synchronous = FULL" and a "synchronous = NORMAL").
import type Database from "better-sqlite3";

export const FULL_THEN_NORMAL = ["synchronous = FULL", "synchronous = NORMAL"];

export function watchSyncs(db: Database.Database): string[] {
  const seen: string[] = [];
  const pragma = db.pragma.bind(db);
  db.pragma = ((source: string, options?: { simple?: boolean }) => {
    if (/^synchronous\s*=/.test(source)) seen.push(source);
    return pragma(source, options as never);
  }) as typeof db.pragma;
  return seen;
}
