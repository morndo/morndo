// A role save on the hub asks for step-up, then calls the connections commands. It has no engine CLI.
import { describe, expect, it } from "vitest";
import type { Endpoint, EndpointId, Session, SessionId } from "@morndo/domain";
import type { ConnectionsPage } from "@morndo/protocol";
import { ConnectionsPageService, type ConnectionCommands } from "../src/application/connections-page.ts";

const now = 1_700_000_000_000;
const session = (verifiedAt: number): Session => ({
  id: "s" as SessionId, endpointId: "e" as EndpointId, startedAt: now, lastSeenAt: now, verifiedAt, endedAt: null, endReason: null,
});
const page = { version: 1, connections: [], mode: "keys-only" as const, order: [], roles: [], alerts: [], catalog: [] };

describe("hub connection commands", () => {
  it("refuses a role save without a fresh passkey and never calls the command", async () => {
    const calls: string[] = [];
    const commands: ConnectionCommands = {
      page: async () => page as ConnectionsPage,
      priority: async () => ({ ok: true }),
      role: async () => { calls.push("role"); return { ok: true }; },
      revoke: async () => ({ ok: true }),
      narrow: async () => { calls.push("narrow"); return { ok: true }; },
    };
    const service = new ConnectionsPageService(commands, () => ({ stay: "12h", stepUp: "10m" }), () => now);
    const who = { session: session(0), endpoint: {} as Endpoint };
    expect(await service.run(who, "role", { version: 1, role: "implement", override: "own", order: [], picks: [], action: "save" })).toEqual({ ok: false, problem: "step_up" });
    expect(calls).toEqual([]);
    expect((await service.run(who, "narrow", { version: 1, name: "key-a", action: "off" })).ok).toBe(true);
    expect(calls).toEqual(["narrow"]);
    expect((await service.run({ session: session(now), endpoint: {} as Endpoint }, "role", { version: 1, role: "implement", override: "follow", order: [], picks: [], action: "save" })).ok).toBe(true);
    expect(calls).toEqual(["narrow", "role"]);
  });
});