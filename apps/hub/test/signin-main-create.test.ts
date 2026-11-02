// The hub never adds the default "main" home (ADR-0039): create:true with account main is refused before any fleet op.
import { describe, expect, it } from "vitest";
import type { Endpoint, EndpointId, Session, SessionId } from "@morndo/domain";
import { SignInService, type SignInFleet } from "../src/application/signin-service.ts";

const NOW = 1_800_000_000_000;
const session = (verifiedAt: number): Session => ({
  id: "s" as SessionId, endpointId: "e" as EndpointId, startedAt: NOW, lastSeenAt: NOW, verifiedAt, endedAt: null, endReason: null,
});
const who = { session: session(NOW - 60_000), endpoint: { id: "e" as EndpointId } as Endpoint };

describe("sign-in refuses to add the main account", () => {
  it("refuses start and agent request with create:true and account main, with no fleet op", async () => {
    const calls: string[] = [];
    const fleet: SignInFleet = {
      nodes: async () => ["n1"],
      op: (async (_node, op) => { calls.push(op); return { ok: true, result: {} }; }) as SignInFleet["op"],
    };
    const service = new SignInService({ fleet, now: () => NOW, audit: () => {} });
    expect(await service.start(who, { node: "n1", runtime: "claude", account: "main", create: true })).toEqual({ ok: false, problem: "bad_account" });
    expect(service.request({ node: "n1", runtime: "claude", account: "main", create: true, why: "pool" }, "manager")).toEqual({ ok: false, problem: "bad_account" });
    expect(calls).toEqual([]);
  });
});
