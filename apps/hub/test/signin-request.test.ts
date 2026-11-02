// Agent sign-in card requests (ADR-0039, SI8).
import { describe, expect, it } from "vitest";
import { SignInService, type SignInFleet } from "../src/application/signin-service.ts";

const NOW = 1_800_000_000_000;
const fleet: SignInFleet = { nodes: async () => [], op: async () => ({ ok: true, result: {} }) as never };

describe("agent sign-in card requests", () => {
  it("refuses a named Cursor account with cursor_main_only", () => {
    const service = new SignInService({ fleet, now: () => NOW, audit: () => {} });
    expect(service.request({ node: "n1", runtime: "cursor", account: "c2", create: false, why: "need cursor" }, "lane-a"))
      .toEqual({ ok: false, problem: "cursor_main_only" });
  });

  it("refuses a 33rd distinct card with too_many_cards while an existing card still works", () => {
    const service = new SignInService({ fleet, now: () => NOW, audit: () => {} });
    for (let i = 0; i < 32; i++) {
      const r = service.request({ node: "n1", runtime: "claude", account: `a${i}`, create: false, why: "pool" }, "manager");
      if (!r.ok) throw new Error(r.problem);
    }
    expect(service.request({ node: "n1", runtime: "claude", account: "a32", create: false, why: "one more" }, "manager"))
      .toEqual({ ok: false, problem: "too_many_cards" });
    expect(service.request({ node: "n1", runtime: "claude", account: "a0", create: false, why: "again" }, "manager"))
      .toEqual({ ok: true, card: "signin-n1-claude-a0" });
  });
});
