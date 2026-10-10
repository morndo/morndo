// The legacy set of ports (fleet core §10): this machine's tmux and Claude Code as the one node "local" (local-node.ts),
// with no fleet to ask about a send in doubt or about which nodes answer; and the desktop MORNDO_VNC names, which a hub
// offers with or without a fleet (spec §16.1). A tmux server name nobody runs, a temp Claude config dir and a fake file store:
// never the owner's tmux or ~/.claude.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { desktopTarget, legacyPorts } from "../src/adapters/local-ports.ts";
import { Store } from "../src/adapters/store.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { RemoteService } from "../src/application/remote-service.ts";
import { loadConfig } from "../src/config.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-legacy-ports-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const config = (claudeDir: string) => loadConfig({ MORNDO_HOME: join(dir, "data"), MORNDO_TMUX_SOCKET: `test-${randomUUID()}`, MORNDO_CLAUDE_DIR: claudeDir });
const files = (asked: string[]) => ({ register: async (path: string) => { asked.push(path); return { id: "a".repeat(32), size: 3 }; } });

describe("legacyPorts", () => {
  it("has no fleet to ask: no send status and no node states", () => {
    const p = legacyPorts(config("off"), { files: files([]) });
    expect([p.sendStatus, p.nodeStates]).toEqual([null, null]);
  });
  it("this machine's tmux, on its own server: none running under that name, so no workers and no frame", async () => {
    const p = legacyPorts(config("off"), { files: files([]) });
    expect(await p.tmux.listWorkers()).toEqual([]);
    expect(await p.terminal.frame("%1")).toBeNull();
  });
  it("conversations only with a Claude config dir: none for \"off\", the registry's sessions for a directory", async () => {
    expect(legacyPorts(config("off"), { files: files([]) }).sessions).toBeNull();
    mkdirSync(join(dir, "claude", "sessions"), { recursive: true });
    writeFileSync(join(dir, "claude", "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s1", tmux: "qa:@0.%1", name: "builder", cwd: "/w", version: "2.1.286", updatedAt: 1 }));
    const p = legacyPorts(config(join(dir, "claude")), { files: files([]) });
    expect([...((await p.sessions?.byPane()) ?? new Map()).keys()]).toEqual(["%1"]);
    expect(await p.transcripts?.size("s1")).toBeNull();                        // no transcript file yet
  });
  it("an attached image is staged at its inbox path; a worker's file goes to the hub's store by its path", async () => {
    const asked: string[] = [];
    const p = legacyPorts(config("off"), { files: files(asked) });
    const upload = { id: "u1", endpointId: endpointId("ep1"), path: join(dir, "inbox", "pasted-1.png"), mime: "image/png" as const, size: 4, at: 1 };
    expect(await p.uploads.stage(upload, "%1")).toEqual({ ok: true, path: upload.path });
    expect(await p.files.register("%1", "/w/out.png")).toEqual({ id: "a".repeat(32), size: 3 });
    expect(asked).toEqual(["/w/out.png"]);
  });
});

describe("the desktop", () => {
  it("is the VNC MORNDO_VNC names; without it there is none, so it is no_desktop", () => {
    const c = loadConfig({ MORNDO_HOME: join(dir, "data"), MORNDO_VNC: "127.0.0.1:5901", MORNDO_VNC_PASSWORD_FILE: join(dir, "no-such-file") });
    const off = loadConfig({ MORNDO_HOME: join(dir, "data") });
    expect(desktopTarget(c)()).toEqual({ host: "127.0.0.1", port: 5901, password: null });
    expect(desktopTarget(off)()).toBeNull();
    const store = new Store(join(dir, "store"));
    try {
      const at = Date.now();
      const a: Authenticated = {
        session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: at, lastSeenAt: at, verifiedAt: at, endedAt: null, endReason: null },
        endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: at, revokedAt: null },
      };
      const remote = (cfg: typeof c) => new RemoteService({ store, terminal: legacyPorts(cfg, { files: files([]) }).terminal, panes: () => [], desktop: desktopTarget(cfg) });
      expect(remote(off).open(a, { kind: "desktop" }, false)).toEqual({ ok: false, refused: "no_desktop" });
      expect(remote(c).open(a, { kind: "desktop" }, false).ok).toBe(true);
    } finally { store.close(); }
  });
});
