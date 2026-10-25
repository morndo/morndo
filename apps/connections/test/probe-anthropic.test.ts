// The probe adapter (ADR-0037, slice 3; plan 3.2): one POST to /v1/messages with max_tokens 1, to the preset's base URL only, with the key opened
// by the adapter itself. It answers with what the provider said, reduced to a signal, or says it could not reach it. It never calls the token
// counter or the models endpoint (KP7), never reads a success body, bounds an error body, and returns no key. A local server stands in for the API:
// no real key, nothing leaves the machine. Keys are synthetic.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnthropicProbe, PROBE_TIMEOUT_MS, PROBE_VERSION } from "../src/adapters/probe-anthropic.ts";

const KEY = "sk-ant-synthetic-probe-key-0001";
const PLANTED = "planted-secret-in-a-provider-body";
type Seen = { method: string; path: string; headers: IncomingMessage["headers"]; body: string };
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.close(() => { resolve(); }); server.closeAllConnections(); });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A server that records every request and answers as `answer` says: a status, headers and a body (or never).
async function api(answer: { status?: number; headers?: Record<string, string>; body?: string | undefined; never?: boolean } = {}): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
      if (answer.never) return;
      res.writeHead(answer.status ?? 200, { "content-type": "application/json", ...(answer.headers ?? {}) });
      res.end(answer.body ?? JSON.stringify({ id: "msg_synthetic", type: "message", role: "assistant", content: [{ type: "text", text: "." }] }));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen };
}
const probeOf = (extra: { timeoutMs?: number; known?: boolean } = {}) =>
  new AnthropicProbe({
    refOf: name => (extra.known === false || name !== "k1" ? null : "ref-k1"),
    open: async ref => { if (ref !== "ref-k1") throw new Error("no such ref"); return KEY; },
    ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
  });
const ask = (probe: AnthropicProbe, baseUrl: string) => probe.probe({ connection: "k1", model: "claude-haiku-5-5", baseUrl });
const errorBody = (type: string, message: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "error", error: { type, message, ...extra }, request_id: "req_synthetic" });

describe("what the probe sends", () => {
  it("probe sends max_tokens 1 to the probe model and to the preset's base URL only: one POST to /v1/messages", async () => {
    const { url, seen } = await api();
    await ask(probeOf(), url);
    expect(seen).toHaveLength(1);
    const call = seen[0]!;
    expect([call.method, call.path]).toEqual(["POST", "/v1/messages"]);
    expect(call.headers["x-api-key"]).toBe(KEY);
    expect(call.headers["anthropic-version"]).toBe(PROBE_VERSION);
    expect(PROBE_VERSION).toBe("2026-10-21");
    expect(String(call.headers["content-type"])).toMatch(/^application\/json/);
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model"]);
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.max_tokens).toBe(1);
    expect(body.messages).toEqual([{ role: "user", content: expect.stringMatching(/^.$/u) }]);
  });
  it("a trailing slash on the base URL does not double it", async () => {
    const { url, seen } = await api();
    await ask(probeOf(), `${url}/`);
    expect(seen.map(call => call.path)).toEqual(["/v1/messages"]);
  });
  it("no probe path calls count_tokens or the models endpoint, whatever the answer", async () => {
    for (const status of [200, 400, 401, 402, 403, 429, 529]) {
      const { url, seen } = await api({ status, body: status === 200 ? undefined : errorBody("api_error", "x") });
      await ask(probeOf(), url);
      expect(seen.map(call => call.path)).toEqual(["/v1/messages"]);
    }
  });
  it("the adapter's source never names the token counter or the models endpoint", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/adapters/probe-anthropic.ts"), "utf8");
    expect(source).not.toContain("count_tokens");
    expect(source).not.toContain("/v1/models");
  });
  it("the bound is five seconds", () => {
    expect(PROBE_TIMEOUT_MS).toBe(5000);
  });
});

describe("what the probe returns", () => {
  it("a 200 is a signal with status 200 and nothing else: its body is never read into it", async () => {
    const { url } = await api({ body: JSON.stringify({ content: [{ type: "text", text: PLANTED }] }) });
    const answer = await ask(probeOf(), url);
    expect(answer).toEqual({ signal: { status: 200, kind: null, text: null, retryAfterSeconds: null, code: null, resumeDate: null } });
  });
  it("the credit refusal keeps its status, error type and a bounded message", async () => {
    const message = `Your credit balance is too low to access the Anthropic API. ${"x".repeat(600)}`;
    const { url } = await api({ status: 400, body: errorBody("invalid_request_error", message) });
    const answer = await ask(probeOf(), url);
    expect("signal" in answer && answer.signal).toMatchObject({ status: 400, kind: "invalid_request_error", retryAfterSeconds: null });
    const text = "signal" in answer ? answer.signal.text : null;
    expect(text).toMatch(/^Your credit balance is too low/);
    expect((text ?? "").length).toBeLessThanOrEqual(256);
  });
  it("a spend-limit refusal keeps the date it names, a 429 keeps retry-after and its error code", async () => {
    const limit = await api({ status: 400, body: errorBody("invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.") });
    const a = await ask(probeOf(), limit.url);
    expect("signal" in a && a.signal.resumeDate).toBe("2026-11-01");
    const cap = await api({ status: 429, headers: { "retry-after": "7" }, body: errorBody("rate_limit_error", "capped", { details: { error_code: "enforced_spend_limit_reached" } }) });
    const b = await ask(probeOf(), cap.url);
    expect("signal" in b && b.signal).toMatchObject({ status: 429, kind: "rate_limit_error", retryAfterSeconds: 7, code: "enforced_spend_limit_reached" });
  });
  it("an error body that is huge is cut: the signal's text is at most 256 characters and the read is bounded", async () => {
    const { url } = await api({ status: 500, body: "y".repeat(5_000_000) });
    const answer = await ask(probeOf(), url);
    expect("signal" in answer && (answer.signal.text ?? "").length).toBeLessThanOrEqual(256);
  });
  it("the key is in no part of what comes back, even when the provider (or a proxy) echoes it in its message", async () => {
    const { url } = await api({ status: 401, body: errorBody("authentication_error", `invalid x-api-key ${KEY}`) });
    const answer = await ask(probeOf(), url);
    expect(JSON.stringify(answer)).toContain("authentication_error");
    expect(JSON.stringify(answer)).not.toContain(KEY);
  });
});

describe("when the provider cannot be reached", () => {
  it("a server that never answers is unreachable within the bound given", async () => {
    const { url } = await api({ never: true });
    const started = Date.now();
    expect(await ask(probeOf({ timeoutMs: 150 }), url)).toEqual({ unreachable: true });
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it("nothing listening is unreachable", async () => {
    expect(await ask(probeOf(), "http://127.0.0.1:1")).toEqual({ unreachable: true });
  });
  it("a base URL that is empty or not a URL is unreachable and nothing is sent; so is an unknown Connection", async () => {
    const { url, seen } = await api();
    expect(await ask(probeOf(), "")).toEqual({ unreachable: true });
    expect(await ask(probeOf(), "not a url")).toEqual({ unreachable: true });
    expect(await probeOf({ known: false }).probe({ connection: "k1", model: "claude-haiku-5-5", baseUrl: url })).toEqual({ unreachable: true });
    expect(seen).toEqual([]);
  });
  it("a key that cannot be opened is unreachable and nothing is sent", async () => {
    const { url, seen } = await api();
    const broken = new AnthropicProbe({ refOf: () => "ref-gone", open: async () => { throw new Error(`cannot open ${KEY}`); } });
    const answer = await broken.probe({ connection: "k1", model: "claude-haiku-5-5", baseUrl: url });
    expect(answer).toEqual({ unreachable: true });
    expect(JSON.stringify(answer)).not.toContain(KEY);
    expect(seen).toEqual([]);
  });
});

describe("probe never writes the response text to disk or the alert file", () => {
  it("run in a fresh working directory with a planted secret in the body, no file appears anywhere in it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-probe-"));
    dirs.push(dir);
    const was = process.cwd();
    process.chdir(dir);
    try {
      const { url } = await api({ status: 400, body: errorBody("invalid_request_error", `credit balance is too low ${PLANTED}`) });
      await ask(probeOf(), url);
    } finally { process.chdir(was); }
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("the guards on how the probe reads and where it sends", () => {
  // A response whose body is a counted stream of 1 KB chunks: how many chunks the adapter pulled is how much it read.
  const counted = (status: number, chunks: number): { fetch: typeof fetch; pulled: () => number } => {
    let pulled = 0;
    const fake = (async () => {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= chunks) { controller.close(); return; }
          sent += 1;
          pulled += 1;
          controller.enqueue(new TextEncoder().encode("y".repeat(1024)));
        },
      }, { highWaterMark: 0 });
      return new Response(body, { status });
    }) as unknown as typeof fetch;
    return { fetch: fake, pulled: () => pulled };
  };
  const withFetch = (fake: typeof fetch) => new AnthropicProbe({ refOf: () => "ref-k1", open: async () => KEY, fetch: fake });
  it("a success body is cancelled unread: at most one chunk is pulled", async () => {
    const { fetch: fake, pulled } = counted(200, 100);
    await ask(withFetch(fake), "https://api.example.test");
    expect(pulled()).toBeLessThanOrEqual(1);
  });
  it("an error body is read up to eight kilobytes and no further", async () => {
    const { fetch: fake, pulled } = counted(500, 100);
    await ask(withFetch(fake), "https://api.example.test");
    expect(pulled()).toBeGreaterThanOrEqual(8);
    expect(pulled()).toBeLessThanOrEqual(10);
  });
  it("a redirect is never followed: the answer is unreachable and the other host is sent nothing, least of all the key", async () => {
    const elsewhere = await api();
    const first = await api({ status: 302, headers: { location: `${elsewhere.url}/v1/messages` } });
    expect(await ask(probeOf(), first.url)).toEqual({ unreachable: true });
    expect(first.seen).toHaveLength(1);
    expect(elsewhere.seen).toEqual([]);
  });
});

describe("rev-158: a model or version the provider does not know is told apart from a verdict on the key", () => {
  const answerOf = async (status: number, type: string, message: string) => {
    const { url } = await api({ status, body: errorBody(type, message) });
    return ask(probeOf(), url);
  };
  it("a 404 not_found_error is a model problem", async () => {
    expect(await answerOf(404, "not_found_error", "model: claude-haiku-5-5")).toEqual({ misconfigured: "model" });
  });
  it("a 400 that says the model is not valid is a model problem; one that says the version is is a version problem", async () => {
    expect(await answerOf(400, "invalid_request_error", "model: claude-haiku-9 is not a valid model ID")).toEqual({ misconfigured: "model" });
    expect(await answerOf(400, "invalid_request_error", "anthropic-version: 2030-01-01 is not supported")).toEqual({ misconfigured: "version" });
  });
  it("a credit refusal, a spend limit, a bad max_tokens, a refused key and a rate limit are signals, never misconfigured", async () => {
    for (const [status, type, message] of [
      [400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API."],
      [400, "invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."],
      [400, "invalid_request_error", "Your credit balance is too low to use this model."],
      [400, "invalid_request_error", "You have reached your specified API usage limits for this model."],
      [400, "invalid_request_error", "max_tokens: must be greater than or equal to 1"],
      [401, "authentication_error", "invalid x-api-key"],
      [403, "permission_error", "forbidden for the model owner"],
      [429, "rate_limit_error", "slow down"],
    ] as const) {
      const answer = await answerOf(status, type, message);
      expect("signal" in answer, `${status} ${message}`).toBe(true);
    }
  });
});
