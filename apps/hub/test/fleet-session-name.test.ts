// The Details "Session" name is the same in both modes (spec §9, §10): the session's name from Claude Code's session
// registry (~/.claude/sessions/<pid>.json), never the pane's terminal title, which Claude Code sets to "✳ <task>". One
// pane on an isolated tmux server (`tmux -L test-<uuid>`) titles itself so with OSC 0; a synthetic registry entry under a
// temp HOME names its session "playground-55". The hub reads it in legacy mode (its own registry), in fleet mode over the
// real agent's ops (inventory.get through the executor), and through the fake fleet its suites use. Synthetic data only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sessionRegistry, tmuxAdapter } from "@morndo/node-ops";
import { isolatedTmux, type TestTmux } from "../../../packages/node-ops/test/isolated-tmux.ts";
import { tempHome, until } from "../../node-agent/test/helpers.ts";
import { opsHarness, type Harness } from "../../node-agent/test/ops-harness.ts";
import { fleetPorts } from "../src/adapters/fleet-adapters.ts";
import type { FleetClient } from "../src/adapters/fleet-client.ts";
import { localSessions, localTmux } from "../src/adapters/local-node.ts";
import { ObservationService } from "../src/application/observation-service.ts";
import { localNode } from "./helpers/fake-fleet.ts";
import { fleetRig } from "./helpers/hub-mode.ts";

const SHELL = "bash --norc --noprofile";
let t: TestTmux;
let home: { home: string; cleanup: () => void };
let h: Harness | undefined;
const saved = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
beforeAll(() => { delete process.env.TMUX; delete process.env.TMUX_PANE; t = isolatedTmux(); home = tempHome("session-name-"); });
afterAll(async () => {
  h?.close(); await t.kill(); home.cleanup();
  if (saved.TMUX !== undefined) process.env.TMUX = saved.TMUX;
  if (saved.TMUX_PANE !== undefined) process.env.TMUX_PANE = saved.TMUX_PANE;
});

it("the Details session name is the registry's in legacy and fleet mode, never the pane's title", async () => {
  t.tmux("new-session", "-d", "-s", "main", "-n", "alpha", "-x", "120", "-y", "30", SHELL);
  const pane = t.tmux("list-panes", "-s", "-t", "=main", "-F", "#{pane_id}").trim();
  const win = t.tmux("display-message", "-p", "-t", pane, "#{window_id}").trim();
  t.tmux("send-keys", "-t", pane, "-l", "printf '\\033]0;\\342\\234\\263 Fix login tests\\007'");
  t.tmux("send-keys", "-t", pane, "Enter");
  expect(await until(() => t.tmux("display-message", "-p", "-t", pane, "#{pane_title}").includes("Fix login tests"))).toBe(true);
  const dir = join(home.home, ".claude", "sessions");
  mkdirSync(dir, { recursive: true });
  const sessionId = "0b7e9a52-1111-4222-8333-944455556666";
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId, cwd: "/w/alpha", version: "2.1.292", name: "playground-55", nameSource: "derived",
    tmux: `main:${win}.${pane}`, updatedAt: Date.now(),
  }));

  // Legacy: the hub's own registry and tmux (local-ports.ts).
  const legacy = new ObservationService(localTmux(tmuxAdapter({ socket: t.socket, session: "main" })), 60_000, Date.now,
    { sessions: localSessions(sessionRegistry(join(home.home, ".claude"))) });
  await legacy.poll();
  expect(legacy.session(pane)).toMatchObject({ sessionId, name: "playground-55" });

  // Fleet: the real agent's ops (Inventory over listPanes, the same registry), reached as the fleet would reach them.
  h = opsHarness({ home: home.home, socket: t.socket, node: "pc" });
  const agent = h;
  const client = {
    async nodes() { return [{ name: "pc", status: "online", health: null, agent: "0.0.0" }]; },
    async lanes() { return [{ name: "alpha", node: "pc", workerId: null, conflict: false }]; },
    async op(_target: unknown, op: string, args: unknown) {
      const r = await agent.call(op, args);
      return r.ok ? { ok: true, result: r.result, invVersion: r.invVersion, store: "st", storeSeq: 0 } : { ok: false, error: r.error, store: "st", storeSeq: 0 };
    },
    events() { return () => {}; },
  } as unknown as FleetClient;
  const ports = fleetPorts(client, { files: null, stagingDir: join(home.home, "staging") });
  const fleet = new ObservationService(ports.tmux, 60_000, Date.now, { sessions: ports.sessions, nodeStates: ports.nodeStates });
  await fleet.poll();
  expect(fleet.session(fleet.snapshot().workers[0]?.id as string)).toMatchObject({ sessionId, name: "playground-55" });
  ports.stop();

  // The fake fleet the hub's dual-mode suites use says the same.
  const rig = await fleetRig([localNode("pc", "aaaaaaaa", {
    tmux: localTmux(tmuxAdapter({ socket: t.socket, session: "main" })), sessions: localSessions(sessionRegistry(join(home.home, ".claude"))),
  })]);
  try {
    await rig.ports.tmux.listWorkers();
    expect([...(await rig.ports.sessions.byPane()).values()][0]?.name).toBe("playground-55");
  } finally { await rig.close(); }
});
