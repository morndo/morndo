// A sign-in card the hub holds (tracking "hub") stays open until its TTL unless a sighting settles it (domain E14). So a
// card whose account works again is offered as settled, "Works again", for a while, and asks() no longer has it (ADR-0039).
import { describe, expect, it } from "vitest";
import type { Endpoint, EndpointId, Session, SessionId } from "@morndo/domain";
import { SignInService, type SignInFleet } from "../src/application/signin-service.ts";

const NOW = 1_800_000_000_000;
const session: Session = { id: "s" as SessionId, endpointId: "e" as EndpointId, startedAt: NOW, lastSeenAt: NOW, verifiedAt: NOW, endedAt: null, endReason: null };
const who = { session, endpoint: {} as Endpoint };

describe("settling a sign-in card", () => {
  it("offers a card whose account works again as settled, for 10 minutes, and re-raises it if it signs out again", async () => {
    let t = NOW;
    let a1 = "missing";
    let phase = "waiting";
    const fleet: SignInFleet = {
      nodes: async () => ["n1"],
      op: (async (_node: string, op: string) => ({
        ok: true,
        result: op === "signin.accounts" ? { accounts: [{ name: "a1", signedIn: a1, retired: false, plan: null }] }
          : op === "signin.start" ? { link: "https://claude.com/cai/oauth/authorize?x=1", userCode: null, needsCode: true, recipient: "age1x", expiresAt: t + 600_000 }
            : op === "signin.status" ? { phase, identity: phase === "done" ? { email: "person@example.com", plan: null } : null, problem: null }
              : {},
      })) as SignInFleet["op"],
    };
    const service = new SignInService({ fleet, now: () => t, audit: () => {} });
    await service.sweep();
    expect(service.asks().map(a => a.id)).toEqual(["signin-n1-claude-a1"]);
    expect(service.settled()).toEqual([]);
    const s = await service.start(who, { node: "n1", runtime: "claude", account: "a1", create: false });
    if (!s.ok) throw new Error(s.problem);
    phase = "done";
    await service.view(s.view.id);
    expect(service.asks()).toEqual([]);
    expect(service.settled().map(x => [x.ask.id, x.at])).toEqual([["signin-n1-claude-a1", t]]);
    t += 10 * 60_000 + 1;
    expect(service.settled()).toEqual([]);
    a1 = "missing";
    await service.sweep();
    expect(service.asks().map(a => [a.id, a.askedAt])).toEqual([["signin-n1-claude-a1", t]]);
    a1 = "ok";
    await service.sweep();
    expect(service.asks()).toEqual([]);
    expect(service.settled().map(x => x.ask.id)).toEqual(["signin-n1-claude-a1"]);
  });
});
