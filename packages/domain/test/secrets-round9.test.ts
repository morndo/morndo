// Secrets: review round 1 of PR #40 (PR 2b; board T-94), domain points. Each block written failing before its fix. Names,
// nodes and fingerprints are synthetic.
import { describe, expect, it } from "vitest";
import { answerStored, openRequest, type RequestKind, type SecretGrant, type StoreConfirmation } from "../src/index.ts";

const T = 1_700_000_000_000;
const DAY = 86_400_000;
const REF = "secret://example-app/payments-test";
const nodeGrant: SecretGrant = { subject: { kind: "node" }, modes: ["exec"], until: { kind: "open" } };

type R<T> = { ok: true; value: T } | { ok: false; error: { problem: string } };
const value = <T>(r: R<T>): T => {
  if (!r.ok) throw new Error(`refused: ${r.error.problem}`);
  return r.value;
};

describe("PR #40 review, point 8: a renew holds on every node the answer names, not only the requester's", () => {
  const opened = (kind: RequestKind) => value(openRequest({
    node: "node-a", reference: REF, kind, waiter: { lane: "lane-a", workspace: null, purpose: "The token expired" }, proposed: nodeGrant,
  }, "r1", T - DAY)).request;
  const confirm = (node: string, over: Partial<StoreConfirmation> = {}): StoreConfirmation =>
    ({ reference: REF, node, version: 2, at: T, renewed: true, ...over });
  const answer = (kind: RequestKind, confirmations: StoreConfirmation[], expiry: number | null = T + 30 * DAY) =>
    answerStored(opened(kind), { seen: 1, command: "c2", reference: REF, expiry, confirmations }, T + 60_000);
  const state = (r: ReturnType<typeof answer>) => (r.ok ? r.value.request.state : r.error.problem);

  it("another node whose store skipped the renew rule leaves the renew open", () => {
    expect(state(answer("renew", [confirm("node-a"), confirm("node-b", { renewed: false })]))).toBe("not_renewed");
  });
  it("another node that stored at or after the Expiry leaves it open", () => {
    expect(state(answer("renew", [confirm("node-a"), confirm("node-b", { at: T + 2_000 })], T + 1_000))).toBe("expiry");
    expect(state(answer("renew", [confirm("node-a"), confirm("node-b", { at: T + 1_000 })], T + 1_000))).toBe("expiry");
  });
  it("every node renewed within the rule: Stored, each named", () => {
    const r = value(answer("renew", [confirm("node-a"), confirm("node-b", { at: T + 500 })], T + 1_000));
    expect(r.request.state).toBe("stored");
    expect(r.events[0]).toMatchObject({ nodes: ["node-a", "node-b"] });
  });
  it("the kinds that don't renew still need no renew from any node", () => {
    expect(state(answer("rotate", [confirm("node-a", { renewed: false }), confirm("node-b", { renewed: false })], null))).toBe("stored");
    expect(state(answer("new", [confirm("node-a", { renewed: false }), confirm("node-b", { renewed: false })], null))).toBe("stored");
  });
});
