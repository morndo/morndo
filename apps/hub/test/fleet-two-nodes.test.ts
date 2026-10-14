// The hub in fleet mode end to end, against a fake fleet with two nodes whose panes are both %1 (spec §9, "Two nodes":
// "the hub lists and steers both"). It checks that:
// - the roster names both workers by worker id, with their node;
// - the feed takes those ids in its frames;
// - a send reaches only its own node;
// - the terminal route opens a worker id;
// - a legacy %N from an older app's outbox is no pane;
// - a malformed or foreign id is no route, and a path that doesn't decode is never a 500 (each segment is decoded once);
// - the two menus are two asks with two ids.
// The real HTTP server and services, fake passkeys, a temp data dir, and the fleet adapters over a real Unix socket.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ServerFeedFrames, decode } from "@morndo/protocol";
import type { Config } from "../src/config.ts";
import { Store } from "../src/adapters/store.ts";
import { loadOrCreateIdentity } from "../src/adapters/identity.ts";
import { startHttp } from "../src/adapters/http.ts";
import type { Passkeys } from "../src/adapters/passkeys.ts";
import { AccessService } from "../src/application/access-service.ts";
import { RemoteService } from "../src/application/remote-service.ts";
import type { ObservationService } from "../src/application/observation-service.ts";
import type { EscalationService } from "../src/application/escalation-service.ts";
import { localNode, memoryBackend, type MemoryBackend, type MemoryPane } from "./helpers/fake-fleet.ts";
import { escalationsFor, fleetRig, observationFor, steeringFor, type FleetRig } from "./helpers/hub-mode.ts";

const ORIGIN = "https://hub.example.test";
const PC1 = "pc.aaaaaaaa.1";
const BOX1 = "box.bbbbbbbb.1";
const BOX = "──────\n❯ ";
const MENU = "Allow this edit?\n❯ 1. Yes\n  2. No\n\nEsc to cancel";

type FleetHub = {
  observation: ObservationService;
  escalations: EscalationService;
  cookie(): Promise<string>;
  get(path: string): Promise<Response>;
  post(path: string, body: unknown, cookie: string): Promise<Response>;
  socket(path: string, cookie: string): Promise<WebSocket>;
  close(): Promise<void>;
};

// The hub as main.ts builds it in fleet mode, on a random port: its services on the fleet adapters.
async function startFleetHub(rig: FleetRig): Promise<FleetHub> {
  const dir = mkdtempSync(join(tmpdir(), "morndo-fleet-hub-"));
  const web = join(dir, "web");
  mkdirSync(web);
  writeFileSync(join(web, "200.html"), "<!doctype html><html><body>shell</body></html>");
  const store = new Store(dir);
  const config: Config = {
    dataDir: dir, port: 0, origin: ORIGIN, rpId: "hub.example.test", rpName: "Morndo", requireProxyIdentity: false, principalLogin: null,
    tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 60_000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
    fleetSocket: rig.fleet.socketPath,
  };
  let n = 0;
  const passkeys: Passkeys = {
    registrationOptions: async () => ({ challenge: `reg-${++n}` }) as never,
    verifyRegistration: async () => ({ credential: { id: `cred-${++n}`, publicKey: new Uint8Array([1]), counter: 1, transports: [] }, userVerified: true }),
    authenticationOptions: async () => ({ challenge: `auth-${++n}` }) as never,
    verifyAuthentication: async () => ({ userVerified: true, newCounter: ++n }),
  };
  const access = new AccessService(store, passkeys);
  const observation = observationFor(rig.ports, { quietAfterMs: 60_000 });
  const steering = steeringFor(rig.ports, { store, policy: () => access.policy(), waitingOn: id => observation.waitingOn(id), nameOf: id => observation.nameOf(id) });
  const escalations = escalationsFor(rig.ports, {
    store,
    watch: {
      workers: () => observation.snapshot().workers.map(w => ({ id: w.id as string, name: w.name, conflict: observation.conflicted(w.id) })),
      history: id => observation.history(id), openQuestions: id => observation.openQuestions(id), screen: id => observation.screen(id),
    },
  });
  const remote = new RemoteService({ store, terminal: rig.ports.terminal, panes: () => observation.snapshot().workers.map(w => w.id as string), desktop: () => null });
  const http = startHttp({ config, identity: loadOrCreateIdentity(dir), access, observation, steering, escalations, remote });
  await http.ready;
  const base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
  return {
    observation, escalations,
    async cookie() {
      const opts = await access.pairOptions(access.issueConsoleToken().secret, "phone");
      if (!("flowId" in opts)) throw new Error(opts.refused);
      const r = await access.pairVerify(opts.flowId, {} as never);
      if (!("cookieSecret" in r)) throw new Error(r.refused);
      return r.cookieSecret;
    },
    get: path => fetch(base + path),
    post: (path, body, secret) => fetch(base + path, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", cookie: `__Host-morndo=${secret}` }, body: JSON.stringify(body),
    }),
    socket: (path, secret) => new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(base.replace("http", "ws") + path, { headers: { origin: ORIGIN, cookie: `__Host-morndo=${secret}` } });
      ws.on("open", () => resolve(ws));
      ws.on("unexpected-response", (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode ?? "?"}`)));
      ws.on("error", () => {});
    }),
    close: async () => { await http.close(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// The next frame of type `t` on this socket, within 5 s.
function frameOf(ws: WebSocket, t: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const on = (raw: unknown) => {
      const m = JSON.parse(String(raw)) as Record<string, unknown>;
      if (m.t !== t) return;
      clearTimeout(timer);
      ws.off("message", on);
      resolve(m);
    };
    const timer = setTimeout(() => { ws.off("message", on); reject(new Error(`no ${t} frame within 5 s`)); }, 5000);
    ws.on("message", on);
  });
}

let pc: MemoryBackend;
let box: MemoryBackend;
let pcPane: MemoryPane;
let boxPane: MemoryPane;
let rig: FleetRig;
let hub: FleetHub;
let cookie: string;
beforeEach(async () => {
  pcPane = { name: "alpha", cwd: "/w/alpha", screen: BOX };
  boxPane = { name: "beta", cwd: "/w/beta", screen: BOX };
  pc = memoryBackend({ "%1": pcPane });
  box = memoryBackend({ "%1": boxPane });
  pc.typedAt = 1_791_000_000_001;
  box.typedAt = 1_791_000_000_002;
  rig = await fleetRig([localNode("pc", "aaaaaaaa", pc), localNode("box", "bbbbbbbb", box)]);
  hub = await startFleetHub(rig);
  await hub.observation.poll();
  hub.escalations.poll();
  cookie = await hub.cookie();
});
afterEach(async () => { await hub.close(); await rig.close(); });
const sendBody = (text: string, name: string) => ({ text, requestId: randomUUID(), seen: "none", name });
const sentTo = () => rig.fleet.calls.filter(c => c.op === "pane.send").map(c => c.target.workerId);

describe("the hub in fleet mode with two nodes (spec §9)", () => {
  it("lists both workers by worker id, with their node, in the feed's snapshot", async () => {
    const ws = await hub.socket("/api/feed", cookie);
    const snapshot = frameOf(ws, "snapshot");
    ws.send(JSON.stringify({ t: "hello" }));
    const d = decode(ServerFeedFrames, JSON.stringify(await snapshot));
    ws.close();
    if (d.kind !== "ok" || d.frame.t !== "snapshot") throw new Error(`the snapshot decodes as ${d.kind}`);
    expect(d.frame.workers.map(w => ({ id: w.id, name: w.name, node: w.node, location: w.location })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: BOX1, name: "beta", node: "box", location: "beta" },
      { id: PC1, name: "alpha", node: "pc", location: "alpha" },
    ]);
  });

  it("takes a watch of a worker id, and sends that worker's screen", async () => {
    const ws = await hub.socket("/api/feed", cookie);
    let closed: number | null = null;
    ws.on("close", code => { closed = code; });
    const screen = frameOf(ws, "screen");
    ws.send(JSON.stringify({ t: "hello" }));
    ws.send(JSON.stringify({ t: "watch", worker: PC1 }));
    expect(await screen).toMatchObject({ t: "screen", worker: PC1, text: BOX });
    expect(closed).toBeNull();
    ws.close();
  });

  it("steers each node: a send reaches only the pane of the worker it names, with that node's typedAt", async () => {
    const toPc = await hub.post(`/api/workers/${PC1}/send`, sendBody("to the pc", "alpha"), cookie);
    expect(toPc.status).toBe(200);
    expect(await toPc.json()).toEqual({ ok: true, at: 1_791_000_000_001 });
    const toBox = await hub.post(`/api/workers/${encodeURIComponent(BOX1)}/send`, sendBody("to the box", "beta"), cookie);
    expect(await toBox.json()).toEqual({ ok: true, at: 1_791_000_000_002 });
    expect(pc.typed.map(t => t.text)).toEqual(["to the pc"]);
    expect(box.typed.map(t => t.text)).toEqual(["to the box"]);
  });

  it("a legacy %N from an older app's outbox is no pane (404), and nothing is typed anywhere", async () => {
    const r = await hub.post("/api/workers/%251/send", sendBody("from an older app", "alpha"), cookie);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "no_pane" });
    expect(sentTo()).toEqual([]);
    expect([...pc.typed, ...box.typed]).toEqual([]);
  });

  it("route matching: a worker id percent-encoded is the same worker; malformed or foreign ids are no route, never a 500", async () => {
    const encoded = await hub.post(`/api/workers/${PC1.replaceAll(".", "%2E")}/send`, sendBody("encoded dots", "alpha"), cookie);
    expect(encoded.status).toBe(200);
    for (const path of ["/api/workers/%/send", "/api/workers/..%2F..%2Fetc/send", "/api/workers/PC.aaaaaaaa.1/send", "/api/workers/pc.aaaaaaaa.1.2/send",
      "/api/workers/main:0/send", "/api/workers/pc_aaaaaaaa_1/send", "/api/workers/pc.aaaaaaaa.1%00/send", "/api/nope/%"]) {
      const r = await hub.post(path, sendBody("never", "alpha"), cookie);
      expect([path, r.status, await r.json()]).toEqual([path, 404, { error: "no such route" }]);
    }
    expect(sentTo()).toEqual([PC1]);
    expect(pc.typed.map(t => t.text)).toEqual(["encoded dots"]);
  });

  it("a page path that doesn't decode is never a 500: the app shell answers it, and an escaped slash finds no file", async () => {
    for (const path of ["/%", "/%E0%A4%A", "/a%2F..%2F..%2F200.html", "/..%2F..%2Fetc%2Fpasswd"]) {
      const r = await hub.get(path);
      expect([path, r.status, await r.text()]).toEqual([path, 200, "<!doctype html><html><body>shell</body></html>"]);
    }
  });

  it("opens a worker id's terminal (the ?pane= route) and streams that node's frame", async () => {
    const ws = await hub.socket(`/api/terminal?pane=${encodeURIComponent(BOX1)}`, cookie);
    const frame = await frameOf(ws, "frame");
    ws.close();
    expect(frame.lines).toEqual(["──────", "❯ "]);
  });

  it("menus on both nodes' %1 are two asks with two ids, and the answer route takes them", async () => {
    pcPane.screen = MENU;
    boxPane.screen = MENU;
    await hub.observation.poll();
    hub.escalations.poll();
    expect(hub.escalations.board().items.map(i => i.id).sort()).toEqual(["menu-box_bbbbbbbb_1", "menu-pc_aaaaaaaa_1"]);
    const r = await hub.post("/api/escalations/menu-pc_aaaaaaaa_1/answer", { key: "1", requestId: randomUUID() }, cookie);
    expect(r.status).toBe(409);                                         // routed, and answered on the worker's own screen
    expect(await r.json()).toMatchObject({ error: "on_screen", item: { id: "menu-pc_aaaaaaaa_1", asker: { workerId: PC1 } } });
  });
});
