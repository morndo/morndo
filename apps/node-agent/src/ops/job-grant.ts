// The lane's token hash (ADR-0017, decision 7). The node asks the hub itself. The cache stores the hash the hub
// returned for the token this process sent, never a hash the caller declared. A live answer wins, and a refusal
// clears the row, so the next time the hub is unreachable that token does not start a job. The table has no column
// for the token.
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { tokenAllows, type NotifyTarget, type TokenCache } from "@morndo/domain";

export type HubVerdict =
  | { kind: "allowed"; lane: string; hash: string }
  | { kind: "refused"; code: string }
  | { kind: "denied"; code: string }
  | { kind: "unavailable" };

// A token refusal is 401 or 403 carrying one of these. `not_yours` is a lane mismatch: the token stays cached for
// the lanes the hub already bound it to.
const TOKEN_REFUSAL = new Set(["no_token", "unknown_token", "revoked"]);

export type HubGrantRequest = {
  lane: string;
  id: string;
  jobClass: string;
  notify: NotifyTarget;
  cwdHash: string;
};

// AbortSignal.timeout bounds a hub that never answers (Node.js fetch, node:globals). Five seconds is enough for a
// grant and short enough that an offline start does not sit on the default connect timeout.
// https://nodejs.org/docs/latest-v24.x/api/globals.html#abortsignaltimeoutms read 2026-10-10.
export const HUB_GRANT_TIMEOUT_MS = 5_000;

// What this process saw the hub answer. A thrown fetch (including the timeout) or a 5xx is unavailable, so the
// cache is left for the offline rule. A 4xx is the hub's answer and is not.
export async function askHub(base: string, token: string, req: HubGrantRequest, timeoutMs = HUB_GRANT_TIMEOUT_MS): Promise<HubVerdict> {
  let res: Response;
  try {
    res = await fetch(new URL("/api/agent/jobs/grant", base), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-morndo-lane": req.lane,
      },
      body: JSON.stringify({ lane: req.lane, id: req.id, jobClass: req.jobClass, notify: req.notify, cwdHash: req.cwdHash }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "unavailable" };
  }
  let body: { ok?: boolean; lane?: string; hash?: string; error?: string };
  try { body = await res.json() as { ok?: boolean; lane?: string; hash?: string; error?: string }; }
  catch { return res.status >= 500 ? { kind: "unavailable" } : { kind: "denied", code: "bad_response" }; }
  if (res.ok && body.ok && body.lane && body.hash) return { kind: "allowed", lane: body.lane, hash: body.hash };
  if (res.status === 401 || res.status === 403) {
    if (typeof body.error === "string" && TOKEN_REFUSAL.has(body.error)) return { kind: "refused", code: body.error };
    return { kind: "denied", code: typeof body.error === "string" ? body.error : "refused" };
  }
  if (res.status >= 400 && res.status < 500) return { kind: "denied", code: typeof body.error === "string" ? body.error : "refused" };
  if (res.status >= 500) return { kind: "unavailable" };
  return { kind: "denied", code: typeof body.error === "string" ? body.error : "refused" };
}

export type GrantKind = "allowed" | "refused" | "offline";

export class JobGrants {
  #db: Database.Database;
  #now: () => number;

  constructor(db: Database.Database, now: () => number) {
    this.#db = db;
    this.#now = now;
  }

  remember(lane: string, hash: string, at = this.#now()): void {
    this.#db.prepare(`INSERT INTO token_cache (lane, hash, checked_at) VALUES (?, ?, ?)
      ON CONFLICT (lane) DO UPDATE SET hash = excluded.hash, checked_at = excluded.checked_at`).run(lane, hash, at);
  }

  // The lane the hub last bound to this token. The caller's lane name is not consulted.
  laneOf(token: string): string | null {
    const hash = createHash("sha256").update(token).digest("hex");
    const row = this.#db.prepare("SELECT lane FROM token_cache WHERE hash = ? ORDER BY checked_at DESC LIMIT 1").get(hash) as { lane: string } | undefined;
    return row?.lane ?? null;
  }

  // `allowed` stores the hub's hash only when it is the hash of the token we sent and the lane we asked about.
  admit(lane: string, token: string, verdict: HubVerdict): "ok" | "hub" | "no_cache" {
    const hash = createHash("sha256").update(token).digest("hex");
    if (verdict.kind === "allowed") {
      if (verdict.lane !== lane || verdict.hash !== hash) return "hub";
      this.remember(lane, hash);
      return "ok";
    }
    if (verdict.kind === "refused") {
      this.decide(lane, hash, "refused");
      return "hub";
    }
    if (verdict.kind === "denied") return "hub";
    return this.decide(lane, hash, "offline") ? "ok" : "no_cache";
  }

  decide(lane: string, hash: string, kind: GrantKind): boolean {
    if (kind === "refused") {
      this.#db.prepare("DELETE FROM token_cache WHERE hash = ?").run(hash);
      return false;
    }
    if (kind === "allowed") {
      this.remember(lane, hash);
      return true;
    }
    const cache = this.#get(lane);
    return tokenAllows({ reachable: false, lane, hash, cache, now: this.#now() });
  }

  #get(lane: string): TokenCache | null {
    const row = this.#db.prepare("SELECT lane, hash, checked_at FROM token_cache WHERE lane = ?").get(lane) as
      { lane: string; hash: string; checked_at: number } | undefined;
    return row ? { lane: row.lane, hash: row.hash, checkedAt: row.checked_at } : null;
  }
}
