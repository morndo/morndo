// Secrets (ADR-0022; design §3.3 and §3.4): the invariants whose Layer is domain or domain service. One history per
// invariant, each with a step that breaks it and must be refused. `now` is the clock. Names, nodes and fingerprints are
// synthetic; no value exists anywhere in this context, only keyed fingerprints computed outside it.
import { describe, expect, it } from "vitest";
import {
  REQUEST_TTL_MS, admitRequest, answerGranted, answerRejected, answerStored, checkFingerprint, deleteSecret,
  disableSecret, emptySecretDirectory, enableSecret, endLaneGrants, expireRequest, findSecret, formatReference,
  grantSecret, joinRequest, openRequest, parseReference, receiveTransfer, revokeSecret, secretExpirySweep,
  secretWidens, setDestinations, setSecretExpiry, storeSecret, transferable, transferGrants, ungrantSecret, useGate,
  useSecret, withdrawRequest,
  type Actor, type LedgerEntry, type RequestAsk, type Secret, type SecretDirectory, type SecretGrant, type SecretRequest,
} from "../src/index.ts";

const T = 1_700_000_000_000;
const DAY = 86_400_000;
const REF = "secret://example-app/payments-test";
const REF_B = "secret://example-app/deploy-token";
const FP1 = "0123456789a1";
const FP2 = "0123456789a2";
const FP3 = "0123456789a3";
const principal = (command = "c1"): Actor => ({ kind: "principal", command });
const anyone: Actor = { kind: "operator" };

type R<T> = { ok: true; value: T } | { ok: false; error: { problem: string } };
const value = <T>(r: R<T>): T => {
  if (!r.ok) throw new Error(`refused: ${r.error.problem}`);
  return r.value;
};
const problem = <T>(r: R<T>) => (r.ok ? "ok" : r.error.problem);

const workspaceGrant: SecretGrant = { subject: { kind: "workspace", workspace: "example-app" }, modes: ["exec", "file", "helper"], until: { kind: "open" } };
const laneGrant = (lane: string, until: SecretGrant["until"] = { kind: "open" }): SecretGrant =>
  ({ subject: { kind: "lane", lane }, modes: ["exec"], until });

function ask(over: Partial<RequestAsk> = {}): RequestAsk {
  return {
    node: "node-a", reference: REF, kind: "new",
    waiter: { lane: "lane-a", workspace: "example-app", purpose: "Run the checkout tests against the payment sandbox" },
    proposed: workspaceGrant, ...over,
  };
}
function opened(over: Partial<RequestAsk> = {}, id = "r1", at = T): SecretRequest {
  return value(openRequest(ask(over), id, at)).request;
}

// ---- References (§3.6)

describe("References", () => {
  it("parse a well-formed reference into its scope and name, and format it back", () => {
    expect(parseReference(REF)).toEqual({ scope: "example-app", name: "payments-test" });
    expect(formatReference({ scope: "shared", name: "db.url_2" })).toBe("secret://shared/db.url_2");
  });
  it("refuse every malformed reference", () => {
    for (const bad of [
      "secret://Example-app/x", "secret://example-app/X", "op://example-app/x", "secret://example-app", "secret://example-app/",
      "secret://a/b/c", "secret://-a/b", "secret://a/.b", "secret://a/b c", `secret://${"a".repeat(41)}/b`,
      `secret://a/${"b".repeat(65)}`, " secret://a/b", "secret://a/b\n",
    ]) expect(parseReference(bad), bad).toBeNull();
    expect(parseReference(`secret://${"a".repeat(40)}/${"b".repeat(64)}`)).not.toBeNull();
  });
});

// ---- Secret requests (§3.3)

describe("SR1: one open request per node and Reference (Request admission)", () => {
  it("opens the first request, and a repeat from another lane joins it", () => {
    const r1 = opened();
    expect(admitRequest([], ask(), T)).toEqual({ kind: "open" });
    expect(admitRequest([r1], ask({ waiter: { lane: "lane-b", workspace: "example-app", purpose: "Deploy" } }), T)).toEqual({ kind: "join", request: "r1" });
  });
  it("opens a new one for the same Reference on another node, or once the earlier one ended", () => {
    const r1 = opened();
    expect(admitRequest([r1], ask({ node: "node-b" }), T)).toEqual({ kind: "open" });
    const ended = value(answerRejected(r1, { seen: 1, command: "c2", reason: null }, T + 1)).request;
    expect(admitRequest([ended], ask(), T + 2)).toEqual({ kind: "open" });
  });
  it("a join adds the lane with its own purpose and workspace and moves the version; the same lane again changes nothing", () => {
    const r1 = opened();
    const joined = value(joinRequest(r1, { lane: "lane-b", workspace: "other-app", purpose: "Deploy the preview" }, T + 1));
    expect(joined.request.waiting.map(w => [w.lane, w.workspace, w.purpose])).toEqual([
      ["lane-a", "example-app", "Run the checkout tests against the payment sandbox"],
      ["lane-b", "other-app", "Deploy the preview"],
    ]);
    expect(joined.request.version).toBe(2);
    expect(joined.events.map(e => e.type)).toEqual(["SecretRequestJoined"]);
    const again = value(joinRequest(joined.request, { lane: "lane-b", workspace: "other-app", purpose: "Deploy again" }, T + 2));
    expect(again.request).toEqual(joined.request);
    expect(again.events).toEqual([]);
  });
});

describe("SR3: a request carries a purpose in plain text and a valid Reference and Grant", () => {
  it("refuses an empty, over-long or control-character purpose", () => {
    expect(problem(openRequest(ask({ waiter: { lane: "lane-a", workspace: null, purpose: "" } }), "r1", T))).toBe("bad_purpose");
    expect(problem(openRequest(ask({ waiter: { lane: "lane-a", workspace: null, purpose: "x".repeat(301) } }), "r1", T))).toBe("bad_purpose");
    expect(problem(openRequest(ask({ waiter: { lane: "lane-a", workspace: null, purpose: "run\u0007tests" } }), "r1", T))).toBe("bad_purpose");
    expect(problem(openRequest(ask({ waiter: { lane: "lane-a", workspace: null, purpose: "x".repeat(300) } }), "r1", T))).toBe("ok");
  });
  it("refuses a bad Reference, an empty mode list, an unknown mode and a duplicated mode", () => {
    expect(problem(openRequest(ask({ reference: "secret://Bad/x" }), "r1", T))).toBe("bad_reference");
    expect(problem(openRequest(ask({ proposed: { ...workspaceGrant, modes: [] } }), "r1", T))).toBe("bad_grant");
    expect(problem(openRequest(ask({ proposed: { ...workspaceGrant, modes: ["exec", "print" as "exec"] } }), "r1", T))).toBe("bad_grant");
    expect(problem(openRequest(ask({ proposed: { ...workspaceGrant, modes: ["exec", "exec"] } }), "r1", T))).toBe("bad_grant");
  });
  it("records the opener and the requested kind", () => {
    const r = value(openRequest(ask({ kind: "rotate" }), "r9", T));
    expect([r.request.id, r.request.node, r.request.reference, r.request.kind, r.request.state, r.request.openedBy, r.request.version])
      .toEqual(["r9", "node-a", REF, "rotate", "open", "lane-a", 1]);
    expect(r.events).toEqual([{ type: "SecretRequested", request: "r9", node: "node-a", reference: REF, kind: "rotate", at: T }]);
  });
});

describe("SR4: one answer, withdrawal by the last waiting lane, expiry after 7 days", () => {
  it("a second answer is refused and the first one stays", () => {
    const rejected = value(answerRejected(opened(), { seen: 1, command: "c2", reason: "Use the shared key" }, T + 1)).request;
    expect(rejected.state).toBe("rejected");
    expect(rejected.answer).toEqual({ kind: "rejected", at: T + 1, command: "c2", reason: "Use the shared key" });
    expect(problem(answerRejected(rejected, { seen: 1, command: "c3", reason: null }, T + 2))).toBe("answered");
    expect(problem(answerStored(rejected, { seen: 1, command: "c3", reference: REF, version: 1, nodes: ["node-a"] }, T + 2))).toBe("answered");
  });
  it("an earlier withdrawal takes only that lane off; the last one withdraws the request", () => {
    const two = value(joinRequest(opened(), { lane: "lane-b", workspace: null, purpose: "Deploy" }, T + 1)).request;
    const one = value(withdrawRequest(two, "lane-a", T + 2));
    expect(one.request.state).toBe("open");
    expect(one.request.waiting.map(w => w.lane)).toEqual(["lane-b"]);
    expect(one.request.version).toBe(3);
    expect(one.events.map(e => e.type)).toEqual(["SecretRequestLeft"]);
    const none = value(withdrawRequest(one.request, "lane-b", T + 3));
    expect(none.request.state).toBe("withdrawn");
    expect(none.events.map(e => e.type)).toEqual(["SecretRequestWithdrawn"]);
    expect(problem(withdrawRequest(none.request, "lane-b", T + 4))).toBe("answered");
  });
  it("a lane that isn't waiting can't withdraw", () => {
    expect(problem(withdrawRequest(opened(), "lane-z", T + 1))).toBe("not_waiting");
  });
  it("expires 7 days after it opened, not before, and is then unanswerable", () => {
    const r = opened();
    expect(REQUEST_TTL_MS).toBe(7 * DAY);
    expect(problem(expireRequest(r, T + 7 * DAY - 1))).toBe("open");
    const expired = value(expireRequest(r, T + 7 * DAY));
    expect(expired.request.state).toBe("expired");
    expect(expired.events).toEqual([{ type: "SecretRequestExpired", request: "r1", at: T + 7 * DAY }]);
    expect(problem(answerRejected(r, { seen: 1, command: "c2", reason: null }, T + 7 * DAY))).toBe("expired");
  });
  it("only the principal answers", () => {
    expect(problem(answerRejected(opened(), { seen: 1, command: "", reason: null }, T + 1))).toBe("principal");
  });
});

describe("SR6: an answer names the version it saw", () => {
  it("is refused as changed after a join or a withdrawal, and accepted at the current version", () => {
    const joined = value(joinRequest(opened(), { lane: "lane-b", workspace: null, purpose: "Deploy" }, T + 1)).request;
    expect(problem(answerRejected(joined, { seen: 1, command: "c2", reason: null }, T + 2))).toBe("changed");
    const left = value(withdrawRequest(joined, "lane-b", T + 2)).request;
    expect(problem(answerRejected(left, { seen: 2, command: "c2", reason: null }, T + 3))).toBe("changed");
    expect(problem(answerRejected(left, { seen: 3, command: "c2", reason: null }, T + 3))).toBe("ok");
  });
});

describe("SR8: Stored only on the requester node's confirmation; the answer fits the kind", () => {
  it("is Stored when the confirming nodes include the requester's node", () => {
    const r = value(answerStored(opened(), { seen: 1, command: "c2", reference: REF, version: 1, nodes: ["node-a", "node-b"] }, T + 1));
    expect(r.request.state).toBe("stored");
    expect(r.events).toEqual([{ type: "SecretRequestStored", request: "r1", reference: REF, nodes: ["node-a", "node-b"], version: 1, at: T + 1, command: "c2" }]);
  });
  it("is refused while the requester's node hasn't confirmed", () => {
    expect(problem(answerStored(opened(), { seen: 1, command: "c2", reference: REF, version: 1, nodes: ["node-b"] }, T + 1))).toBe("node");
  });
  it("records the Reference the card stored under, which may differ from the asked one", () => {
    const r = value(answerStored(opened(), { seen: 1, command: "c2", reference: "secret://shared/payments-test", version: 2, nodes: ["node-a"] }, T + 1));
    expect(r.events[0]).toMatchObject({ reference: "secret://shared/payments-test", version: 2 });
    expect(problem(answerStored(opened(), { seen: 1, command: "c2", reference: "nope", version: 1, nodes: ["node-a"] }, T + 1))).toBe("bad_reference");
  });
  it("an access request is granted, never stored; any other kind is stored, never granted", () => {
    const access = opened({ kind: "access" });
    expect(problem(answerStored(access, { seen: 1, command: "c2", reference: REF, version: 1, nodes: ["node-a"] }, T + 1))).toBe("kind");
    expect(value(answerGranted(access, { seen: 1, command: "c2" }, T + 1)).request.state).toBe("granted");
    expect(problem(answerGranted(opened(), { seen: 1, command: "c2" }, T + 1))).toBe("kind");
  });
});

describe("SR10: per-lane and per-node limits (Request admission)", () => {
  const many = (n: number, lane: (i: number) => string, at = T) =>
    Array.from({ length: n }, (_, i) => opened({ reference: `secret://example-app/s${i}`, waiter: { lane: lane(i), workspace: null, purpose: "p" } }, `r${i}`, at));
  const next = (lane = "lane-a") => ask({ reference: "secret://example-app/next", waiter: { lane, workspace: null, purpose: "p" } });

  it("a lane holds at most 5 open requests, joins included", () => {
    expect(admitRequest(many(4, () => "lane-a"), next(), T)).toEqual({ kind: "open" });
    expect(admitRequest(many(5, () => "lane-a"), next(), T)).toEqual({ kind: "refuse", limit: "lane-open" });
    const five = many(5, () => "lane-a");
    const other = opened({ reference: "secret://example-app/next", waiter: { lane: "lane-b", workspace: null, purpose: "p" } }, "rx");
    expect(admitRequest([...five, other], next(), T)).toEqual({ kind: "refuse", limit: "lane-open" });
  });
  it("a lane opens at most 20 a day; older ones don't count", () => {
    const ended = (rs: SecretRequest[]) => rs.map(r => value(answerRejected(r, { seen: 1, command: "c", reason: null }, r.openedAt + 1)).request);
    expect(admitRequest(ended(many(20, () => "lane-a", T - DAY + 1)), next(), T)).toEqual({ kind: "refuse", limit: "lane-day" });
    expect(admitRequest(ended(many(20, () => "lane-a", T - DAY)), next(), T)).toEqual({ kind: "open" });
    expect(admitRequest(ended(many(19, () => "lane-a", T - 1)), next(), T)).toEqual({ kind: "open" });
  });
  it("a node holds at most 20 open requests and opens at most 100 a day", () => {
    expect(admitRequest(many(20, i => `lane-${i}`), next("lane-z"), T)).toEqual({ kind: "refuse", limit: "node-open" });
    const ended = many(100, i => `lane-${i}`, T - 1).map(r => value(answerRejected(r, { seen: 1, command: "c", reason: null }, T)).request);
    expect(admitRequest(ended, next("lane-z"), T)).toEqual({ kind: "refuse", limit: "node-day" });
    expect(admitRequest(ended.slice(1), next("lane-z"), T)).toEqual({ kind: "open" });
  });
});

describe("SR11: a request grants nothing", () => {
  it("every event of a request's life is a request event", () => {
    const a = value(openRequest(ask(), "r1", T));
    const b = value(joinRequest(a.request, { lane: "lane-b", workspace: null, purpose: "Deploy" }, T + 1));
    const c = value(answerStored(b.request, { seen: 2, command: "c2", reference: REF, version: 1, nodes: ["node-a"] }, T + 2));
    const types = [...a.events, ...b.events, ...c.events].map(e => e.type);
    expect(types).toEqual(["SecretRequested", "SecretRequestJoined", "SecretRequestStored"]);
    for (const t of types) expect(t).not.toMatch(/Mandate|Decision|Task|Board/);
  });
});

// ---- Secrets on a node (§3.4)

function stored(dir: SecretDirectory, reference = REF, fingerprint = FP1, extra: { grants?: SecretGrant[]; expiry?: number | null; destinations?: string[] } = {}, at = T): SecretDirectory {
  return value(storeSecret(dir, {
    reference, fingerprint, shape: null, grants: extra.grants ?? [], expiry: extra.expiry ?? null,
    destinations: extra.destinations ?? [],
  }, principal(), at));
}
const secretOf = (dir: SecretDirectory, reference = REF): Secret => {
  const s = findSecret(dir, reference);
  if (!s) throw new Error(`no ${reference}`);
  return s;
};
const events = (dir: SecretDirectory) => dir.events.map(e => e.type);

describe("SC2: the Fingerprint ledger", () => {
  const ledger: LedgerEntry[] = [
    { reference: REF, version: 1, fingerprint: FP1, state: "retired" },
    { reference: REF, version: 2, fingerprint: FP2, state: "current" },
    { reference: REF_B, version: 1, fingerprint: FP3, state: "revoked" },
    { reference: "secret://shared/c", version: 1, fingerprint: "0123456789c1", state: "current" },
    { reference: "secret://shared/d", version: 1, fingerprint: "0123456789d1", state: "retired" },
  ];
  it("refuses an earlier or current version of the same Reference", () => {
    expect(checkFingerprint(ledger, REF, FP1)).toEqual({ kind: "refuse", reason: "earlier" });
    expect(checkFingerprint(ledger, REF, FP2)).toEqual({ kind: "refuse", reason: "earlier" });
  });
  it("refuses a revoked value under any Reference", () => {
    expect(checkFingerprint(ledger, "secret://shared/new", FP3)).toEqual({ kind: "refuse", reason: "revoked" });
    expect(checkFingerprint(ledger, REF_B, FP3)).toEqual({ kind: "refuse", reason: "revoked" });
  });
  it("accepts the current value of another Reference with a warning that names it", () => {
    expect(checkFingerprint(ledger, "secret://shared/new", "0123456789c1")).toEqual({ kind: "accept", sameAs: ["secret://shared/c"] });
  });
  it("accepts a fresh value, and a retired value of another Reference without a warning", () => {
    expect(checkFingerprint(ledger, "secret://shared/new", "0123456789ff")).toEqual({ kind: "accept", sameAs: [] });
    expect(checkFingerprint(ledger, "secret://shared/new", "0123456789d1")).toEqual({ kind: "accept", sameAs: [] });
  });
  it("a store goes through the ledger: a rotation back to an earlier value and a revoked value are refused", () => {
    let dir = stored(emptySecretDirectory());
    dir = value(storeSecret(dir, { reference: REF, fingerprint: FP2, shape: null, grants: [], expiry: null, destinations: [] }, principal("c2"), T + 1));
    expect(secretOf(dir).current?.number).toBe(2);
    expect(events(dir)).toEqual(["SecretStored", "SecretRotated"]);
    expect(problem(storeSecret(dir, { reference: REF, fingerprint: FP1, shape: null, grants: [], expiry: null, destinations: [] }, principal(), T + 2))).toBe("earlier");
    dir = value(revokeSecret(dir, REF, principal("c3"), T + 3));
    expect(problem(storeSecret(dir, { reference: "secret://shared/other", fingerprint: FP2, shape: null, grants: [], expiry: null, destinations: [] }, principal(), T + 4))).toBe("revoked");
  });
  it("a duplicate of another active Secret is stored, and the event names it", () => {
    let dir = stored(emptySecretDirectory(), REF_B, FP3);
    dir = stored(dir, REF, FP3);
    expect(dir.events.at(-1)).toMatchObject({ type: "SecretStored", reference: REF, sameAs: [REF_B] });
  });
  it("a store needs the principal and a well-formed fingerprint and Reference", () => {
    const base = { reference: REF, fingerprint: FP1, shape: null, grants: [], expiry: null, destinations: [] };
    expect(problem(storeSecret(emptySecretDirectory(), base, anyone, T))).toBe("principal");
    expect(problem(storeSecret(emptySecretDirectory(), { ...base, fingerprint: "XYZ" }, principal(), T))).toBe("bad_fingerprint");
    expect(problem(storeSecret(emptySecretDirectory(), { ...base, reference: "secret://x" }, principal(), T))).toBe("bad_reference");
  });
});

describe("SC3: default deny, and the use gate in order", () => {
  const caller = { lane: "lane-a", workspace: "example-app" };
  it("a Secret with no Grant resolves for nobody", () => {
    const dir = stored(emptySecretDirectory());
    expect(useGate(findSecret(dir, REF), caller, "exec", T)).toEqual({ ok: false, error: { problem: "not_granted" } });
    expect(useGate(findSecret(dir, REF), { lane: null, workspace: null }, "exec", T)).toEqual({ ok: false, error: { problem: "not_granted" } });
  });
  it("a missing Secret is refused as missing", () => {
    expect(problem(useGate(null, caller, "exec", T))).toBe("missing");
  });
  it("admits by lane, by workspace, or for every lane on the node", () => {
    const dir = stored(emptySecretDirectory(), REF, FP1, { grants: [laneGrant("lane-a")] });
    expect(problem(useGate(findSecret(dir, REF), caller, "exec", T))).toBe("ok");
    expect(problem(useGate(findSecret(dir, REF), { lane: "lane-b", workspace: "example-app" }, "exec", T))).toBe("not_granted");
    const ws = stored(emptySecretDirectory(), REF, FP1, { grants: [workspaceGrant] });
    expect(problem(useGate(findSecret(ws, REF), { lane: "lane-b", workspace: "example-app" }, "file", T))).toBe("ok");
    expect(problem(useGate(findSecret(ws, REF), { lane: "lane-a", workspace: "other-app" }, "file", T))).toBe("not_granted");
    const node = stored(emptySecretDirectory(), REF, FP1, { grants: [{ subject: { kind: "node" }, modes: ["exec"], until: { kind: "open" } }] });
    expect(problem(useGate(findSecret(node, REF), { lane: null, workspace: null }, "exec", T))).toBe("ok");
  });
  it("a Grant that has ended admits nobody", () => {
    const dir = stored(emptySecretDirectory(), REF, FP1, { grants: [laneGrant("lane-a", { kind: "at", at: T + 10 })] });
    expect(problem(useGate(findSecret(dir, REF), caller, "exec", T + 9))).toBe("ok");
    expect(problem(useGate(findSecret(dir, REF), caller, "exec", T + 10))).toBe("not_granted");
  });
  it("a Grant allows only its modes", () => {
    const dir = stored(emptySecretDirectory(), REF, FP1, { grants: [laneGrant("lane-a")] });
    expect(problem(useGate(findSecret(dir, REF), caller, "file", T))).toBe("mode");
  });
  it("checks status, then a current version, then expiry, then the Grant, then the mode", () => {
    const granted = stored(emptySecretDirectory(), REF, FP1, { grants: [laneGrant("lane-a")], expiry: T + 5 });
    const disabled = value(disableSecret(granted, REF, anyone, T + 1));
    expect(problem(useGate(findSecret(disabled, REF), { lane: "lane-z", workspace: null }, "file", T + 6))).toBe("disabled");
    const revoked = value(revokeSecret(granted, REF, principal(), T + 1));
    expect(problem(useGate(findSecret(revoked, REF), { lane: "lane-z", workspace: null }, "file", T + 6))).toBe("revoked");
    const noValue: Secret = { ...secretOf(granted), current: null };
    expect(problem(useGate(noValue, { lane: "lane-z", workspace: null }, "file", T + 6))).toBe("no_value");
    expect(problem(useGate(findSecret(granted, REF), { lane: "lane-z", workspace: null }, "file", T + 6))).toBe("expired");
    expect(problem(useGate(findSecret(granted, REF), { lane: "lane-z", workspace: null }, "file", T + 4))).toBe("not_granted");
    expect(problem(useGate(findSecret(granted, REF), caller, "file", T + 4))).toBe("mode");
  });
  it("a Use is recorded with the version, and a refusal is recorded too", () => {
    const dir = stored(emptySecretDirectory(), REF, FP1, { grants: [laneGrant("lane-a")] });
    const used = value(useSecret(dir, REF, caller, "exec", "u1", T + 1));
    expect(used.events.at(-1)).toEqual({ type: "SecretUsed", reference: REF, version: 1, at: T + 1, use: "u1", mode: "exec", lane: "lane-a", workspace: "example-app" });
    const refused = useSecret(dir, REF, { lane: "lane-b", workspace: null }, "exec", "u2", T + 2);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.problem).toBe("not_granted");
    expect(refused.error.directory?.events.at(-1)).toEqual({ type: "UseRefused", reference: REF, at: T + 2, reason: "not_granted", mode: "exec", lane: "lane-b", workspace: null });
  });
});

describe("SC7: narrowing is anyone's, widening the principal's, judged by effect", () => {
  const base = (): Secret => secretOf(stored(emptySecretDirectory(), REF, FP1, { grants: [laneGrant("lane-a", { kind: "at", at: T + 100 })], expiry: T + 1000, destinations: ["api.example.com"] }));
  const g = (s: Secret) => s.grants[0] ?? laneGrant("missing");
  const cases: [string, (s: Secret) => Secret, boolean][] = [
    ["a new subject", s => ({ ...s, grants: [...s.grants, laneGrant("lane-b")] }), true],
    ["a lane grant made node-wide", s => ({ ...s, grants: [{ ...g(s), subject: { kind: "node" } }] }), true],
    ["a lane grant made workspace-wide", s => ({ ...s, grants: [{ ...g(s), subject: { kind: "workspace", workspace: "example-app" } }] }), true],
    ["a mode added", s => ({ ...s, grants: [{ ...g(s), modes: ["exec", "file"] }] }), true],
    ["a Grant that ends later", s => ({ ...s, grants: [{ ...g(s), until: { kind: "at", at: T + 200 } }] }), true],
    ["a Grant that no longer ends", s => ({ ...s, grants: [{ ...g(s), until: { kind: "open" } }] }), true],
    ["a later expiry", s => ({ ...s, expiry: T + 2000 }), true],
    ["no expiry", s => ({ ...s, expiry: null }), true],
    ["a Destination added", s => ({ ...s, destinations: ["api.example.com", "uploads.example.com"] }), true],
    ["nothing changed", s => ({ ...s }), false],
    ["a Grant removed", s => ({ ...s, grants: [] }), false],
    ["a Grant that ends sooner", s => ({ ...s, grants: [{ ...g(s), until: { kind: "at", at: T + 50 } }] }), false],
    ["an earlier expiry", s => ({ ...s, expiry: T + 500 }), false],
    ["a Destination removed", s => ({ ...s, destinations: [] }), false],
    ["disabled", s => ({ ...s, status: "disabled" }), false],
  ];
  for (const [name, change, widens] of cases) {
    it(`${name} ${widens ? "widens" : "doesn't widen"}`, () => {
      expect(secretWidens(base(), change(base()))).toBe(widens);
    });
  }
  it("enabling a disabled Secret widens", () => {
    const disabled: Secret = { ...base(), status: "disabled" };
    expect(secretWidens(disabled, { ...disabled, status: "active" })).toBe(true);
  });
  it("anyone narrows; only the principal widens", () => {
    const dir = stored(emptySecretDirectory(), REF, FP1, { grants: [laneGrant("lane-a")], expiry: T + 1000, destinations: ["api.example.com"] });
    expect(problem(grantSecret(dir, REF, laneGrant("lane-b"), anyone, T))).toBe("principal");
    expect(problem(grantSecret(dir, REF, laneGrant("lane-b"), principal(), T))).toBe("ok");
    expect(problem(grantSecret(dir, REF, laneGrant("lane-a"), principal(), T))).toBe("same");
    expect(problem(ungrantSecret(dir, REF, { kind: "lane", lane: "lane-a" }, anyone, T))).toBe("ok");
    expect(problem(ungrantSecret(dir, REF, { kind: "lane", lane: "lane-z" }, anyone, T))).toBe("missing");
    expect(problem(setSecretExpiry(dir, REF, T + 500, anyone, T))).toBe("ok");
    expect(problem(setSecretExpiry(dir, REF, T + 2000, anyone, T))).toBe("principal");
    expect(problem(setSecretExpiry(dir, REF, null, anyone, T))).toBe("principal");
    expect(problem(setDestinations(dir, REF, [], anyone, T))).toBe("ok");
    expect(problem(setDestinations(dir, REF, ["api.example.com", "other.example.com"], anyone, T))).toBe("principal");
    expect(problem(setDestinations(dir, REF, ["Not A Host"], principal(), T))).toBe("bad_destination");
    const off = value(disableSecret(dir, REF, anyone, T));
    expect(problem(enableSecret(off, REF, anyone, T))).toBe("principal");
    expect(problem(enableSecret(off, REF, principal(), T))).toBe("ok");
    expect(problem(revokeSecret(dir, REF, anyone, T))).toBe("principal");
    expect(problem(deleteSecret(dir, REF, anyone, T))).toBe("principal");
  });
  it("widening events carry the Command id; narrowing ones from anyone carry none", () => {
    let dir = stored(emptySecretDirectory(), REF, FP1, { grants: [laneGrant("lane-a")] });
    dir = value(grantSecret(dir, REF, laneGrant("lane-b"), principal("c9"), T + 1));
    dir = value(ungrantSecret(dir, REF, { kind: "lane", lane: "lane-a" }, anyone, T + 2));
    expect(dir.events.slice(-2)).toEqual([
      { type: "GrantAdded", reference: REF, at: T + 1, command: "c9", subject: { kind: "lane", lane: "lane-b" } },
      { type: "GrantRemoved", reference: REF, at: T + 2, command: null, subject: { kind: "lane", lane: "lane-a" } },
    ]);
  });
});

describe("SC8: Disable and Revoke refuse new Uses; Revoke destroys the value, Delete the Reference", () => {
  it("Disable is reversible, Revoke keeps the Reference and its Grants, and a new value is a new version", () => {
    let dir = stored(emptySecretDirectory(), REF, FP1, { grants: [laneGrant("lane-a")] });
    dir = value(disableSecret(dir, REF, anyone, T + 1));
    expect(secretOf(dir).status).toBe("disabled");
    expect(problem(disableSecret(dir, REF, anyone, T + 2))).toBe("same");
    dir = value(enableSecret(dir, REF, principal(), T + 2));
    dir = value(revokeSecret(dir, REF, principal("c4"), T + 3));
    const revoked = secretOf(dir);
    expect([revoked.status, revoked.current, revoked.grants.length]).toEqual(["revoked", null, 1]);
    expect(dir.ledger).toEqual([{ reference: REF, version: 1, fingerprint: FP1, state: "revoked" }]);
    expect(problem(disableSecret(dir, REF, anyone, T + 4))).toBe("revoked");
    dir = stored(dir, REF, FP2, {}, T + 5);
    const back = secretOf(dir);
    expect([back.status, back.current?.number, back.grants.length]).toEqual(["active", 2, 1]);
  });
  it("Delete removes the Secret; the ledger keeps its versions, so a revoked value stays refused", () => {
    let dir = stored(emptySecretDirectory(), REF, FP1);
    dir = value(revokeSecret(dir, REF, principal(), T + 1));
    dir = stored(dir, REF, FP2, {}, T + 2);
    dir = value(deleteSecret(dir, REF, principal("c5"), T + 3));
    expect(findSecret(dir, REF)).toBeNull();
    expect(dir.ledger).toEqual([
      { reference: REF, version: 1, fingerprint: FP1, state: "revoked" },
      { reference: REF, version: 2, fingerprint: FP2, state: "retired" },
    ]);
    expect(problem(storeSecret(dir, { reference: REF_B, fingerprint: FP1, shape: null, grants: [], expiry: null, destinations: [] }, principal(), T + 4))).toBe("revoked");
    expect(events(dir)).toEqual(["SecretStored", "SecretRevoked", "SecretRotated", "SecretDeleted"]);
  });
  it("a lane's lane-end Grants end with it, and nobody else's", () => {
    let dir = stored(emptySecretDirectory(), REF, FP1, { grants: [laneGrant("lane-a", { kind: "lane-end" }), laneGrant("lane-b", { kind: "lane-end" }), laneGrant("lane-a")] });
    dir = endLaneGrants(dir, "lane-a", T + 1);
    expect(secretOf(dir).grants).toEqual([laneGrant("lane-b", { kind: "lane-end" }), laneGrant("lane-a")]);
    expect(dir.events.at(-1)).toEqual({ type: "GrantEnded", reference: REF, at: T + 1, subject: { kind: "lane", lane: "lane-a" } });
  });
});

describe("SC9: expiry warns once per lead, then refuses", () => {
  it("warns 7, 2 and 1 days before, once each, then marks it expired once", () => {
    let dir = stored(emptySecretDirectory(), REF, FP1, { grants: [laneGrant("lane-a")], expiry: T + 10 * DAY });
    const warned = (d: SecretDirectory) => d.events.filter(e => e.type === "ExpiryWarned" || e.type === "SecretExpired").map(e => e.type === "ExpiryWarned" ? e.lead : "expired");
    dir = secretExpirySweep(dir, T + 2 * DAY);
    expect(warned(dir)).toEqual([]);
    dir = secretExpirySweep(dir, T + 3 * DAY);
    dir = secretExpirySweep(dir, T + 4 * DAY);
    expect(warned(dir)).toEqual(["7d"]);
    dir = secretExpirySweep(dir, T + 9.5 * DAY);
    expect(warned(dir)).toEqual(["7d", "2d", "1d"]);
    dir = secretExpirySweep(dir, T + 10 * DAY);
    dir = secretExpirySweep(dir, T + 11 * DAY);
    expect(warned(dir)).toEqual(["7d", "2d", "1d", "expired"]);
    expect(problem(useGate(findSecret(dir, REF), { lane: "lane-a", workspace: null }, "exec", T + 10 * DAY))).toBe("expired");
  });
  it("a later expiry clears the leads, so the new date warns again", () => {
    let dir = stored(emptySecretDirectory(), REF, FP1, { expiry: T + 10 * DAY });
    dir = secretExpirySweep(dir, T + 4 * DAY);
    dir = value(setSecretExpiry(dir, REF, T + 30 * DAY, principal(), T + 5 * DAY));
    dir = secretExpirySweep(dir, T + 24 * DAY);
    expect(dir.events.filter(e => e.type === "ExpiryWarned").length).toBe(2);
  });
});

describe("SC10: a Secret grants nothing", () => {
  it("no event of a Secret's life names a Mandate, a Decision or a task", () => {
    let dir = stored(emptySecretDirectory(), REF, FP1, { grants: [laneGrant("lane-a")], expiry: T + DAY });
    dir = value(useSecret(dir, REF, { lane: "lane-a", workspace: null }, "exec", "u1", T + 1));
    dir = value(disableSecret(dir, REF, anyone, T + 2));
    dir = value(enableSecret(dir, REF, principal(), T + 3));
    dir = secretExpirySweep(dir, T + 2 * DAY);
    dir = value(revokeSecret(dir, REF, principal(), T + 3 * DAY));
    for (const t of events(dir)) expect(t).not.toMatch(/Mandate|Decision|Task|Board/);
  });
});

describe("SC11: a transfer carries the live Grants, from a Secret that could be used", () => {
  it("drops ended Grants and keeps the rest", () => {
    const dir = stored(emptySecretDirectory(), REF, FP1, { grants: [laneGrant("lane-a", { kind: "at", at: T + 5 }), workspaceGrant], expiry: T + DAY });
    expect(transferGrants(secretOf(dir), T + 10)).toEqual([workspaceGrant]);
  });
  it("only an active, unexpired Secret with a value is transferable", () => {
    const dir = stored(emptySecretDirectory(), REF, FP1, { expiry: T + DAY });
    expect(problem(transferable(findSecret(dir, REF), T))).toBe("ok");
    expect(problem(transferable(findSecret(dir, REF), T + DAY))).toBe("expired");
    expect(problem(transferable(findSecret(value(disableSecret(dir, REF, anyone, T)), REF), T))).toBe("disabled");
    expect(problem(transferable(null, T))).toBe("missing");
  });
  it("the target stores it as its own Secret, through its own ledger, and records where it came from", () => {
    const dir = value(receiveTransfer(emptySecretDirectory(), {
      reference: REF, fingerprint: FP1, shape: null, grants: [workspaceGrant], expiry: null, destinations: [], from: "node-a",
    }, principal("c7"), T));
    expect(secretOf(dir).grants).toEqual([workspaceGrant]);
    expect(dir.events).toEqual([{ type: "SecretTransferred", reference: REF, version: 1, at: T, command: "c7", from: "node-a" }]);
    expect(problem(receiveTransfer(dir, { reference: REF, fingerprint: FP1, shape: null, grants: [], expiry: null, destinations: [], from: "node-a" }, principal(), T + 1))).toBe("earlier");
    expect(problem(receiveTransfer(emptySecretDirectory(), { reference: REF, fingerprint: FP1, shape: null, grants: [], expiry: null, destinations: [], from: "node-a" }, anyone, T))).toBe("principal");
  });
});
