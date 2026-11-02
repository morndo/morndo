// When the node agent drops a sign-in session, the hub ends its copy (ADR-0039).
import { describe, expect, it } from "vitest";
import type { Endpoint, EndpointId, Session, SessionId } from "@morndo/domain";
import type { OpError } from "@morndo/protocol";
import { SignInService, type SignInFleet } from "../src/application/signin-service.ts";

const NOW = 1_800_000_000_000;
const session = (verifiedAt: number): Session => ({
  id: "s" as SessionId, endpointId: "e" as EndpointId, startedAt: NOW, lastSeenAt: NOW, verifiedAt, endedAt: null, endReason: null,
});
const who = { session: session(NOW - 60_000), endpoint: { id: "e" as EndpointId } as Endpoint };
const lost: OpError = { code: "no_session", executed: "no", message: "gone" };

describe("a sign-in the node no longer holds", () => {
  it("ends as failed on status, lets cancel succeed, and allows a fresh start", async () => {
    let statusCalls = 0;
    const fleet: SignInFleet = {
      nodes: async () => ["n1"],
      op: (async (_node: string, op: string) => {
        if (op === "signin.start") {
          return {
            ok: true,
            result: {
              link: "https://claude.com/cai/oauth/authorize?x=1", userCode: null, needsCode: true, recipient: "age1x",
              expiresAt: NOW + 600_000,
            },
          };
        }
        if (op === "signin.status") {
          statusCalls++;
          return statusCalls === 1 ? { ok: true, result: { phase: "waiting", identity: null, problem: null } }
            : { ok: false, error: lost };
        }
        if (op === "signin.cancel") return { ok: false, error: lost };
        return { ok: true, result: {} };
      }) as SignInFleet["op"],
    };
    const service = new SignInService({ fleet, now: () => NOW, audit: () => {}, newId: (() => { let n = 0; return () => `si-lost${++n}`; })() });
    const first = await service.start(who, { node: "n1", runtime: "claude", account: "a1", create: false });
    if (!first.ok) throw new Error(first.problem);
    await service.view(first.view.id);
    expect((await service.view(first.view.id))).toMatchObject({ ok: true, view: { phase: "failed", problem: "node_lost" } });
    expect(await service.cancel(who, first.view.id)).toMatchObject({ ok: true, view: { phase: "failed", problem: "node_lost" } });
    const again = await service.start(who, { node: "n1", runtime: "claude", account: "a1", create: false });
    if (!again.ok) throw new Error(again.problem);
    expect(again.view.id).not.toBe(first.view.id);
  });
});
