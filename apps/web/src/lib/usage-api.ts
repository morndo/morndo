// The principal's own usage commands (plan 4.4, S4): forget a source, clear a seat mark. Same-origin JSON like api.ts
// (cookies are HttpOnly; the browser sends them), the hub's own routes; each answer is `ok`, or a problem in plain
// words the card shows. Not a Command on the board: the hub answers at once.
import { api, explain } from "./api.ts";
import { withStepUp } from "./stepup.ts";

export type UsageCommandResult = { ok: true } | { ok: false; problem: string };

// One command, run like every principal command: the hub's error codes as words, a step-up asked for once if the hub
// wants one, and a network that never rejects into the card.
async function command(path: string, body: unknown): Promise<UsageCommandResult> {
  try {
    await withStepUp(() => api.post(path, body), () => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, problem: explain(e) };
  }
}

// POST /api/usage/forget: the account, and the source (and node) to drop.
export async function forgetSource(account: string, source: string, node: string | null): Promise<UsageCommandResult> {
  return command("/api/usage/forget", { account, source, node });
}

// POST /api/usage/seat/clear: the account, and whose seat (without an owner, both).
export async function clearSeat(account: string, owner?: "pool" | "derived"): Promise<UsageCommandResult> {
  return command("/api/usage/seat/clear", owner === undefined ? { account } : { account, owner });
}
