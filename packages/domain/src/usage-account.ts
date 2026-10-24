// Which account a lane's failure belongs to (plan 4.5 item 4): the hook's own word first, then the lane's last record,
// then the session, then the node's only account — and a failure that resolves to nothing changes no seat (U9). Also
// which failures are limits at all (U9): a closed list of error words, trimmed and lowercased; everything else — an
// overloaded turn, an unknown word, no word — is no limit.
import { ACCOUNT_NAME } from "./usage.ts";
import type { LimitKind } from "./usage-seatbook.ts";

// `source` says how the record was written (fix round on PR #127, finding 4b): "start" by a lane_account tap, "report"
// by a status-line report. Absent on every row written before the column existed; a start record outranks a report one.
export type LaneRecord = { node: string; lane: string; account: string; at: number; source?: "start" | "report" };
export type FreshSession = { account: string; sessionId: string; lane: string | null };
export type ResolveInput = { hookAccount: unknown; node: string; lane: string | null; sessionId: string | null; now: number; records: readonly LaneRecord[]; sessions: readonly FreshSession[]; laneNode: (lane: string) => string | null };
export type Resolved = { account: string | null; by: "hook" | "record" | "session" | "node" | null };
// A lane's record serves its failures for seven days: a lane moves between accounts, and an older word is worth nothing.
export const RECORD_FRESH_MS = 7 * 86_400_000;
// A start record's hold (PR #127, finding 4b): a status-line report of the same (node, lane) never replaces a start
// record younger than this, so a lane started with an account keeps that account against a self-declared header.
export const START_RECORD_HOLD_MS = 12 * 3_600_000;

// Which of two records of one lane speaks for it: a start record outranks a report one (finding 4b), and two of a kind
// go by the newest stamp. A row from before the source column counts as a report.
const speaksForLane = (a: LaneRecord, b: LaneRecord): boolean =>
  (a.source === "start") !== (b.source === "start") ? a.source === "start" : a.at > b.at;

export function resolveAccount(i: ResolveInput): Resolved {
  // The hook's own word: the lane's lane, whatever any record or session says.
  if (typeof i.hookAccount === "string" && ACCOUNT_NAME.test(i.hookAccount)) return { account: i.hookAccount, by: "hook" };
  // The lane's record: this node's own before one of node "" (the hub could not place the lane), a start record before a
  // report one, then the newest at among them (PR #127, finding 4b).
  if (i.lane !== null) {
    const fresh = i.records.filter(r => r.lane === i.lane && i.now - r.at <= RECORD_FRESH_MS);
    const placed = fresh.filter(r => r.node === i.node);
    const mine = placed.length > 0 ? placed : fresh.filter(r => r.node === "");
    if (mine.length > 0) {
      let newest = mine[0]!;
      for (const r of mine) if (speaksForLane(r, newest)) newest = r;
      return { account: newest.account, by: "record" };
    }
  }
  // The session of the session id, when one is fresh.
  if (i.sessionId !== null) {
    const s = i.sessions.find(x => x.sessionId === i.sessionId);
    if (s !== undefined) return { account: s.account, by: "session" };
  }
  // The node's only account: its fresh records' and its fresh sessions' (through laneNode). A node of "" is never the node.
  if (i.node !== "") {
    const accounts = new Set<string>();
    for (const r of i.records) if (r.node === i.node && i.now - r.at <= RECORD_FRESH_MS) accounts.add(r.account);
    for (const s of i.sessions) if (s.lane !== null && i.laneNode(s.lane) === i.node) accounts.add(s.account);
    if (accounts.size === 1) return { account: accounts.values().next().value as string, by: "node" };
  }
  return { account: null, by: null };
}

export function limitKindOfError(error: string): LimitKind | null {
  const word = error.trim().toLowerCase();
  if (word === "rate_limit") return "usage_limit";
  if (word === "billing_error") return "billing";
  if (word === "authentication_failed") return "signed_out";
  if (word === "account_on_hold" || word === "oauth_org_not_allowed") return "refused";
  return null;
}
