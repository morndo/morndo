// The forge adapter (ADR-0035 step 3, B14): reads a pull request and one commit's check runs from the forge's web api
// and answers in facts the domain judges. Only the two documented shapes of address are ever asked, built from parts
// the domain's own grammar validated, so nothing a lane wrote can aim the request; the credential is sent on every ask
// and never said back — not in a failure detail, a log line or a thrown message (this class never throws). `baseUrl`
// exists for the tests' local stand-in alone: it is an option, never an environment variable or a setting, exactly so
// a credential cannot be pointed anywhere but the forge itself.
import { REPO_NAME, type CheckRunFacts, type PrFacts } from "@morndo/domain";
import type { ForgeAnswer, ForgeChecks } from "../application/ports.ts";

const hhmm = (at: number) => new Date(at).toISOString().slice(11, 16);   // UTC hours and minutes, as the detail says them

export class GithubChecks implements ForgeChecks {
  #token: string | null;
  #base: string;
  #fetch: typeof fetch;
  #now: () => number;
  #timeoutMs: number;
  #blockedUntil = 0;                    // the rate-limit wall: until this time every call is answered without an ask
  #blockedDetail: string | null = null;

  constructor(p: { token?: string | null; baseUrl?: string; fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {}) {
    this.#token = p.token ?? null;
    this.#base = p.baseUrl ?? "https://api.github.com";
    this.#fetch = p.fetch ?? fetch;
    this.#now = p.now ?? Date.now;
    this.#timeoutMs = p.timeoutMs ?? 8000;
  }

  async pullRequest(repo: string, number: number): Promise<ForgeAnswer<PrFacts>> {
    if (!REPO_NAME.test(repo) || !Number.isInteger(number) || number < 1 || number > 999_999_999)
      return { ok: false, failure: { reason: "unexpected", detail: "not a reference" } };
    const answer = await this.#get(`/repos/${repo}/pulls/${number}`);
    if (!answer.ok) return answer;
    let body: unknown;
    try { body = await answer.value.json(); } catch { return { ok: false, failure: { reason: "unexpected", detail: "unexpected answer" } }; }
    const b = body as { state?: unknown; merged?: unknown; head?: { sha?: unknown }; merge_commit_sha?: unknown };
    const merge = b.merge_commit_sha ?? null;
    if ((b.state !== "open" && b.state !== "closed") || typeof b.merged !== "boolean" || typeof b.head?.sha !== "string"
      || (merge !== null && typeof merge !== "string"))
      return { ok: false, failure: { reason: "unexpected", detail: "unexpected answer" } };
    return { ok: true, value: { state: b.state, merged: b.merged, headSha: b.head.sha, mergeSha: merge } };
  }

  async checkRuns(repo: string, sha: string): Promise<ForgeAnswer<CheckRunFacts[]>> {
    if (!REPO_NAME.test(repo) || !/^[0-9a-f]{7,40}$/.test(sha))
      return { ok: false, failure: { reason: "unexpected", detail: "not a reference" } };
    const runs: CheckRunFacts[] = [];
    let total: number | null = null;
    // Pages of 100 until the count the forge itself states is read, a page runs empty, or ten pages are enough: past
    // that the forge keeps only the thousand most recent suites anyway and says nothing more.
    for (let page = 1; page <= 10; page++) {
      const answer = await this.#get(`/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`);
      if (!answer.ok) return answer;
      let body: unknown;
      try { body = await answer.value.json(); } catch { return { ok: false, failure: { reason: "unexpected", detail: "unexpected answer" } }; }
      const b = body as { total_count?: unknown; check_runs?: unknown };
      if (typeof b.total_count !== "number" || !Array.isArray(b.check_runs)) return { ok: false, failure: { reason: "unexpected", detail: "unexpected answer" } };
      if (total === null) {
        total = b.total_count;
        if (total >= 1000) return { ok: false, failure: { reason: "too_many", detail: "more than 1000 check runs" } };
      }
      for (const raw of b.check_runs) {
        const r = raw as { id?: unknown; name?: unknown; status?: unknown; conclusion?: unknown; html_url?: unknown };
        const conclusion = r.conclusion ?? null;
        const url = r.html_url ?? null;
        if (typeof r.id !== "number" || typeof r.name !== "string" || typeof r.status !== "string"
          || (conclusion !== null && typeof conclusion !== "string") || (url !== null && typeof url !== "string"))
          return { ok: false, failure: { reason: "unexpected", detail: "unexpected answer" } };
        runs.push({ id: r.id, name: r.name, status: r.status, conclusion, url });
      }
      if (runs.length >= total || b.check_runs.length === 0) break;
    }
    return { ok: true, value: runs };
  }

  // One ask, its answer turned into facts or a failure. The rate-limit wall stands before the ask: a forge that said
  // when it will answer again is not asked again before then, whatever the method.
  async #get(path: string): Promise<ForgeAnswer<Response>> {
    if (this.#now() < this.#blockedUntil)
      return { ok: false, failure: { reason: "rate_limited", detail: this.#blockedDetail ?? "rate limit" } };
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        headers: {
          "accept": "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "morndo-hub",
          ...(this.#token !== null ? { authorization: `Bearer ${this.#token}` } : {}),
        },
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      return { ok: false, failure: name === "AbortError" || name === "TimeoutError"
        ? { reason: "timeout", detail: `timeout (${this.#timeoutMs} ms)` }
        : { reason: "network", detail: "network error" } };
    }
    if (res.status === 404) return { ok: false, failure: { reason: "not_found", detail: "not found or not visible" } };
    if (res.status === 422) return { ok: false, failure: { reason: "bad_sha", detail: "unknown commit" } };
    if (res.status === 401) return { ok: false, failure: { reason: "denied", detail: "access denied" } };
    if (res.status === 403 || res.status === 429) {
      // No requests left, or the forge itself says wait: the wall goes up. A 403 with requests left is a refusal, not
      // a rate limit; a 429 always is, and with no time said the wall is a minute (the forge sends one when it means it).
      const at = this.#resetAt(res);
      if (res.status === 429 || res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after") !== null)
        return this.#wall(at ?? this.#now() + 60_000);
      return { ok: false, failure: { reason: "denied", detail: "access denied" } };
    }
    if (res.status >= 300 && res.status < 400) return { ok: false, failure: { reason: "unexpected", detail: "moved, redirect not followed" } };
    if (res.status !== 200) return { ok: false, failure: { reason: "unexpected", detail: `unexpected answer (${res.status})` } };
    // An answer that itself says the last request was the last for now is remembered, answer delivered all the same.
    const remaining = res.headers.get("x-ratelimit-remaining");
    const at = this.#resetAt(res);
    if (remaining === "0" && at !== null) this.#remember(at);
    return { ok: true, value: res };
  }

  // The time the forge will answer again, as it said it: its own reset (epoch seconds) or its retry-after seconds.
  // null when it said neither, or named a reset already past.
  #resetAt(res: Response): number | null {
    const reset = res.headers.get("x-ratelimit-reset");
    if (reset !== null && /^\d+$/.test(reset)) {
      const at = Number(reset) * 1000;
      if (at > this.#now()) return at;
    }
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter !== null && /^\d+$/.test(retryAfter)) return this.#now() + Number(retryAfter) * 1000;
    return null;
  }

  #remember(at: number) { this.#blockedUntil = at; this.#blockedDetail = `rate limit, retry ${hhmm(at)} UTC`; }
  #wall(at: number): { ok: false; failure: { reason: "rate_limited"; detail: string } } {
    this.#remember(at);
    return { ok: false, failure: { reason: "rate_limited", detail: this.#blockedDetail! } };
  }
}
