// `morndo audit [count]`: the arguments, read before the hub's settings and database are (T-423). A flag or a word used to
// reach the SQL `LIMIT ?` as NaN ("SqliteError: datatype mismatch"); now `--help` is the usage and anything else that is
// not a whole number of at least 1 is one sentence.
export const AUDIT_SYNOPSIS = "usage: morndo audit [count]";
export const AUDIT_USAGE = `${AUDIT_SYNOPSIS}\nthe latest <count> device and session events, oldest first (default 30)`;

export type AuditArgs =
  | { kind: "list"; limit: number }
  | { kind: "help" }
  | { kind: "refused"; why: string };

export function parseAuditArgs(args: string[]): AuditArgs {
  if (args.some(a => a === "--help" || a === "-h")) return { kind: "help" };
  if (args.length > 1) return { kind: "refused", why: `expected at most one count, got ${args.length} arguments.` };
  if (args.length === 0) return { kind: "list", limit: 30 };
  const count = args[0]!;
  if (!/^[0-9]+$/.test(count) || !Number.isSafeInteger(Number(count)) || Number(count) < 1) {
    return { kind: "refused", why: `"${count}" is not a count; give a whole number of at least 1.` };
  }
  return { kind: "list", limit: Number(count) };
}
