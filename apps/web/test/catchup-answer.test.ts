// The phone's answer POST (review of PR #7, finding 6): it gives up after its time instead of locking the run, it tells
// a refusal from an unknown outcome (no answer of the hub's own: it may have been typed), and a pending answer the page
// closed on is reported, not dropped.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Card } from "@morndo/domain";
import { ApiError } from "../src/lib/api.ts";
import { ANSWER_TIMEOUT_MS, endsDoubt, postAnswer } from "../src/lib/catchup/answer.ts";
import { REFUSALS } from "../src/lib/desktop/decisions.ts";
import { newRun, parseRun, startAnswer } from "../src/lib/catchup/run.ts";

afterEach(() => vi.useRealTimers());
const dec = (id: string): Card => ({ kind: "decision", key: `d:${id}`, id, blocking: false, due: null, askedAt: 1 });

describe("postAnswer", () => {
  it("a POST that never comes back is given up after its time, as an unknown outcome", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const hang = (_p: string, _b: unknown, signal?: AbortSignal) => new Promise<never>((_, reject) => {
      signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); });
    });
    const p = postAnswer("ny-7", { key: "ship" }, "v1", "req-1", hang);
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS);
    expect(await p).toMatchObject({ ok: false, code: "unknown" });
    expect(aborted).toBe(true);
  });
  it("sends the request id and the version it is given; the hub's own refusal is a refusal, not unknown", async () => {
    const seen: unknown[] = [];
    const ok = await postAnswer("ny-7", { key: "ship" }, "v1", "req-1", async (path, body) => { seen.push(path, body); return {}; });
    expect(ok).toEqual({ ok: true });
    expect(seen).toEqual(["/api/escalations/ny-7/answer", { key: "ship", requestId: "req-1", seen: "v1" }]);
    const refused = await postAnswer("ny-7", { key: "ship" }, "v1", "req-2", async () => { throw new ApiError(409, "already_answered"); });
    expect(refused).toMatchObject({ ok: false, code: "already_answered" });
    const lost = await postAnswer("ny-7", { key: "ship" }, "v1", "req-3", async () => { throw new TypeError("Failed to fetch"); });
    expect(lost).toMatchObject({ ok: false, code: "unknown" });
    expect((lost as { text: string }).text).not.toMatch(/Nothing was answered/);
  });
});

describe("a pending answer the page closed on", () => {
  it("is read back as lost (with what is needed to send it again), not dropped without a word", () => {
    const r = startAnswer(newRun([dec("a")], 1000), "d:a", "a", { key: "x" }, "X", 1000, "v1", "req-9");
    const back = parseRun(JSON.parse(JSON.stringify(r)));
    expect(back?.answering).toBeNull();
    expect(back?.lost).toMatchObject({ key: "d:a", id: "a", label: "X", requestId: "req-9", sending: false });
  });
});

// V7: what ends an answer's doubt after Check again: only a 200 or the hub's refusal of an answer it judged anew.
describe("endsDoubt", () => {
  it("keeps the doubt on no answer, the hub's in-doubt words, a refusal after the paste, step_up, 429, 5xx and a dismissed passkey prompt", () => {
    for (const code of ["unknown", "in_progress", "uncertain", "not_submitted", "step_up", "rate_limited", "internal error", "error", "http_502", "a_code_without_words"]) {
      expect([code, endsDoubt(code)]).toEqual([code, false]);
    }
  });
  it("ends it on the hub's refusal of an answer judged anew: nothing was typed", () => {
    for (const code of ["gone", "already_answered", "settled", "expired", "changed", "no_pane", "menu_open", "node_offline", "answer_in_doubt"]) {
      expect([code, endsDoubt(code)]).toEqual([code, true]);
    }
  });
});

// V11: the hub's 404 "unknown" (no such decision on its list) is its refusal, never the app's own "unknown" (no answer
// came, so it may have gone and offers Try again): nothing was typed for it.
describe("the hub's 404 unknown", () => {
  it("is a refusal named gone, with the words for a decision that isn't on the list", async () => {
    const r = await postAnswer("ny-9", { key: "ship" }, "v1", "req-1", async () => { throw new ApiError(404, "unknown"); });
    expect(r).toEqual({ ok: false, code: "gone", text: REFUSALS.unknown });
  });
});
