// Sign-in audit rows (ADR-0039, SI6).
import { describe, expect, it } from "vitest";
import { SignInService, type SignInFleet } from "../src/application/signin-service.ts";

const NOW = 1_800_000_000_000;
const fleet: SignInFleet = { nodes: async () => [], op: async () => ({ ok: true, result: {} }) as never };

describe("sign-in audit entries", () => {
  it("records an agent request with its by", () => {
    const audits: unknown[] = [];
    const service = new SignInService({ fleet, now: () => NOW, audit: e => audits.push(e) });
    service.request({ node: "n1", runtime: "claude", account: "a3", create: true, why: "last seat" }, "worker-lane");
    expect(audits).toEqual([{
      type: "SignIn", kind: "signin.request", node: "n1", runtime: "claude", account: "a3", id: "signin-n1-claude-a3",
      phase: "card", by: "worker-lane", at: NOW,
    }]);
  });
});
