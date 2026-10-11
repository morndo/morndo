// A real hub HTTP server (startHttp) in a child process, for inputs that might kill the process: the vitest worker
// survives, and the test asserts on what the hub still answers. Synthetic services, a temp data dir, one device paired
// with a fake passkey (so a signed-in cookie exists), no tmux. `node http-crash-fixture.ts <dir>` is the child.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { WebSocket, type RawData } from "ws";
import type { Passkeys } from "../src/adapters/passkeys.ts";
import type { Config } from "../src/config.ts";

export const LOGIN = "principal@example.test";
export const ORIGIN = "https://hub.example.test";
const SELF = fileURLToPath(import.meta.url);

export type Hub = {
  base: string; port: number; cookie: string;
  // The child's exit code once it has exited, else null; `output` is everything it wrote (the crash's stack, if any).
  exitCode: () => number | null; output: () => string; stop: () => Promise<void>;
};

// How the child's synthetic terminal misbehaves: "keys-throw" rejects every key press, "frame-throw" every frame after
// the first, "keys-slow-first" takes 300 ms over the first key press and prints each one (KEYS <data>) as it lands, as
// a tmux slowed by a busy machine would; "keys-uncertain" answers every key press "uncertain", as a fleet node whose
// answer was lost does (Task 14); "frame-unavailable" gives one frame, then "unavailable" five times (its node can't
// answer now), then another frame four times, then null (the pane gone), as a fleet node that drops out and comes back
// does (final review M5); "frame-offline" gives one frame, then "unavailable" for 2.5 s, then another frame for 1.5 s,
// then null, and prints each time it is asked (FRAME <ms since the first>), as a node offline for a while does;
// "ok" (the default) does none of that.
export type Variant = "ok" | "keys-throw" | "frame-throw" | "keys-slow-first" | "keys-uncertain" | "frame-unavailable" | "frame-offline";

// Starts the child and waits for it to print its port and the paired device's cookie secret.
export async function startHub(variant: Variant = "ok"): Promise<Hub> {
  const dir = mkdtempSync(join(tmpdir(), "morndo-crash-"));
  // stdin a pipe the child watches: if this test process dies (a timeout kills its worker), the child ends too, instead
  // of a hub left running for hours (seven were found after a day of runs).
  const child = spawn(process.execPath, ["--no-warnings", SELF, dir, variant], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let code: number | null = null;
  const exited = new Promise<void>(resolve => child.on("exit", c => { code = c ?? -1; resolve(); }));
  child.stderr.on("data", d => { out += String(d); });
  const ready = await new Promise<{ port: number; cookie: string }>((resolve, reject) => {
    child.stdout.on("data", d => {
      out += String(d);
      const line = out.split("\n").find(l => l.startsWith("{\"port\""));
      if (line) resolve(JSON.parse(line));
    });
    void exited.then(() => reject(new Error(`hub fixture exited before it listened:\n${out}`)));
  }).catch(e => { rmSync(dir, { recursive: true, force: true }); throw e; });
  return {
    base: `http://127.0.0.1:${ready.port}`, port: ready.port, cookie: ready.cookie,
    exitCode: () => code, output: () => out,
    stop: async () => {
      if (code === null) { child.kill("SIGKILL"); await exited; }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The headers a browser behind the proxy sends with a signed-in WebSocket upgrade.
export const signedIn = (hub: Hub) => ({ "tailscale-user-login": LOGIN, origin: ORIGIN, cookie: `__Host-morndo=${hub.cookie}` });

// GET /api/identity: the hub still answers (0: nothing listens any more).
export const identityStatus = async (hub: Hub) => {
  try { return (await fetch(hub.base + "/api/identity", { headers: { "tailscale-user-login": LOGIN } })).status; }
  catch { return 0; }
};

// A signed-in WebSocket on `path`, open; with `firstMessage`, also waits for the hub's first message.
export const openSocket = (hub: Hub, path: string, firstMessage = false) => new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(hub.base.replace("http", "ws") + path, { headers: signedIn(hub) });
  ws.on("unexpected-response", (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
  ws.on("error", () => {});
  if (firstMessage) ws.once("message", () => resolve(ws));
  else ws.on("open", () => resolve(ws));
});

// As openSocket, with every message kept from the moment the socket exists: the hub sends a terminal's first frame as
// soon as it connects, and ws can deliver it in the same tick as "open", before a listener added after the await
// (CI: a view's first frame was missed).
export const openCollecting = (hub: Hub, path: string) => new Promise<{ ws: WebSocket; messages: string[] }>((resolve, reject) => {
  const ws = new WebSocket(hub.base.replace("http", "ws") + path, { headers: signedIn(hub) });
  const messages: string[] = [];
  ws.on("message", d => messages.push(frameText(d)));
  ws.on("unexpected-response", (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
  ws.on("error", () => {});
  ws.on("open", () => resolve({ ws, messages }));
});

// A text frame as ws delivers it (a Buffer, or chunks of one).
export const frameText = (d: RawData) => (Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d as ArrayBuffer)).toString("utf8");

// Resolves on the socket's next message or its close, whichever comes first: the hub has dealt with what it was sent.
export const nextOutcome = (ws: WebSocket) => new Promise<string>(resolve => {
  ws.once("message", d => resolve(`message ${frameText(d).slice(0, 40)}`));
  ws.once("close", code => resolve(`close ${code}`));
});

async function child(dir: string, variant: Variant) {
  const { Store } = await import("../src/adapters/store.ts");
  const { loadOrCreateIdentity } = await import("../src/adapters/identity.ts");
  const { startHttp } = await import("../src/adapters/http.ts");
  const { AccessService } = await import("../src/application/access-service.ts");
  const { ObservationService } = await import("../src/application/observation-service.ts");
  const { SteeringService } = await import("../src/application/steering-service.ts");
  const { EscalationService } = await import("../src/application/escalation-service.ts");
  const { RemoteService } = await import("../src/application/remote-service.ts");
  const web = join(dir, "web");
  mkdirSync(web);
  writeFileSync(join(web, "200.html"), "<!doctype html><html><head><script>boot()</script></head><body>shell</body></html>");
  const store = new Store(dir);
  const config: Config = {
    dataDir: dir, port: 0, origin: ORIGIN, rpId: "hub.example.test", rpName: "Morndo",
    requireProxyIdentity: true, principalLogin: LOGIN, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 1000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
  let n = 0;
  const fakePasskeys: Passkeys = {
    registrationOptions: async () => ({ challenge: `reg-${++n}` }) as never,
    verifyRegistration: async () => ({ credential: { id: `cred-${++n}`, publicKey: new Uint8Array([1]), counter: 1, transports: [] }, userVerified: true }),
    authenticationOptions: async () => ({ challenge: `auth-${++n}` }) as never,
    verifyAuthentication: async () => ({ userVerified: true, newCounter: ++n }),
  };
  const access = new AccessService(store, fakePasskeys);
  const opts = await access.pairOptions(access.issueConsoleToken().secret, "test phone");
  if (!("flowId" in opts)) throw new Error(`pairing refused: ${opts.refused}`);
  const paired = await access.pairVerify(opts.flowId, {} as never);
  if (!("cookieSecret" in paired)) throw new Error(`pairing refused: ${paired.refused}`);
  const tmux = { listWorkers: async () => [], capture: async () => null, captureMany: async () => new Map<string, string | null>(), send: async () => ({ problem: null, typedAt: Date.now() }) };
  const escalations = new EscalationService({
    watch: { workers: () => [], history: () => [], openQuestions: () => [], screen: () => undefined },
    ledger: null, store, managerName: "manager", send: async () => ({ problem: null, typedAt: 0 }),
  });
  const frame = { cols: 80, rows: 24, x: 0, y: 0, cursor: true, lines: ["$ "] };
  let frames = 0, keyCalls = 0, firstFrameAt = 0, backAsks = 0;
  const terminal = {
    frame: async (): Promise<typeof frame | null | "unavailable"> => {
      if (variant === "frame-throw" && frames++ > 0) throw new Error("tmux: no server running");
      if (variant === "frame-unavailable") {
        const n = frames++;
        return n === 0 ? frame : n <= 5 ? "unavailable" : n <= 9 ? { ...frame, lines: ["$ back"] } : null;
      }
      if (variant === "frame-offline") {
        // Offline for 2.5 s by the clock; back for the next eight asks by count, so a slow machine whose backed-off
        // asks land late still sees the node come back and the view go back to every 80 ms (CI run 37696079615).
        if (frames++ === 0) firstFrameAt = performance.now();
        const t = Math.round(performance.now() - firstFrameAt);
        const phase = t === 0 ? "first" : t < 2500 && backAsks === 0 ? "offline" : backAsks++ < 8 ? "back" : "gone";
        console.log(`FRAME ${t} ${phase}`);
        return phase === "first" ? frame : phase === "offline" ? "unavailable" : phase === "back" ? { ...frame, lines: ["$ back"] } : null;
      }
      return frame;
    },
    keys: async (_id: string, data: string): Promise<boolean | "uncertain"> => {
      if (variant === "keys-throw") throw new Error("tmux: can't find pane");
      if (variant === "keys-uncertain") return "uncertain";
      if (variant === "keys-slow-first") { if (keyCalls++ === 0) await new Promise(r => setTimeout(r, 300)); console.log(`KEYS ${data}`); }
      return true;
    },
  };
  const remote = new RemoteService({ store, terminal, panes: () => ["%1"], desktop: () => null });
  const http = startHttp({
    config, identity: loadOrCreateIdentity(dir), access, observation: new ObservationService(tmux, 1000),
    steering: new SteeringService(store, tmux, Date.now, undefined, null, () => "none"), escalations, remote,
  });
  await http.ready;
  process.stdout.write(`${JSON.stringify({ port: (http.server.address() as AddressInfo).port, cookie: paired.cookieSecret })}\n`);
}

if (process.argv[1] === SELF) {
  process.stdin.on("end", () => process.exit(0));                       // the test process is gone
  process.stdin.resume();
  await child(process.argv[2] ?? "", (process.argv[3] ?? "ok") as Variant);
}
