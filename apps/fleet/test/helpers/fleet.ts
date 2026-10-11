// A real fleet service in this process for the tests: port 0, its key, database and socket in a temporary directory,
// stopped after each test. `joined(name)` registers a node through a real join and returns its fake agent. Every test
// connects from 127.0.0.1, many times: the handshake bucket is wide here unless a test passes its own
// (handshakeLimits; agent-auth.test.ts tests the real one).
import { join } from "node:path";
import { afterEach } from "vitest";
import type { FleetConfig } from "../../src/config.ts";
import { createLogger } from "../../src/adapters/log.ts";
import type { BucketConfig } from "../../src/adapters/rate-limit.ts";
import { startFleet, type Fleet, type FleetOptions } from "../../src/serve.ts";
import { FakeAgent, type AgentKey } from "./fake-agent.ts";
import { tempDir } from "./temp.ts";

export type TestFleet = Fleet & {
  dir: string;
  agentUrl: string;
  code(name: string): string;
  agent(o?: { node?: string; key?: AgentKey; instanceId?: string; streamId?: string }): FakeAgent;
  joined(name: string, o?: { instanceId?: string; streamId?: string }): Promise<FakeAgent>;
  online(name: string, o?: { instanceId?: string; streamId?: string }): Promise<FakeAgent>;
};

const running = new Set<Fleet>();
const agents = new Set<FakeAgent>();
afterEach(async () => {
  for (const a of agents) a.terminate();
  agents.clear();
  for (const f of running) await f.close();
  running.clear();
});

export const quiet = createLogger({ level: "error", sink: () => {} });
export const WIDE: BucketConfig = { capacity: 100_000, refillPerSecond: 100_000 };

export function testConfig(dir: string, over: Partial<FleetConfig> = {}): FleetConfig {
  return {
    listen: { host: "127.0.0.1", port: 0 }, socketPath: join(dir, "s", "f.sock"), dbPath: join(dir, "fleet.db"),
    keyPath: join(dir, "key.pem"), publicUrl: "ws://127.0.0.1:8791/agent", subscribers: [], stickyLanes: ["manager"],
    laneEvents: { deliverTo: null, header: "[lane-event] Lane events (handle them as your instructions say):", ignore: [], batchMs: 3000 }, ...over,
  };
}

export async function startTestFleet(o: FleetOptions & { dir?: string; config?: Partial<FleetConfig> } = {}): Promise<TestFleet> {
  const dir = o.dir ?? tempDir();
  const fleet = await startFleet(testConfig(dir, o.config), { log: quiet, handshakeLimits: WIDE, holdPath: join(dir, "hold.json"), ...o });
  running.add(fleet);
  const close = () => fleet.close();
  const agentUrl = `ws://127.0.0.1:${fleet.agentPort}/agent`;
  const t: TestFleet = {
    ...fleet,
    close: async () => { if (running.delete(fleet)) await close(); },
    dir,
    agentUrl,
    code: name => { const r = fleet.nodes.issueCode(name); if (!r.ok) throw new Error(r.refused); return r.code; },
    agent: (a = {}) => { const fa = new FakeAgent({ url: agentUrl, fleetKey: fleet.key.publicKey, ...a }); agents.add(fa); return fa; },
    joined: async (name, a = {}) => {
      const fa = t.agent(a);
      const r = await fa.join(name, t.code(name));
      if (!r.welcome) throw new Error(`join refused: ${r.closed.code} ${r.closed.reason}`);
      return fa;
    },
    online: async (name, a = {}) => {
      const fa = await t.joined(name, a);
      const r = await fa.connect();
      if (!r.ok) throw new Error(`connect refused: ${r.closed.code} ${r.closed.reason}`);
      return fa;
    },
  };
  return t;
}
