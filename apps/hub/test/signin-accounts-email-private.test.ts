// Each account's email goes to the principal and nowhere else (ADR-0039 §9): the hub hands it to the app in the Accounts
// view, while its audit and its sign-in cards never hold it.
import { describe, expect, it } from "vitest";
import { SignInService, type SignInFleet } from "../src/application/signin-service.ts";

const NOW = 1_800_000_000_000;
const rows = [
  { name: "a1", signedIn: "ok", retired: false, plan: "max", email: "person@example.com" },
  { name: "a2", signedIn: "missing", retired: false, plan: null, email: "earlier@example.com" },
];

describe("account emails stay with the principal", () => {
  it("are in the Accounts view, and in no audit entry or card after a read and a sweep", async () => {
    const audits: unknown[] = [];
    const fleet: SignInFleet = {
      nodes: async () => ["n1"],
      op: (async (_node: string, op: string) =>
        op === "signin.accounts" ? { ok: true, result: { accounts: rows } } : { ok: false, error: { code: "unknown_op" } }) as SignInFleet["op"],
    };
    const service = new SignInService({ fleet, now: () => NOW, audit: e => audits.push(e) });

    const read = await service.accounts("n1", "claude");
    expect(read.ok && read.view.accounts.map(r => r.email)).toEqual(["person@example.com", "earlier@example.com"]);

    await service.sweep();
    expect(service.cards().map(c => c.account)).toContain("a2");
    expect(JSON.stringify([audits, service.cards()])).not.toMatch(/@example\.com/);
  });
});
