// Secrets: the check review of PR #31 (PR 2b; board T-94), domain points. One block per point, each written failing before
// its fix. Names, nodes and fingerprints are synthetic.
import { describe, expect, it } from "vitest";
import { CONFIRMATION_SKEW_MS, answerStored, openRequest, type RequestKind, type SecretGrant, type StoreConfirmation } from "../src/index.ts";

const T = 1_700_000_000_000;
const DAY = 86_400_000;
const REF = "secret://example-app/payments-test";
const OTHER = "secret://example-app/other-token";
const nodeGrant: SecretGrant = { subject: { kind: "node" }, modes: ["exec"], until: { kind: "open" } };

type R<T> = { ok: true; value: T } | { ok: false; error: { problem: string } };
const value = <T>(r: R<T>): T => {
  if (!r.ok) throw new Error(`refused: ${r.error.problem}`);
  return r.value;
};

describe("check review, point 1 (security): every node the answer names confirmed the store under its Reference", () => {
  const opened = (kind: RequestKind) => value(openRequest({
    node: "node-a", reference: REF, kind, waiter: { lane: "lane-a", workspace: null, purpose: "The token expired" }, proposed: nodeGrant,
  }, "r1", T - DAY)).request;
  const confirm = (node: string, over: Partial<StoreConfirmation> = {}): StoreConfirmation =>
    ({ reference: REF, node, version: 2, at: T, renewed: true, ...over });
  const answer = (kind: RequestKind, confirmations: StoreConfirmation[], reference = REF) =>
    answerStored(opened(kind), { seen: 1, command: "c2", reference, expiry: kind === "renew" ? T + 30 * DAY : null, confirmations }, T + 60_000);
  const state = (r: ReturnType<typeof answer>) => (r.ok ? r.value.request.state : r.error.problem);

  it("a rotate to two nodes, one of which stored under another Reference, is refused", () => {
    for (const kind of ["rotate", "renew"] as const) {
      expect(state(answer(kind, [confirm("node-a"), confirm("node-b", { reference: OTHER })])), kind).toBe("reference");
    }
  });
  it("a new secret's other node must name the Reference the card chose, as the requester's does", () => {
    expect(state(answer("new", [confirm("node-a", { reference: OTHER }), confirm("node-b")], OTHER))).toBe("reference");
    expect(state(answer("new", [confirm("node-a", { reference: OTHER }), confirm("node-b", { reference: OTHER })], OTHER))).toBe("stored");
  });
  it("the event names exactly the nodes that confirmed, the requester's version with them", () => {
    const r = value(answer("rotate", [confirm("node-a", { version: 3 }), confirm("node-b", { version: 1 })]));
    expect(r.events).toEqual([{ type: "SecretRequestStored", request: "r1", reference: REF, nodes: ["node-a", "node-b"], version: 3, at: T + 60_000, command: "c2" }]);
  });
  it("a node that confirms twice, or another node's confirmation with no version, is refused", () => {
    expect(state(answer("rotate", [confirm("node-a"), confirm("node-b"), confirm("node-b")]))).toBe("node");
    expect(state(answer("rotate", [confirm("node-a"), confirm("node-a")]))).toBe("node");
    for (const version of [0, 1.5, Number.NaN]) expect(state(answer("rotate", [confirm("node-a"), confirm("node-b", { version })])), String(version)).toBe("node");
  });
  it("another node's time of the store lies in the hub's window too", () => {
    for (const at of [Number.NaN, T - DAY - CONFIRMATION_SKEW_MS - 1, T + 60_000 + CONFIRMATION_SKEW_MS + 1]) {
      expect(state(answer("rotate", [confirm("node-a"), confirm("node-b", { at })])), String(at)).toBe("clock");
    }
  });
});
