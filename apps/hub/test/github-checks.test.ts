// The forge adapter (ADR-0035 step 3): the two documented paths with the version header, answers turned into facts or
// failures, and a credential that is sent but never said back. Every answer comes from the local fake forge; the
// adapter's base points there, so nothing here reaches a real forge (AGENTS.md: invented repos, numbers and shas).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GithubChecks } from "../src/adapters/github-checks.ts";
import { startFakeForge, type FakeForge } from "./fake-forge.ts";

const NOW = 1_700_000_000_000;
const FULL = "3e9d1a7c5b2f4a8e9d0c1b2a3f4e5d6c7b8a9f01";
// Key-shaped, built here so no such string sits in the source (AGENTS.md).
const TOKEN = ["forge", "token", "for", "tests"].join("-");
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

let fake: FakeForge;
let clock = NOW;
const now = () => clock;
const made = (o: { token?: string | null; timeoutMs?: number } = {}) =>
  new GithubChecks({ baseUrl: fake.base, now, ...(o.token !== undefined ? { token: o.token } : {}), ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}) });

describe("the forge adapter", () => {
  beforeEach(async () => { fake = await startFakeForge(); clock = NOW; });
  afterEach(async () => { await fake.close(); });

  it("it asks for the two documented paths with the version header, and sends a token only when it has one", async () => {
    fake.pr("acme/shop", 42, { head: FULL });
    fake.runs("acme/shop", FULL, [{ id: 1, name: "ci", status: "completed", conclusion: "success" }]);
    const checks = made({ token: TOKEN });
    const pr = await checks.pullRequest("acme/shop", 42);
    const runs = await checks.checkRuns("acme/shop", "3e9d1a7");          // a short sha meets the full one's answer
    expect(pr).toEqual({ ok: true, value: { state: "open", merged: false, headSha: FULL, mergeSha: null } });
    expect(runs).toEqual({ ok: true, value: [{ id: 1, name: "ci", status: "completed", conclusion: "success", url: null }] });
    expect(fake.requests.map(r => r.path)).toEqual(["/repos/acme/shop/pulls/42", "/repos/acme/shop/commits/3e9d1a7/check-runs"]);
    expect(fake.requests.map(r => r.query)).toEqual(["", "per_page=100&page=1"]);
    for (const r of fake.requests) {
      expect(r.headers["accept"]).toBe("application/vnd.github+json");
      expect(r.headers["x-github-api-version"]).toBe("2022-11-28");
      expect(r.headers["user-agent"]).toBe("morndo-hub");
    }
    expect(fake.requests[0]!.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    await made().pullRequest("acme/shop", 42);                            // no credential: the header is simply absent
    expect(fake.requests.at(-1)!.headers["authorization"]).toBeUndefined();
  });

  it("a pull request answer becomes facts", async () => {
    fake.pr("acme/shop", 42, { state: "closed", merged: true, head: "9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b", merge: FULL });
    expect(await made().pullRequest("acme/shop", 42)).toEqual({ ok: true, value: { state: "closed", merged: true, headSha: "9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b", mergeSha: FULL } });
  });

  it("check runs are read page by page up to the count the forge states", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, name: `run-${i + 1}`, status: "completed", conclusion: "success" }));
    fake.runs("acme/shop", FULL, many);
    const r = await made().checkRuns("acme/shop", "3e9d1a7");
    expect(r).toEqual({ ok: true, value: many.map(m => ({ id: m.id, name: m.name, status: m.status, conclusion: m.conclusion, url: null })) });
    expect(fake.requests.map(q => q.query)).toEqual(["per_page=100&page=1", "per_page=100&page=2", "per_page=100&page=3"]);
    fake.requests.length = 0;
    fake.runs("acme/shop", "1111111", many, { total: 100 });              // the count the forge states stops the reading
    await made().checkRuns("acme/shop", "1111111");
    expect(fake.requests.map(q => q.query)).toEqual(["per_page=100&page=1"]);
  });

  it("404 is not_found, 422 is bad_sha, 401 is denied, a 403 without a rate limit is denied, a 500 is unexpected", async () => {
    const checks = made();
    fake.fail("/repos/acme/shop/pulls/40", 404);
    expect(await checks.pullRequest("acme/shop", 40)).toEqual({ ok: false, failure: { reason: "not_found", detail: "not found or not visible" } });
    fake.fail("/repos/acme/shop/commits/1111111/check-runs", 422);
    expect(await checks.checkRuns("acme/shop", "1111111")).toEqual({ ok: false, failure: { reason: "bad_sha", detail: "unknown commit" } });
    fake.fail("/repos/acme/shop/pulls/41", 401);
    expect(await checks.pullRequest("acme/shop", 41)).toEqual({ ok: false, failure: { reason: "denied", detail: "access denied" } });
    fake.fail("/repos/acme/shop/pulls/42", 403);
    expect(await checks.pullRequest("acme/shop", 42)).toEqual({ ok: false, failure: { reason: "denied", detail: "access denied" } });   // a 403 with requests left is no rate limit
    fake.fail("/repos/acme/shop/pulls/43", 500);
    expect(await checks.pullRequest("acme/shop", 43)).toEqual({ ok: false, failure: { reason: "unexpected", detail: "unexpected answer (500)" } });
  });

  it("a rate-limited answer stops calls until the reset time", async () => {
    const checks = made();
    fake.fail("/repos/acme/shop/pulls/42", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((NOW + 60_000) / 1000) });
    expect(await checks.pullRequest("acme/shop", 42)).toEqual({ ok: false, failure: { reason: "rate_limited", detail: `rate limit, retry ${hhmm(NOW + 60_000)} UTC` } });
    await checks.pullRequest("acme/shop", 42);                            // the wall stands: answered without asking
    expect(fake.requests).toHaveLength(1);
    clock = NOW + 61_000;                                                 // past the reset: asked again
    fake.pr("acme/shop", 42, { head: FULL });
    expect((await checks.pullRequest("acme/shop", 42)).ok).toBe(true);
    expect(fake.requests).toHaveLength(2);
    fake.fail("/repos/acme/shop/pulls/43", 429, { "retry-after": "120" });// `retry-after` sets the same wall in its own seconds
    expect(await checks.pullRequest("acme/shop", 43)).toEqual({ ok: false, failure: { reason: "rate_limited", detail: `rate limit, retry ${hhmm(NOW + 181_000)} UTC` } });
    await checks.pullRequest("acme/shop", 43);
    expect(fake.requests).toHaveLength(3);
    clock = NOW + 241_000;
    fake.pr("acme/shop", 43, { head: FULL });
    expect((await checks.pullRequest("acme/shop", 43)).ok).toBe(true);
    expect(fake.requests).toHaveLength(4);
    // a 200 that says no requests are left is remembered all the same
    fake.runs("acme/shop", FULL, [{ id: 1, name: "ci", status: "completed", conclusion: "success" }],
      { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((NOW + 241_000 + 60_000) / 1000) } });
    expect((await checks.checkRuns("acme/shop", "3e9d1a7")).ok).toBe(true);
    expect(await checks.checkRuns("acme/shop", "2222222")).toEqual({ ok: false, failure: { reason: "rate_limited", detail: `rate limit, retry ${hhmm(NOW + 241_000 + 60_000)} UTC` } });
    expect(fake.requests).toHaveLength(5);                                // the walled-off call asked nothing
  });

  it("a redirect is not followed", async () => {
    fake.fail("/repos/acme/shop/pulls/42", 302, { location: "https://example.test/elsewhere" });
    expect(await made().pullRequest("acme/shop", 42)).toEqual({ ok: false, failure: { reason: "unexpected", detail: "moved, redirect not followed" } });
  });

  it("an answer slower than the timeout is a timeout, and a closed port is a network error", async () => {
    fake.delay("/repos/acme/shop/pulls/42", 500);
    expect(await made({ timeoutMs: 50 }).pullRequest("acme/shop", 42)).toEqual({ ok: false, failure: { reason: "timeout", detail: "timeout (50 ms)" } });
    const gone = await new Promise<number>(resolve => {
      const s = createServer(() => {});
      s.listen(0, "127.0.0.1", () => { const port = (s.address() as AddressInfo).port; s.close(() => resolve(port)); });
    });
    const off = new GithubChecks({ baseUrl: `http://127.0.0.1:${gone}`, now });
    expect(await off.pullRequest("acme/shop", 42)).toEqual({ ok: false, failure: { reason: "network", detail: "network error" } });
  });

  it("a repository, number or sha that is not in the grammar is never requested", async () => {
    const checks = made();
    for (const bad of [
      { repo: "acme shop", number: 42 },        // no space in a repository name
      { repo: "", number: 42 },
      { repo: "acme/shop", number: 0 },         // a pull request number starts at 1
      { repo: "acme/shop", number: 1.5 },
      { repo: "acme/shop", number: 1_000_000_000 },
    ] as const) expect(await checks.pullRequest(bad.repo, bad.number)).toEqual({ ok: false, failure: { reason: "unexpected", detail: "not a reference" } });
    for (const sha of ["3E9D1A7", "zzzzzzz", "3e9d1", "3e9d1a7/builds/9", ""])   // uppercase, not hex, too short, not a sha
      expect(await checks.checkRuns("acme/shop", sha)).toEqual({ ok: false, failure: { reason: "unexpected", detail: "not a reference" } });
    expect(fake.requests).toEqual([]);          // none of it ever asked the forge
  });

  it("the token appears in no log line and no output, whatever the forge does", async () => {
    const written: string[] = [];
    const take = (...a: unknown[]) => { written.push(a.map(String).join(" ")); };
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(m => vi.spyOn(console, m).mockImplementation(take));
    spies.push(vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => { take(c); return true; }) as never);
    spies.push(vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => { take(c); return true; }) as never);
    try {
      console.error("probe", TOKEN);                                   // the capture itself works: a line with the token is seen
      expect(written.join("\n")).toContain(TOKEN);
      written.length = 0;
      fake.fail("/repos/acme/shop/pulls/41", 401);
      fake.fail("/repos/acme/shop/pulls/43", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((NOW + 60_000) / 1000) });
      fake.fail("/repos/acme/shop/pulls/44", 404);
      fake.fail("/repos/acme/shop/pulls/45", 500);
      fake.fail("/repos/acme/shop/pulls/46", 302, { location: `https://example.test/${TOKEN}` });
      const checks = made({ token: TOKEN });
      for (const n of [41, 43, 44, 45, 46]) await checks.pullRequest("acme/shop", n);
      await checks.checkRuns("acme/shop", "3e9d1a7");
      const throwing = new GithubChecks({ token: TOKEN, baseUrl: fake.base, now, fetch: async () => { throw new Error(`boom ${TOKEN}`); } });
      const thrown = await throwing.pullRequest("acme/shop", 42);
      expect(JSON.stringify(thrown)).not.toContain(TOKEN);
      expect(written.join("\n")).not.toContain(TOKEN);               // nothing the adapter did said it, in any log or output
    } finally { for (const sp of spies) sp.mockRestore(); }
  });

  it("the token is not in any failure detail", async () => {
    const checks = made({ token: TOKEN });
    fake.fail("/repos/acme/shop/pulls/42", 401);
    fake.fail("/repos/acme/shop/pulls/43", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((NOW + 60_000) / 1000) });
    fake.fail("/repos/acme/shop/pulls/44", 404);
    fake.fail("/repos/acme/shop/pulls/45", 500);
    const seen = await Promise.all([42, 43, 44, 45].map(n => checks.pullRequest("acme/shop", n)));
    expect(fake.requests[0]!.headers["authorization"]).toBe(`Bearer ${TOKEN}`);   // the credential was sent
    for (const f of seen) if (!f.ok) expect(JSON.stringify(f)).not.toContain(TOKEN);   // and never said back
    expect(JSON.stringify(await checks.pullRequest("acme shop", 42))).not.toContain(TOKEN);
  });
});
