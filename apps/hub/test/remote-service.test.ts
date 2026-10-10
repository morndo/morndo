// Who may watch and who may control (AC9), on synthetic sessions. And, through the port, a watcher gets the worker's
// frames and a controller's keys reach that worker's pane only. Both configurations (spec §9): in fleet mode the terminal
// sits behind the fake fleet, and the worker is named by its worker id.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import type { Terminal } from "@morndo/node-ops";
import { Store } from "../src/adapters/store.ts";
import type { Tmux } from "../src/application/ports.ts";
import { RemoteService } from "../src/application/remote-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { HUB_MODES, portsFor, type ModePorts } from "./helpers/hub-mode.ts";

const T0 = Date.UTC(2026, 9, 1, 8);
const FRAME = { cols: 80, rows: 1, x: 2, y: 0, cursor: true, lines: ["$ "] };
let now = T0;
let dir: string;
let store: Store;
const auth = (verifiedAt: number, id = "s1"): Authenticated => ({
  session: { id: sessionId(id), endpointId: endpointId("ep1"), startedAt: T0 - 3_600_000 * 3, lastSeenAt: now, verifiedAt, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
});

beforeEach(() => { now = T0; dir = mkdtempSync(join(tmpdir(), "morndo-remote-")); store = new Store(dir); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe.each(HUB_MODES)("watching and control, %s hub", mode => {
  let ports: ModePorts;
  let keys: { pane: string; data: string }[];
  beforeEach(async () => {
    keys = [];
    const tmux: Tmux = {
      listWorkers: async () => [{ id: "%3", name: "builder", location: "w", node: "local", offline: false }],
      capture: async () => "$ ",
      captureMany: async ids => new Map(ids.map(id => [id, "$ "])),
      send: async () => ({ problem: null, typedAt: 0 }),
    };
    const terminal: Terminal = {
      frame: async id => (id === "%3" ? FRAME : null),
      keys: async (id, data) => { if (id !== "%3") return false; keys.push({ pane: id, data }); return true; },
    };
    ports = await portsFor(mode, { tmux, terminal });
  });
  afterEach(async () => { await ports.close(); });
  const service = (desktop = true) => new RemoteService({
    store, terminal: ports.terminal, panes: () => [ports.id("%3")], now: () => now,
    desktop: () => (desktop ? { host: "127.0.0.1", port: 5901, password: "x" } : null),
  });

  it("anyone signed in may watch; control needs a fresh passkey check (AC7, AC9)", () => {
    const r = service();
    const stale = auth(T0 - 2 * 3_600_000);
    expect(r.open(stale, { kind: "desktop" }, false).ok).toBe(true);
    expect(r.open(stale, { kind: "desktop" }, true)).toEqual({ ok: false, refused: "step_up" });
    const c = r.open(auth(T0), { kind: "terminal", workerId: ports.id("%3") }, true);
    expect(c.ok && c.viewer.grant !== null).toBe(true);
    expect(store.audit(5).map(a => a.type)).toEqual(["ControlStarted"]);
  });
  it("only known panes, and the desktop only when it is configured", () => {
    expect(service().open(auth(T0), { kind: "terminal", workerId: ports.id("%99") }, false)).toEqual({ ok: false, refused: "no_pane" });
    expect(service(false).open(auth(T0), { kind: "desktop" }, false)).toEqual({ ok: false, refused: "no_desktop" });
  });
  it("control lapses when the passkey check gets stale; ending it is recorded (never the input)", () => {
    const r = service();
    const a = auth(T0);
    const c = r.open(a, { kind: "desktop" }, true);
    if (!c.ok) throw new Error(c.refused);
    expect(r.holds(c.viewer, a)).toBe("ok");
    now = T0 + 3_600_000;
    expect(r.holds(c.viewer, a)).toBe("lapsed");
    expect(r.holds(c.viewer, null)).toBe("ended");
    expect(r.holds(c.viewer, auth(T0, "s2"))).toBe("ended");          // another session can't take over the connection
    r.closed(c.viewer, "lapsed");
    expect(store.audit(5).map(a => a.type)).toEqual(["ControlEnded", "ControlStarted"]);
    expect(store.audit(1)[0]?.body).toMatchObject({ reason: "lapsed", target: { kind: "desktop" } });
  });
  it("a watcher gets that worker's frames, and keys under control reach that pane only", async () => {
    const r = service();
    expect(await r.terminal.frame(ports.id("%3"))).toEqual(FRAME);
    expect(await r.terminal.frame(ports.id("%99"))).toBeNull();
    expect(await r.terminal.keys(ports.id("%3"), "ls\r")).toBe(true);
    expect(await r.terminal.keys(ports.id("%99"), "rm -rf /tmp/x\r")).toBe(false);
    expect(keys).toEqual([{ pane: "%3", data: "ls\r" }]);
  });
});
