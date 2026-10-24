// Which account a lane's failure belongs to (plan 4.5 item 4): the hook's own word first, then the lane's last record,
// then the session, then the node's only account — and a failure that resolves to nothing changes no seat (U9). Also
// which failures are limits at all (U9): a closed list of error words, trimmed and lowercased; everything else — an
// overloaded turn, an unknown word, no word — is no limit.
import { ACCOUNT_NAME } from "./usage.ts";
import type { LimitKind } from "./usage-seatbook.ts";

export type LaneRecord = { node: string; lane: string; account: string; at: number };
export type FreshSession = { account: string; sessionId: string; lane: string | null };
export type ResolveInput = { hookAccount: unknown; node: string; lane: string | null; sessionId: string | null; now: number; records: readonly LaneRecord[]; sessions: readonly FreshSession[]; laneNode: (lane: string) => string | null };
export type Resolved = { account: string | null; by: "hook" | "record" | "session" | "node" | null };
// A lane's record serves its failures for seven days: a lane moves between accounts, and an older word is worth nothing.
export const RECORD_FRESH_MS = 7 * 86_400_000;

export function resolveAccount(i: ResolveInput): Resolved {
  // Round 2: the hook's own word (a string that fits ACCOUNT_NAME), else a record for the lane no older than
  // RECORD_FRESH_MS (one whose node equals this node first, else one of node ""), else the fresh session of the
  // session id, else the node's only account (its records' and its fresh sessions' accounts, through laneNode) —
  // two accounts or none: { account: null, by: null }.
  void i; void ACCOUNT_NAME;
  throw new Error("not implemented");
}

export function limitKindOfError(error: string): LimitKind | null {
  // Round 2: trimmed and lowercased — "rate_limit" a usage limit, "billing_error" billing, "authentication_failed" a
  // sign-out, "account_on_hold" and "oauth_org_not_allowed" a refusal; anything else, "overloaded" and "" among them, null.
  void error;
  throw new Error("not implemented");
}
