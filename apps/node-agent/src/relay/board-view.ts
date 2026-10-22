// The hub's board view for the not-live rule (T-308, digest-check.ts): the tasks whose merges the board records and
// does not have live, read from /api/agent/board as the agents' CLI reads it — never from a forge. Any way the hub
// fails to answer gives null, so the rule is skipped.
import { isMorndoRepo } from "@morndo/domain";
import { MergedViewSchema } from "@morndo/protocol";
import type { NotLiveTask } from "./digest-check.ts";

// AbortSignal.timeout bounds a hub that never answers (Node.js fetch, node:globals), as a job grant is bounded
// (job-grant.ts). Three seconds is enough for a board and short enough not to hold a Stop.
// https://nodejs.org/docs/latest-v24.x/api/globals.html#abortsignaltimeoutms read 2026-10-22.
export const BOARD_VIEW_TIMEOUT_MS = 3_000;

// The tasks whose merge is recorded and not live: each `merged` entry of the board's answer is parsed one by one
// (MergedViewSchema), one that doesn't parse dropped, as the app drops it; a `live` of true or null says nothing
// either way. The shas are those of the morndo/morndo merges only: that is the repo the digest's work lands in.
export async function notLiveFromHub(o: { hub: string; token: string; lane: string; timeoutMs?: number; fetch?: typeof fetch }): Promise<NotLiveTask[] | null> {
  const doFetch = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(new URL("/api/agent/board", o.hub), {
      headers: { authorization: `Bearer ${o.token}`, "x-morndo-lane": o.lane },
      signal: AbortSignal.timeout(o.timeoutMs ?? BOARD_VIEW_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: unknown;
  try { body = await res.json(); } catch { return null; }
  const merged = (body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).merged : undefined);
  if (!Array.isArray(merged)) return null;
  const out: NotLiveTask[] = [];
  for (const entry of merged) {
    const parsed = MergedViewSchema.safeParse(entry);
    if (!parsed.success || parsed.data.live !== false) continue;
    out.push({ key: parsed.data.key, shas: parsed.data.merges.filter(m => isMorndoRepo(m.repo)).map(m => m.sha) });
  }
  return out;
}
