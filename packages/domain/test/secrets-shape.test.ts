// SC1 and the domain part of SR3, as an allowlist (ADR-0022; design §3.3, §3.4, §14 test 1). A built request, Secret,
// version, Grant, ledger entry and every event has exactly these keys. A key named like a value fails even if someone
// adds it to the list, so no field can carry one.
import { describe, expect, it } from "vitest";
import {
  answerGranted, answerRejected, answerStored, deleteSecret, disableSecret, emptySecretDirectory, enableSecret, endLaneGrants,
  endUse, expireRequest, grantSecret, joinRequest, openRequest, receiveTransfer, revokeSecret, secretExpirySweep,
  setDestinations, setSecretExpiry, storeSecret, ungrantSecret, useSecret, withdrawRequest,
  type Actor, type RequestAsk, type RequestEvent, type SecretDirectory, type SecretEvent, type SecretGrant,
} from "../src/index.ts";

const BANNED = /value|secret|plaintext|token|password|cipher/i;

export function keyProblems(value: unknown, allow: readonly string[]): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["not-a-record"];
  const keys = Object.keys(value);
  return [
    ...keys.filter(k => !allow.includes(k)).map(k => `extra:${k}`),
    ...allow.filter(k => !keys.includes(k)).map(k => `missing:${k}`),
    ...keys.filter(k => BANNED.test(k)).map(k => `banned:${k}`),
  ];
}

const REQUEST = ["id", "node", "reference", "kind", "state", "openedAt", "openedBy", "waiting", "proposed", "version", "answer"];
const WAITER = ["lane", "workspace", "purpose", "at"];
const ANSWER = ["kind", "at", "command", "reason"];
const GRANT = ["subject", "modes", "until"];
const SECRET = ["reference", "status", "current", "versions", "grants", "destinations", "expiry", "shape", "warned"];
const VERSION = ["number", "fingerprint", "storedAt", "command", "retiredAt"];
const LEDGER = ["reference", "version", "fingerprint", "state"];
const DIRECTORY = ["held", "ledger", "events"];
const REQUEST_EVENTS: Record<RequestEvent["type"], readonly string[]> = {
  SecretRequested: ["type", "request", "node", "reference", "kind", "at"],
  SecretRequestJoined: ["type", "request", "lane", "at"],
  SecretRequestLeft: ["type", "request", "lane", "at"],
  SecretRequestWithdrawn: ["type", "request", "at"],
  SecretRequestStored: ["type", "request", "reference", "nodes", "version", "at", "command"],
  SecretRequestGranted: ["type", "request", "at", "command"],
  SecretRequestRejected: ["type", "request", "at", "command", "reason"],
  SecretRequestExpired: ["type", "request", "at"],
};
const SECRET_EVENTS: Record<SecretEvent["type"], readonly string[]> = {
  SecretStored: ["type", "reference", "version", "at", "command", "sameAs"],
  SecretRotated: ["type", "reference", "version", "at", "command", "sameAs"],
  SecretTransferred: ["type", "reference", "version", "at", "command", "from", "sameAs"],
  SecretDisabled: ["type", "reference", "at"],
  SecretEnabled: ["type", "reference", "at", "command"],
  SecretRevoked: ["type", "reference", "version", "at", "command"],
  SecretDeleted: ["type", "reference", "at", "command"],
  SecretExpired: ["type", "reference", "at"],
  ExpiryWarned: ["type", "reference", "at", "lead"],
  ExpiryChanged: ["type", "reference", "at", "command"],
  GrantAdded: ["type", "reference", "at", "command", "subject"],
  GrantRemoved: ["type", "reference", "at", "command", "subject"],
  GrantEnded: ["type", "reference", "at", "subject"],
  DestinationsChanged: ["type", "reference", "at", "command"],
  SecretUsed: ["type", "reference", "version", "at", "use", "mode", "lane", "workspace"],
  UseRefused: ["type", "reference", "at", "reason", "mode", "lane", "workspace"],
  UseEnded: ["type", "reference", "at", "use", "outcome"],
};

const T = 1_700_000_000_000;
const DAY = 86_400_000;
const REF = "secret://example-app/payments-test";
const who: Actor = { kind: "principal", command: "c1" };
const anyone: Actor = { kind: "operator" };
const grant: SecretGrant = { subject: { kind: "lane", lane: "lane-a" }, modes: ["exec"], until: { kind: "lane-end" } };
const ask: RequestAsk = {
  node: "node-a", reference: REF, kind: "new", waiter: { lane: "lane-a", workspace: "example-app", purpose: "Run the tests" },
  proposed: grant,
};

type R<T> = { ok: true; value: T } | { ok: false; error: { problem: string } };
const value = <T>(r: R<T>): T => {
  if (!r.ok) throw new Error(`refused: ${r.error.problem}`);
  return r.value;
};

function requestHistory(): RequestEvent[] {
  const a = value(openRequest(ask, "r1", T));
  const b = value(joinRequest(a.request, { lane: "lane-b", workspace: null, purpose: "Deploy" }, T + 1));
  const c = value(withdrawRequest(b.request, "lane-b", T + 2));
  const d = value(answerStored(c.request, { seen: 3, command: "c2", reference: REF, version: 1, nodes: ["node-a"] }, T + 3));
  const e = value(withdrawRequest(value(openRequest(ask, "r2", T)).request, "lane-a", T + 1));
  const f = value(answerGranted(value(openRequest({ ...ask, kind: "access" }, "r3", T)).request, { seen: 1, command: "c3" }, T + 1));
  const g = value(answerRejected(value(openRequest(ask, "r4", T)).request, { seen: 1, command: "c4", reason: null }, T + 1));
  const h = value(expireRequest(value(openRequest(ask, "r5", T)).request, T + 7 * DAY));
  return [a, b, c, d, e, f, g, h].flatMap(x => x.events);
}

function secretHistory(): SecretDirectory {
  let dir = value(storeSecret(emptySecretDirectory(), { reference: REF, fingerprint: "0123456789a1", shape: null, grants: [grant], expiry: T + 10 * DAY, destinations: [] }, who, T));
  dir = value(storeSecret(dir, { reference: REF, fingerprint: "0123456789a2", shape: null, grants: [], expiry: T + 10 * DAY, destinations: [] }, who, T + 1));
  dir = value(useSecret(dir, REF, { lane: "lane-a", workspace: null }, "exec", "u1", T + 2));
  dir = endUse(dir, REF, "u1", "exited", T + 3);
  const refused = useSecret(dir, REF, { lane: "lane-z", workspace: null }, "exec", "u2", T + 4);
  if (refused.ok || !refused.error.directory) throw new Error("expected a recorded refusal");
  dir = refused.error.directory;
  dir = value(grantSecret(dir, REF, { subject: { kind: "node" }, modes: ["exec"], until: { kind: "open" } }, who, T + 5));
  dir = value(ungrantSecret(dir, REF, { kind: "node" }, anyone, T + 6));
  dir = value(setDestinations(dir, REF, ["api.example.com"], who, T + 7));
  dir = value(setSecretExpiry(dir, REF, T + 9 * DAY, anyone, T + 8));
  dir = secretExpirySweep(dir, T + 9 * DAY);
  dir = endLaneGrants(dir, "lane-a", T + 9 * DAY + 1);
  dir = value(disableSecret(dir, REF, anyone, T + 9 * DAY + 2));
  dir = value(enableSecret(dir, REF, who, T + 9 * DAY + 3));
  dir = value(revokeSecret(dir, REF, who, T + 9 * DAY + 4));
  dir = value(deleteSecret(dir, REF, who, T + 9 * DAY + 5));
  dir = value(receiveTransfer(dir, { reference: "secret://shared/other", fingerprint: "0123456789b1", shape: "shape-a", grants: [], expiry: null, destinations: [], from: "node-b" }, who, T + 10 * DAY));
  return dir;
}

describe("Secrets: the shape of every built thing (SC1)", () => {
  it("a request, its waiter and its answer have exactly the allowed keys", () => {
    const r = value(answerRejected(value(openRequest(ask, "r1", T)).request, { seen: 1, command: "c2", reason: "no" }, T + 1)).request;
    expect(keyProblems(r, REQUEST)).toEqual([]);
    expect(keyProblems(r.waiting[0], WAITER)).toEqual([]);
    expect(keyProblems(r.answer, ANSWER)).toEqual([]);
    expect(keyProblems(r.proposed, GRANT)).toEqual([]);
  });
  it("a Secret, its versions, its Grants, the ledger and the directory have exactly the allowed keys", () => {
    const dir = value(storeSecret(emptySecretDirectory(), { reference: REF, fingerprint: "0123456789a1", shape: null, grants: [grant], expiry: null, destinations: [] }, who, T));
    expect(keyProblems(dir, DIRECTORY)).toEqual([]);
    const s = dir.held[0];
    expect(keyProblems(s, SECRET)).toEqual([]);
    expect(keyProblems(s?.current, VERSION)).toEqual([]);
    expect(keyProblems(s?.versions[0], VERSION)).toEqual([]);
    expect(keyProblems(s?.grants[0], GRANT)).toEqual([]);
    expect(keyProblems(dir.ledger[0], LEDGER)).toEqual([]);
  });
  it("every request event, each type at least once, has exactly its allowed keys", () => {
    const history = requestHistory();
    expect([...new Set(history.map(e => e.type))].sort()).toEqual(Object.keys(REQUEST_EVENTS).sort());
    for (const e of history) expect(keyProblems(e, REQUEST_EVENTS[e.type]), e.type).toEqual([]);
  });
  it("every Secret event, each type at least once, has exactly its allowed keys", () => {
    const history = secretHistory().events;
    expect([...new Set(history.map(e => e.type))].sort()).toEqual(Object.keys(SECRET_EVENTS).sort());
    for (const e of history) expect(keyProblems(e, SECRET_EVENTS[e.type]), e.type).toEqual([]);
  });
  it("the check catches an extra, a missing and a banned key (negative control)", () => {
    expect(keyProblems({ a: 1, b: 2 }, ["a"])).toEqual(["extra:b"]);
    expect(keyProblems({ a: 1 }, ["a", "c"])).toEqual(["missing:c"]);
    expect(keyProblems({ value: "x" }, ["value"])).toEqual(["banned:value"]);
    for (const k of ["secretBytes", "plaintext", "apiToken", "password", "cipherText"]) expect(k).toMatch(BANNED);
  });
});
