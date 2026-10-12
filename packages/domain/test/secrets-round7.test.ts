// Secrets: review round 1 of PR #31 (PR 2a; board T-88), domain points. One block per point, each written failing before
// its fix. Names, nodes and fingerprints are synthetic.
import { describe, expect, it } from "vitest";
import { answerStored, openRequest, type RequestKind, type SecretGrant } from "../src/index.ts";

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

describe("round 7, point 1: a store under another Reference never answers a request it wasn't the answer to", () => {
  const opened = (kind: RequestKind) => value(openRequest({
    node: "node-a", reference: REF, kind, waiter: { lane: "lane-a", workspace: null, purpose: "The token expired" }, proposed: nodeGrant,
  }, "r1", T - DAY)).request;
  const answer = (kind: RequestKind, answered: string, confirmed: string) => {
    const r = answerStored(opened(kind), {
      seen: 1, command: "c2", reference: answered, expiry: kind === "renew" ? T + 30 * DAY : null,
      confirmations: [{ reference: confirmed, node: "node-a", version: 2, at: T, renewed: kind === "renew" }],
    }, T + 60_000);
    return r.ok ? r.value.request.state : r.error.problem;
  };
  it("the node's confirmation must name the Reference the answer stored under", () => {
    for (const kind of ["new", "rotate", "renew"] as const) expect(answer(kind, REF, OTHER), kind).toBe("reference");
    expect(answer("new", OTHER, REF)).toBe("reference");
  });
  it("a renew or a rotation is answered only under the request's own Reference: it is about that Secret", () => {
    expect(answer("renew", OTHER, OTHER)).toBe("reference");
    expect(answer("rotate", OTHER, OTHER)).toBe("reference");
    expect(answer("renew", REF, REF)).toBe("stored");
  });
  it("a new secret may still be stored under the Reference the principal chose on the card (SR6)", () => {
    expect(answer("new", OTHER, OTHER)).toBe("stored");
  });
});
