import type { AccountRow } from "@morndo/protocol";

type Who = Pick<AccountRow, "email" | "plan">;

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** One email can hold two subscriptions (a personal Max plan and a Team seat), so two folders are the same account only
 *  when the email matches and their plans are not known to differ. A folder with no plan (signed out) may be either. */
function sameAccount(a: Who, b: Who): boolean {
  if (!same(a.email, b.email)) return false;
  return !a.plan || !b.plan || same(a.plan, b.plan);
}

/** Claude folders on one node that are the same account by sameAccount: each name maps to the other folder names. */
export function sharedEmails(rows: readonly Pick<AccountRow, "name" | "email" | "plan">[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const others = rows.filter(r => r.name !== row.name && sameAccount(row, r)).map(r => r.name);
    if (others.length) out.set(row.name, others);
  }
  return out;
}

export function sameEmailLine(otherNames: readonly string[]): string {
  return `Same email as ${otherNames.join(", ")}`;
}

/** After a Claude sign-in: the other signed-in folders on the same email and plan, as the sheet says it, or null.
 *  A signed-out folder holds none of the account's capacity, and a sign-in that did not say its plan claims nothing. */
export function addsNoCapacityLine(
  identity: Who, account: string, rows: readonly Pick<AccountRow, "name" | "email" | "plan" | "signedIn">[],
): string | null {
  if (!identity.plan) return null;
  const others = rows
    .filter(r => r.name !== account && r.signedIn === "ok" && same(r.email, identity.email) && same(r.plan, identity.plan))
    .map(r => r.name);
  return others.length ? `${sameEmailLine(others)}: this folder adds no capacity.` : null;
}
