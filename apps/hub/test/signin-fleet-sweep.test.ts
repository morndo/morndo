// Sign-in sweep must not reject when the fleet is unreachable (ADR-0039).
import { describe, expect, it } from "vitest";
import type { FleetClient } from "@morndo/fleet-client";
import type { Endpoint, EndpointId, Session, SessionId } from "@morndo/domain";
import { signinFleet } from "../src/adapters/fleet-adapters.ts";
import { SignInService } from "../src/application/signin-service.ts";

const NOW = 1_800_000_000_000;
const session = (verifiedAt: number): Session => ({
  id: "s" as SessionId, endpointId: "e" as EndpointId, startedAt: NOW, lastSeenAt: NOW, verifiedAt, endedAt: null, endReason: null,
});
const who = { session: session(NOW - 60_000), endpoint: { id: "e" as EndpointId } as Endpoint };

describe("sign-in when the fleet is unreachable", () => {
  it("sweep resolves and start answers node_offline", async () => {
    const client = {
      nodes: async () => { throw new Error("down"); },
      op: async () => { throw new Error("down"); },
    } as unknown as FleetClient;
    const service = new SignInService({ fleet: signinFleet(client), now: () => NOW, audit: () => {} });
    await expect(service.sweep()).resolves.toBeUndefined();
    expect(await service.start(who, { node: "n1", runtime: "claude", account: "a1", create: false })).toEqual({ ok: false, problem: "node_offline" });
  });
});
