// The HTTP adapter's guards, against a real server on a random port (synthetic data only).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceHealth, ReadyOnlyHealth } from "@morndo/protocol";
import { SCHEMA_VERSION } from "../src/adapters/migrations.ts";
import { Store } from "../src/adapters/store.ts";
import { loadOrCreateIdentity } from "../src/adapters/identity.ts";
import { passkeys } from "../src/adapters/passkeys.ts";
import { healthDetail, startHttp } from "../src/adapters/http.ts";
import { AccessService } from "../src/application/access-service.ts";
import { ObservationService } from "../src/application/observation-service.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import { EscalationService } from "../src/application/escalation-service.ts";
import { RemoteService } from "../src/application/remote-service.ts";
import type { Config } from "../src/config.ts";

const LOGIN = "principal@example.test";
let dir: string;
let store: Store;
let http: Awaited<ReturnType<typeof startHttp>>;
let base: string;
let config: Config;

const req = (path: string, init: RequestInit & { login?: string | null } = {}) => {
  const headers = new Headers(init.headers);
  if (init.login !== null) headers.set("tailscale-user-login", init.login ?? LOGIN);
  return fetch(base + path, { ...init, headers });
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-http-"));
  const web = join(dir, "web");
  mkdirSync(web);
  writeFileSync(join(web, "200.html"), "<!doctype html><html><head><script>boot()</script></head><body>shell</body></html>");
  store = new Store(dir);
  config = {
    dataDir: dir, port: 0, origin: "https://hub.example.test", rpId: "hub.example.test", rpName: "Morndo",
    requireProxyIdentity: true, principalLogin: LOGIN, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 1000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
  const access = new AccessService(store, passkeys(config));
  const tmux = { listWorkers: async () => [], capture: async () => null, captureMany: async () => new Map<string, string | null>(), send: async () => ({ problem: null, typedAt: Date.now() }) };
  const observation = new ObservationService(tmux, 1000);
  const escalations = new EscalationService({
    watch: { workers: () => [], history: () => [], openQuestions: () => [], screen: () => undefined },
    ledger: null, store, managerName: "manager", send: async () => ({ problem: null, typedAt: 0 }),
  });
  const remote = new RemoteService({ store, terminal: { frame: async () => null, keys: async () => false }, panes: () => ["%1"], desktop: () => null });
  http = startHttp({ config, identity: loadOrCreateIdentity(dir), access, store, observation, steering: new SteeringService(store, tmux), escalations, remote });
  await http.ready;
  base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
});
afterAll(async () => { await http.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("proxy identity gate", () => {
  it("refuses requests without the proxy's identity header, or from another login", async () => {
    expect((await req("/api/identity", { login: null })).status).toBe(403);
    expect((await req("/api/identity", { login: "someone@else.test" })).status).toBe(403);
    expect((await req("/api/identity")).status).toBe(200);
  });
});

describe("origin and auth", () => {
  it("refuses state-changing requests from another origin", async () => {
    const post = (origin?: string) => req("/api/login/options", {
      method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: "{}",
    });
    expect((await post()).status).toBe(403);
    expect((await post("https://evil.example.test")).status).toBe(403);
    expect((await post(config.origin)).status).toBe(200);
  });
  it("sending into a worker needs a session and the right origin", async () => {
    const post = (origin: string) => req("/api/workers/%251/send", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ text: "hi", requestId: "r1" }) });
    expect((await post("https://evil.example.test")).status).toBe(403);
    expect((await post(config.origin)).status).toBe(401);
  });
  it("answering a decision needs a session and the right origin; the list needs a session", async () => {
    const post = (origin: string) => req("/api/escalations/ny-1/answer", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ key: "ship", requestId: "r1" }) });
    expect((await post("https://evil.example.test")).status).toBe(403);
    expect((await post(config.origin)).status).toBe(401);
    expect((await req("/api/escalations")).status).toBe(401);
  });
  it("uploading an image needs a session and the right origin", async () => {
    const post = (origin: string) => req("/api/uploads", { method: "POST", headers: { "content-type": "image/png", origin }, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) });
    expect((await post("https://evil.example.test")).status).toBe(403);
    expect((await post(config.origin)).status).toBe(401);
  });
  it("a file needs a session", async () => {
    expect((await req(`/api/files/${"a".repeat(32)}`)).status).toBe(401);
  });
  it("needs a session for private routes", async () => {
    const r = await req("/api/devices");
    expect(r.status).toBe(401);
    expect(r.headers.get("set-cookie")).toMatch(/^__Host-morndo=; Path=\/; Secure; HttpOnly; SameSite=Strict/);
    expect((await req("/api/devices", { headers: { cookie: "__Host-morndo=forged" } })).status).toBe(401);
  });
  it("refuses a pairing with an unknown code", async () => {
    const r = await req("/api/pair/options", { method: "POST", headers: { "content-type": "application/json", origin: config.origin }, body: JSON.stringify({ token: "x", name: "y" }) });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "unknown_token" });
  });
});

describe("static shell", () => {
  it("serves the app shell with a CSP that allows exactly its inline script", async () => {
    const r = await req("/anything/deep");
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self' 'sha256-");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("doesn't serve files outside the web directory", async () => {
    const r = await req("/..%2f..%2fmorndo.db");
    expect(await r.text()).toContain("shell");
  });
});

describe("live feed upgrade", () => {
  const open = (headers: Record<string, string>) => new Promise<number>(resolve => {
    const ws = new WebSocket(base.replace("http", "ws") + "/api/feed", { headers });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("open", () => { ws.close(); resolve(101); });
    ws.on("error", () => {});
  });
  it("refuses a WebSocket without the right origin, and without a session", async () => {
    expect(await open({ "tailscale-user-login": LOGIN })).toBe(403);
    expect(await open({ "tailscale-user-login": LOGIN, origin: "https://evil.example.test" })).toBe(403);
    expect(await open({ "tailscale-user-login": LOGIN, origin: config.origin })).toBe(401);
  });
  it("the terminal and desktop sockets are guarded the same way", async () => {
    for (const path of ["/api/terminal?pane=%251", "/api/desktop", "/api/desktop?control=1"]) {
      const code = (headers: Record<string, string>) => new Promise<number>(resolve => {
        const ws = new WebSocket(base.replace("http", "ws") + path, { headers });
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("open", () => { ws.close(); resolve(101); });
        ws.on("error", () => {});
      });
      expect(await code({ "tailscale-user-login": LOGIN, origin: "https://evil.example.test" })).toBe(403);
      expect(await code({ "tailscale-user-login": LOGIN, origin: config.origin })).toBe(401);
    }
  });
});

describe("health", () => {
  it("on the machine, reports one version, the schema, ready, and what is in flight", async () => {
    const end = http.flight.begin({ kind: "http", id: "POST /api/workers/%1/send" });
    const res = await req("/api/health", { login: null });
    const body = await res.json();
    end();
    expect(res.status).toBe(200);
    expect(ServiceHealth.safeParse(body).success).toBe(true);
    const root = JSON.parse(readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8")) as { version: string };
    expect(body).toMatchObject({ version: root.version, commit: expect.stringMatching(/^[0-9a-f]{40}$/), schema: SCHEMA_VERSION, ready: true, held: false, inFlight: [{ kind: "http", id: "POST /api/workers/%1/send" }] });
  });
  it("through the proxy, with no session, reports ready and nothing else", async () => {
    const res = await req("/api/health");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ready: true });
    expect(ReadyOnlyHealth.safeParse(body).success).toBe(true);
  });
  it("a loopback socket with no proxy header is the full check, and a tagged or public address is ready only", () => {
    expect(healthDetail({ remoteAddress: "127.0.0.1", proxyLogin: undefined, authenticated: false })).toBe("full");
    expect(healthDetail({ remoteAddress: "::1", proxyLogin: undefined, authenticated: false })).toBe("full");
    expect(healthDetail({ remoteAddress: "::ffff:127.0.0.1", proxyLogin: undefined, authenticated: false })).toBe("full");
    expect(healthDetail({ remoteAddress: "100.64.0.2", proxyLogin: undefined, authenticated: false })).toBe("ready");
    expect(healthDetail({ remoteAddress: "203.0.113.10", proxyLogin: undefined, authenticated: false })).toBe("ready");
    expect(healthDetail({ remoteAddress: undefined, proxyLogin: undefined, authenticated: false })).toBe("ready");
    expect(healthDetail({ remoteAddress: "203.0.113.10", proxyLogin: undefined, authenticated: true })).toBe("full");
  });
});

describe("idle", () => {
  it("holds new work, then returns while something is still in flight", async () => {
    const end = http.flight.begin({ kind: "http", id: "stuck" });
    const started = performance.now();
    const waiting = http.idle(200);
    const res = await req("/api/workers/%251/send", {
      method: "POST", headers: { "content-type": "application/json", origin: config.origin },
      body: JSON.stringify({ text: "hi", requestId: "r-idle" }),
    });
    expect(res.status).toBe(503);
    end();
    await waiting;
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
