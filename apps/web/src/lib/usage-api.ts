// The principal's own usage commands (plan 4.4, S4): forget a source, clear a seat mark. Same-origin JSON like api.ts
// (cookies are HttpOnly; the browser sends them), the hub's own routes; each answer is `ok`, or a problem in plain
// words the card shows. Not a Command on the board: the hub answers at once.
export type UsageCommandResult = { ok: true } | { ok: false; problem: string };

// POST /api/usage/forget: the account, and the source (and node) to drop.
export async function forgetSource(account: string, source: string, node: string | null): Promise<UsageCommandResult> {
  throw new Error("not implemented");               // S4 round 2
}

// POST /api/usage/seat/clear: the account, and whose seat (without an owner, both).
export async function clearSeat(account: string, owner?: "pool" | "derived"): Promise<UsageCommandResult> {
  throw new Error("not implemented");               // S4 round 2
}
