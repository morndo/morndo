// The total deadline's contract (design §6.1 step 2's "with a timeout", §10.2 step 5's cap): an idle timeout measures
// silence, never progress, so a host that sends one byte inside every idle window would hold a check — and with it
// the apply lock (RL4) — for as long as it likes. Every fetch therefore gets one wall of its own, measured from the
// first request and shared by every redirect hop. The same throwaway TLS world as the feed tests; each case sits on
// its own server, closed in afterEach with its sockets, so a dribbling response never outlives its test.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { artifactDeadlineMs } from "../src/application/check-service.ts";
import { FetchFailed } from "../src/application/ports.ts";
import { httpsGet } from "../src/adapters/https-get.ts";
import { makeTestCa, serveHttps, type TestCa, type TestServer } from "./helpers/tls.ts";

// A dribbling host: headers, then one byte every `everyMs`, forever. Each byte lands inside the idle window, so the
// idle timeout alone never fires — only a total deadline can end this. The interval dies with the response.
const dribble = (res: ServerResponse, everyMs: number): void => {
  res.writeHead(200);
  const drip = setInterval(() => { res.write(Buffer.alloc(1, 105)); }, everyMs);
  const stop = (): void => clearInterval(drip);
  res.on("close", stop);
  res.on("error", stop);
};

// What a fetch did — its value, or its refusal — or "late" when the rescue timer won the race: on code with no total
// deadline the dribble never ends, and the test fails on late here instead of hanging the run.
type Answer = { done: true; value?: unknown; error?: Error } | { done: false };

let dir = "";
let tls!: TestCa;
let server: TestServer | null = null;
let rescue: ReturnType<typeof setTimeout> | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-upd-"));
  tls = makeTestCa(dir);
});
afterAll(async () => {
  await closeServer();
  rmSync(dir, { recursive: true, force: true });
});
// The server and its sockets first, then the rescue timer: a dribbling response or a pending timer would otherwise
// outlive its case (serveHttps's close sweeps both connection kinds).
afterEach(async () => {
  clearTimeout(rescue);
  await closeServer();
});

const closeServer = async (): Promise<void> => {
  if (server === null) return;
  const open = server;
  server = null;
  await open.close();
};

const raced = (fetch: Promise<unknown>): Promise<Answer> =>
  Promise.race([
    fetch.then(value => ({ done: true as const, value }), error => ({ done: true as const, error })),
    new Promise<{ done: false }>(resolve => { rescue = setTimeout(() => resolve({ done: false }), 4_000); }),
  ]);

describe("httpsGet's total deadline (§6.1, §10.2)", () => {
  it("ends a host that dribbles one byte inside every idle window: the wall, not the silence, stops it", async () => {
    server = await serveHttps({ key: tls.serverKey, cert: tls.serverCert, handler: (_req, res) => dribble(res, 400) });
    const answer = await raced(httpsGet(`${server.url}drip.bin`, { ca: tls.ca, maxBytes: 64 * 1024, timeoutMs: 500, deadlineMs: 1_500 }));
    if (answer.done !== true) throw new Error("the fetch was still running 4 s into a 1.5 s deadline");
    expect(answer.error).toBeInstanceOf(FetchFailed);
    expect((answer.error as FetchFailed).reason).toBe("timeout");
    expect((answer.error as FetchFailed).message).toBe(`${server!.url}drip.bin: no complete answer within 1500 ms`);
  });

  it("one deadline covers every redirect hop: counted from the first request, not from the hop", async () => {
    let base = "";
    server = await serveHttps({
      key: tls.serverKey, cert: tls.serverCert,
      handler: (req, res) => {
        if (req.url === "/first.bin") {
          // 600 ms of silence — short of the 900 ms idle window — then the redirect to the dribbling second hop.
          setTimeout(() => { res.writeHead(302, { location: `${base}drip.bin` }); res.end(); }, 600);
          return;
        }
        dribble(res, 700);
      },
    });
    base = server.url;
    const startedAt = Date.now();
    const answer = await raced(httpsGet(`${server.url}first.bin`, { ca: tls.ca, maxBytes: 64 * 1024, timeoutMs: 900, deadlineMs: 1_500 }));
    if (answer.done !== true) throw new Error("the fetch was still running 4 s into a 1.5 s deadline");
    expect(answer.error).toBeInstanceOf(FetchFailed);
    const error = answer.error as FetchFailed;
    expect(error.reason).toBe("timeout");
    expect(error.message).toBe(`${server!.url}first.bin: no complete answer within 1500 ms`);
    // A deadline that restarted per hop would end at 600 + 1500 ms; this one ends at its own 1500 ms from the start.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("an artifact's deadline scales with its size: ten minutes of slack plus the size at 32 KiB/s", () => {
    expect(artifactDeadlineMs(0)).toBe(10 * 60_000);                     // the slack alone, for the smallest artifact
    const minutes = artifactDeadlineMs(50 * 1024 * 1024) / 60_000;       // a 50 MB archive: about 36 minutes
    expect(minutes).toBeGreaterThan(30);
    expect(minutes).toBeLessThan(40);
  });
});
