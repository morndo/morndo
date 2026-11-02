import type { AccountRow } from "@morndo/protocol";

/** Claude folders on one node that share an email (case-insensitive): each name maps to the other folder names. */
export function sharedEmails(rows: readonly Pick<AccountRow, "name" | "email">[]): Map<string, string[]> {
  const byEmail = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.email) continue;
    const key = row.email.toLowerCase();
    const list = byEmail.get(key) ?? [];
    list.push(row.name);
    byEmail.set(key, list);
  }
  const out = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.email) continue;
    const names = byEmail.get(row.email.toLowerCase());
    if (!names || names.length < 2) continue;
    const others = names.filter(n => n !== row.name);
    if (others.length) out.set(row.name, others);
  }
  return out;
}

export function sameEmailLine(otherNames: readonly string[]): string {
  return `Same email as ${otherNames.join(", ")}`;
}

/** After a Claude sign-in: the other folders already on the email it used, as the sheet says it, or null if none. */
export function addsNoCapacityLine(email: string, account: string, rows: readonly Pick<AccountRow, "name" | "email">[]): string | null {
  const key = email.toLowerCase();
  const others = rows.filter(r => r.name !== account && r.email?.toLowerCase() === key).map(r => r.name);
  return others.length ? `${sameEmailLine(others)}: this folder adds no capacity.` : null;
}
