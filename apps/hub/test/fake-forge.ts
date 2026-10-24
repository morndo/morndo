// A local stand-in for the forge (ADR-0035 step 3): the two documented paths, answered from what a test registered,
// every request kept for counting and header checks, and anything unregistered answered with a 404. Invented repos,
// numbers and shas only (AGENTS.md); the adapter's base points here, so no test ever reaches a real forge.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type ForgeFacts = { state?: string; merged?: boolean; head?: string; merge?: string | null };
export type ForgeRun = { id: number; name: string; status: string; conclusion: string | null; url?: string };
// `query` is the search string as sent (`per_page=100&page=2`), so a test can read the paging itself.
export type ForgeRequest = { method: string; path: string; query: string; headers: Record<string, string | string[] | undefined> };

const FULL = "3e9d1a7c5b2f4a8e9d0c1b2a3f4e5d6c7b8a9f01";
const JSON_HEADERS = { "content-type": "application/json" };

// An answer: fixed for a pull request, sliced per page for check runs (`runs` holds the whole list; `total` overrides
// what the forge counts, for the counts that stop the reading early).
type Entry = { path: string; status: number; headers: Record<string, string>; body: string; delayMs?: number; runs?: ForgeRun[]; total?: number };
const CHECK_RUNS = /^\/repos\/(.+)\/commits\/([0-9a-f]+)\/check-runs$/;

export type FakeForge = {
  base: string;
  requests: ForgeRequest[];
  // The pull request answer: defaults leave an open, unmerged request at the head sha the test's refs point at.
  pr(repo: string, number: number, facts?: ForgeFacts, opts?: { headers?: Record<string, string> }): void;
  // The check runs of one commit; registering again replaces what that commit said before.
  runs(repo: string, sha: string, list: ForgeRun[], opts?: { total?: number; headers?: Record<string, string> }): void;
  fail(path: string, status: number, headers?: Record<string, string>): void;
  // A private repository: every path under it answers 404 (as the forge does for what a caller may not see) unless the
  // request carries `Authorization: Bearer <token>`.
  privateRepo(repo: string, token: string): void;
  delay(path: string, ms: number): void;
  close(): Promise<void>;
};

export function startFakeForge(): Promise<FakeForge> {
  const requests: ForgeRequest[] = [];
  let entries: Entry[] = [];
  const locked = new Map<string, string>();     // lower-case repository -> the bearer token that may read it
  // Registering replaces what that path said before — and for check runs, what that commit said before, in whatever
  // form of its sha the earlier answer was registered under (a `fail` at the 7-character form, then `runs` at the full
  // one: the commit's answer is the new one).
  const sameAnswer = (e: Entry, entry: Entry): boolean => {
    if (e.path === entry.path) return true;
    const m = CHECK_RUNS.exec(entry.path);
    const n = CHECK_RUNS.exec(e.path);
    return m !== null && n !== null && m[1] === n[1] && (m[2]!.startsWith(n[2]!) || n[2]!.startsWith(m[2]!));
  };
  const put = (entry: Entry) => { entries = entries.filter(e => !sameAnswer(e, entry)); entries.push(entry); };
  // A reference's short sha meets an answer registered under the full one (or the other way round), same repository.
  const entryFor = (path: string): Entry | null => {
    const exact = entries.find(e => e.path === path);
    if (exact) return exact;
    const cr = CHECK_RUNS.exec(path);
    if (cr === null) return null;
    return entries.find(e => { const m = CHECK_RUNS.exec(e.path); return m !== null && m[1] === cr[1] && (m[2]!.startsWith(cr[2]!) || cr[2]!.startsWith(m[2]!)); }) ?? null;
  };
  const server = createServer((req, res) => {
    res.on("error", () => {});   // a delayed answer can outlive its socket (a timeout test drops it): never a crash
    const u = new URL(req.url ?? "/", "http://forge.test");
    requests.push({ method: req.method ?? "GET", path: u.pathname, query: u.search.replace(/^\?/, ""), headers: { ...req.headers } });
    const owner = /^\/repos\/([^/]+\/[^/]+)\//.exec(u.pathname)?.[1]?.toLowerCase();
    const key = owner === undefined ? undefined : locked.get(owner);
    const entry = key !== undefined && req.headers["authorization"] !== `Bearer ${key}` ? null : entryFor(u.pathname);
    const send = () => {
      if (entry === null) { res.writeHead(404, JSON_HEADERS); res.end("{}"); return; }
      if (entry.runs === undefined) { res.writeHead(entry.status, entry.headers); res.end(entry.body); return; }
      const q = new URLSearchParams(u.search);
      const per = Number(q.get("per_page") ?? "100");
      const start = (Number(q.get("page") ?? "1") - 1) * per;
      res.writeHead(entry.status, entry.headers);
      res.end(JSON.stringify({
        total_count: entry.total ?? entry.runs.length,
        check_runs: entry.runs.slice(start, start + per).map(r => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, html_url: r.url ?? null })),
      }));
    };
    if (entry?.delayMs !== undefined) { setTimeout(send, entry.delayMs).unref?.(); return; }
    send();
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requests,
        pr: (repo, number, facts = {}, opts = {}) => {
          const f = { state: "open", merged: false, head: FULL, merge: null as string | null, ...facts };
          put({ path: `/repos/${repo}/pulls/${number}`, status: 200, headers: { ...JSON_HEADERS, ...(opts.headers ?? {}) }, body: JSON.stringify({ state: f.state, merged: f.merged, head: { sha: f.head }, merge_commit_sha: f.merge }) });
        },
        runs: (repo, sha, list, opts = {}) => put({ path: `/repos/${repo}/commits/${sha}/check-runs`, status: 200, headers: { ...JSON_HEADERS, ...(opts.headers ?? {}) }, body: "", runs: list, ...(opts.total !== undefined ? { total: opts.total } : {}) }),
        privateRepo: (repo, token) => { locked.set(repo.toLowerCase(), token); },
        fail: (path, status, headers = {}) => put({ path, status, headers: { ...JSON_HEADERS, ...headers }, body: "{}" }),
        delay: (path, ms) => put({ path, status: 200, headers: { ...JSON_HEADERS }, body: "{}", delayMs: ms }),
        close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}
