// Sign-in from the app (ADR-0039): the hub relays a sign-in between the app and one node, holds the cards, and keeps no
// code, link or key in what it records. Locked by the keryx run app-sign-in.
import { describe, expect, it } from "vitest";
import type { Endpoint, EndpointId, Session, SessionId } from "@morndo/domain";
import type { OpError } from "@morndo/protocol";
import { SignInService, type SignInFleet } from "../src/application/signin-service.ts";

const NOW = 1_800_000_000_000;
const LINK = "https://claude.com/cai/oauth/authorize?code=true&state=s1";
const RECIPIENT = "age1qqexamplerecipientqq";
const session = (verifiedAt: number): Session => ({
  id: "s" as SessionId, endpointId: "e" as EndpointId, startedAt: NOW, lastSeenAt: NOW, verifiedAt, endedAt: null, endReason: null,
});
const fresh = { session: session(NOW - 60_000), endpoint: {} as Endpoint };
const stale = { session: session(NOW - 6 * 60_000), endpoint: {} as Endpoint };

type Call = { node: string; op: string; args: Record<string, unknown>; key?: string };
function setup(o: { status?: () => Record<string, unknown>; accounts?: (runtime: string) => unknown[]; startError?: OpError } = {}) {
  const calls: Call[] = [];
  const audits: unknown[] = [];
  let n = 0;
  const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
    "signin.start": a => ({ link: a.runtime === "cursor" ? "https://cursor.com/loginDeepControl?challenge=c" : LINK, userCode: null, needsCode: a.runtime === "claude", recipient: a.runtime === "claude" ? RECIPIENT : null, expiresAt: NOW + 600_000 }),
    "signin.code": () => ({ accepted: true }),
    "signin.status": () => (o.status ?? (() => ({ phase: "waiting", identity: null, problem: null })))(),
    "signin.cancel": () => ({ cancelled: true }),
    "signin.accounts": a => ({ accounts: (o.accounts ?? (() => []))(String(a.runtime)) }),
  };
  const fleet: SignInFleet = {
    nodes: async () => ["n1"],
    op: (async (node: string, op: string, args: Record<string, unknown>, opts?: { key?: string }) => {
      calls.push({ node, op, args, ...(opts?.key ? { key: opts.key } : {}) });
      if (op === "signin.start" && o.startError) return { ok: false, error: o.startError };
      return { ok: true, result: answers[op]!(args) };
    }) as SignInFleet["op"],
  };
  const service = new SignInService({ fleet, now: () => NOW, audit: e => audits.push(e), newId: () => `si-t${++n}` });
  return { service, calls, audits };
}

describe("the hub's sign-in relay (ADR-0039)", () => {
  it("starts nothing without a passkey check from the last 5 minutes (SI7)", async () => {
    const { service, calls } = setup();
    expect(await service.start(stale, { node: "n1", runtime: "claude", account: "a1", create: false })).toEqual({ ok: false, problem: "step_up" });
    expect(calls).toEqual([]);
  });

  it("starts one sign-in per account, keyed by its id, and hands the second tap the same one (SI1)", async () => {
    const { service, calls } = setup();
    const first = await service.start(fresh, { node: "n1", runtime: "claude", account: "a1", create: false });
    if (!first.ok) throw new Error(first.problem);
    expect(first.view).toMatchObject({ id: "si-t1", node: "n1", runtime: "claude", account: "a1", phase: "waiting", link: LINK, needsCode: true, recipient: RECIPIENT });
    const second = await service.start(fresh, { node: "n1", runtime: "claude", account: "a1", create: false });
    expect(second.ok && second.view.id).toBe("si-t1");
    expect(calls.filter(c => c.op === "signin.start")).toEqual([
      { node: "n1", op: "signin.start", args: { id: "si-t1", runtime: "claude", account: "a1", create: false }, key: "si-t1" },
    ]);
  });

  it("refuses a named Cursor account and passes a node's refusal on in its own words", async () => {
    const { service, calls } = setup();
    expect(await service.start(fresh, { node: "n1", runtime: "cursor", account: "c2", create: true })).toEqual({ ok: false, problem: "cursor_main_only" });
    expect(calls).toEqual([]);
    const refused = setup({ startError: { code: "not_allowed", executed: "no", message: "no_account" } });
    expect(await refused.service.start(fresh, { node: "n1", runtime: "claude", account: "a5", create: false })).toEqual({ ok: false, problem: "no_account" });
  });

  it("relays only the sealed code, after a fresh passkey, and records no code, link or key (SI6)", async () => {
    const { service, calls, audits } = setup();
    const s = await service.start(fresh, { node: "n1", runtime: "claude", account: "a1", create: false });
    if (!s.ok) throw new Error(s.problem);
    const sealed = "YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBzZWFsZWQ=";
    expect(await service.code(stale, s.view.id, { sealed })).toEqual({ ok: false, problem: "step_up" });
    expect(calls.some(c => c.op === "signin.code")).toBe(false);
    const sent = await service.code(fresh, s.view.id, { sealed });
    expect(sent.ok).toBe(true);
    expect(calls.filter(c => c.op === "signin.code")).toEqual([{ node: "n1", op: "signin.code", args: { id: "si-t1", sealed } }]);
    const recorded = JSON.stringify(audits);
    expect(audits.length).toBeGreaterThan(0);
    for (const secretish of [sealed, LINK, RECIPIENT]) expect(recorded).not.toContain(secretish);
  });

  it("reads a live sign-in's state from its node and stops asking once it is finished", async () => {
    let phase = "waiting";
    const { service, calls } = setup({ status: () => ({ phase, identity: phase === "done" ? { email: "person@example.com", plan: "max" } : null, problem: null }) });
    const s = await service.start(fresh, { node: "n1", runtime: "claude", account: "a1", create: false });
    if (!s.ok) throw new Error(s.problem);
    expect((await service.view(s.view.id))).toMatchObject({ ok: true, view: { phase: "waiting" } });
    phase = "done";
    expect((await service.view(s.view.id))).toMatchObject({ ok: true, view: { phase: "done", identity: { email: "person@example.com", plan: "max" } } });
    const asked = calls.filter(c => c.op === "signin.status").length;
    await service.view(s.view.id);
    expect(calls.filter(c => c.op === "signin.status").length).toBe(asked);
    expect(await service.code(fresh, s.view.id, { sealed: "YWdl" })).toEqual({ ok: false, problem: "not_waiting" });
    expect(await service.view("si-unknown")).toEqual({ ok: false, problem: "not_found" });
  });

  it("raises one card per signed-out account in rotation, none for a retired one or the main login, and settles it when the account works (sweep)", async () => {
    let a1 = "missing";
    const { service } = setup({
      accounts: runtime => runtime === "claude"
        ? [{ name: "main", signedIn: "missing", retired: false, plan: null }, { name: "a1", signedIn: a1, retired: false, plan: "max" },
          { name: "a2", signedIn: "ok", retired: false, plan: "max" }, { name: "a4", signedIn: "missing", retired: true, plan: "max" }]
        : [{ name: "main", signedIn: "ok", retired: false, plan: null }],
    });
    await service.sweep();
    await service.sweep();
    const asks = service.asks();
    expect(asks.map(a => a.id)).toEqual(["signin-n1-claude-a1"]);
    expect(asks[0]).toMatchObject({ title: "Claude a1 on n1 is signed out", need: "time", tracking: "hub", asker: { kind: "worker", name: "sign-in" } });
    expect(asks[0]!.options.map(o => o.key)).toEqual(["signin"]);
    a1 = "ok";
    await service.sweep();
    expect(service.asks()).toEqual([]);
  });

  it("lets an agent ask for a card, once, and never start one (SI8); the card goes when that account is signed in", async () => {
    const { service, calls } = setup({ status: () => ({ phase: "done", identity: { email: "person@example.com", plan: "max" }, problem: null }) });
    expect(service.request({ node: "n1", runtime: "claude", account: "a9", create: true, why: "one account left in the pool" }, "manager"))
      .toEqual({ ok: true, card: "signin-n1-claude-a9" });
    service.request({ node: "n1", runtime: "claude", account: "a9", create: true, why: "again" }, "manager");
    expect(service.asks().map(a => [a.id, a.title])).toEqual([["signin-n1-claude-a9", "Add Claude account a9 on n1"]]);
    expect(calls).toEqual([]);
    const s = await service.start(fresh, { node: "n1", runtime: "claude", account: "a9", create: true });
    if (!s.ok) throw new Error(s.problem);
    await service.view(s.view.id);
    expect(service.asks()).toEqual([]);
  });
});
