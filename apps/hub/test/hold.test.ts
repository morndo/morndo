// A hold refuses a new send before auth, with 503 and Retry-After. The health shape is covered in http.test.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadOrCreateIdentity } from "../src/adapters/identity.ts";
import { passkeys } from "../src/adapters/passkeys.ts";
import { startHttp } from "../src/adapters/http.ts";
import { Store } from "../src/adapters/store.ts";
import { AccessService } from "../src/application/access-service.ts";
import { EscalationService } from "../src/application/escalation-service.ts";
import { ObservationService } from "../src/application/observation-service.ts";
import { RemoteService } from "../src/application/remote-service.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import type { Config } from "../src/config.ts";

const LOGIN = "principal@example.test";
let dir: string;
let store: Store;
let http: ReturnType<typeof startHttp>;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-hold-"));
  const web = join(dir, "web");
  mkdirSync(web);
  writeFileSync(join(web, "200.html"), "<!doctype html><html><body>shell</body></html>");
  writeFileSync(join(dir, "hold.json"), JSON.stringify({
    services: ["hub"], reason: "drain", version: "0.0.0", since: new Date().toISOString(),
  }));
  store = new Store(dir);
  const config: Config = {
    dataDir: dir, port: 0, origin: "https://hub.example.test", rpId: "hub.example.test", rpName: "Morndo",
    requireProxyIdentity: true, principalLogin: LOGIN, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 1000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, managerInbox: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
  const access = new AccessService(store, passkeys(config));
  const tmux = { listWorkers: async () => [], capture: async () => null, captureMany: async () => new Map<string, string | null>(), send: async () => ({ problem: null, typedAt: Date.now() }) };
  http = startHttp({
    config, identity: loadOrCreateIdentity(dir), access,
    observation: new ObservationService(tmux, 1000),
    steering: new SteeringService(store, tmux),
    escalations: new EscalationService({
      watch: { workers: () => [], history: () => [], openQuestions: () => [], screen: () => undefined },
      ledger: null, store, managerName: "manager", send: async () => ({ problem: null, typedAt: 0 }),
    }),
    remote: new RemoteService({ store, terminal: { frame: async () => null, keys: async () => false }, panes: () => ["%1"], desktop: () => null }),
    updates: { holdPath: join(dir, "hold.json") },
  });
  await http.ready;
  base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
});
afterAll(async () => { await http.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("hold", () => {
  it("refuses a send with 503 and Retry-After, before a session is required", async () => {
    const res = await fetch(`${base}/api/workers/%251/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://hub.example.test", "tailscale-user-login": LOGIN },
      body: JSON.stringify({ text: "hi", requestId: "r1" }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(await res.json()).toEqual({ error: "updating" });
    const narrow = await fetch(`${base}/api/connections/narrow`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://hub.example.test", "tailscale-user-login": LOGIN },
      body: JSON.stringify({ version: 1, name: "work", action: "off" }),
    });
    expect(narrow.status).not.toBe(503);
    const revoke = await fetch(`${base}/api/connections/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://hub.example.test", "tailscale-user-login": LOGIN },
      body: JSON.stringify({ version: 1, name: "work" }),
    });
    expect(revoke.status).not.toBe(503);
  });
  it("refuses a terminal or desktop upgrade with 503", async () => {
    for (const path of ["/api/terminal?pane=%251", "/api/desktop"]) {
      const code = await new Promise<number>(resolve => {
        const ws = new WebSocket(base.replace("http", "ws") + path, {
          headers: { "tailscale-user-login": LOGIN, origin: "https://hub.example.test" },
        });
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("open", () => { ws.close(); resolve(101); });
        ws.on("error", () => {});
      });
      expect(code).toBe(503);
    }
  });
});
