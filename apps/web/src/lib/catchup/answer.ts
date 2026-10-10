// The phone's answer to a Decision (ADR-0009; E8 to E12): one POST through the existing path, with what makes a held
// answer safe (review of PR #7, findings 5 and 6). It carries the version of the Ask it was given for and one request
// id for every attempt, so "Try again" after a lost reply is typed at most once (the hub keeps the id 10 minutes). It
// gives up after ANSWER_TIMEOUT_MS instead of holding the run, and goes as keepalive, so one sent as the page closes
// still arrives. No answer of the hub's own is an unknown outcome, never "nothing was answered".
import { api, ApiError, explain } from "../api.ts";
import { REFUSALS } from "../desktop/decisions.ts";
import type { Body } from "./run.ts";

export const ANSWER_TIMEOUT_MS = 15_000;
// The hub's answer to a Decision: taken, or refused with its code and the words for it. One definition for catch-up and
// Today's task rows (code review #15).
export type AnswerOutcome = { ok: true } | { ok: false; code: string; text: string };
// Outcomes after which the answer may have reached the asker: nobody heard back ("unknown"), the hub was still typing
// an earlier attempt of it ("in_progress", a stalled request that arrived after all), or the hub says the asker's
// machine may have typed it ("uncertain", its 409: fleet core §3.1, §7). The board settles them, and sending the same
// request id again (Try again, Check again) asks the hub, which never types it twice.
export const MAY_HAVE_GONE: ReadonlySet<string> = new Set(["unknown", "in_progress", "uncertain"]);
// The button that sends the same request id again, by what the hub said: "Check again" where it said it may have been
// typed, as for a message in the outbox; "Try again" where nobody heard back.
export const againLabel = (code: string) => (code === "uncertain" ? "Check again" : "Try again");
// After Check again on an answer in doubt (fleet core §3.1, §7; S7 for an answer), only the hub's own refusal of an
// answer it judged anew, once the asker's machine said it never had it, ends the doubt: nothing was typed. Anything else
// leaves it in doubt: no answer, the hub still typing it or unable to say, a refusal after the paste (not_submitted),
// what the hub checks before it asks that machine (step_up, rate_limited), a 5xx, a passkey prompt dismissed here, or
// a code this app has no words for.
const STILL_IN_DOUBT: ReadonlySet<string> = new Set([...MAY_HAVE_GONE, "not_submitted"]);
export const endsDoubt = (code: string): boolean => Object.hasOwn(REFUSALS, code) && !STILL_IN_DOUBT.has(code);
// The hub's own code for a refused answer, in the app's terms: its 404 "unknown" (no such decision on its list, as after
// a restart before its first look) is "gone", so it never reads as the app's own "unknown" (no answer came: it may have
// gone, Try again). Nothing was typed for it.
export const hubRefusal = (e: ApiError): string => (e.status === 404 && e.code === "unknown" ? "gone" : e.code);
type Post = (path: string, body: unknown, signal?: AbortSignal) => Promise<unknown>;
const viaApi: Post = (path, body, signal) => api.post(path, body, signal, { keepalive: true });

export const UNKNOWN = "Not sure it went: the hub didn't answer. If it arrived, this card says so; Try again sends the same answer, and it is typed at most once.";

export async function postAnswer(id: string, body: Body, seen: string, requestId: string, post: Post = viaApi, timeoutMs = ANSWER_TIMEOUT_MS): Promise<AnswerOutcome> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    await post(`/api/escalations/${encodeURIComponent(id)}/answer`, { ...body, requestId, ...(seen ? { seen } : {}) }, abort.signal);
    return { ok: true };
  } catch (e) {
    // The hub's own word (a code it chose) is a refusal; a proxy's page, a reset, a timeout: nobody knows.
    if (e instanceof ApiError && e.code !== `http_${e.status}`) {
      const code = hubRefusal(e);
      return { ok: false, code, text: code === "step_up" ? "Not sent: confirm with your passkey, then it goes." : REFUSALS[code] ?? explain(e) };
    }
    return { ok: false, code: "unknown", text: UNKNOWN };
  } finally {
    clearTimeout(timer);
  }
}
