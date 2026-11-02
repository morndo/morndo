// Sign-in from the app (ADR-0039): the hub relays start, code and status to one node, holds sign-in cards as Asks, and
// keeps no link, recipient, sealed value or token in what it records.
import { randomBytes } from "node:crypto";
import {
  SIGNIN_FRESH_MS, SIGNIN_RUNTIMES, acceptsCode, checkTarget, settle, targetKey, type SignIn, type SignInPhase, type SignInTarget,
  LIVE_PHASES,
} from "@morndo/domain";
import type {
  AccountRow, AccountsView, OpArgs, OpError, OpResult, SignInView,
} from "@morndo/protocol";
import {
  RequestSignInBody as RequestSignInSchema, SignInCodeBody as SignInCodeSchema, StartSignInBody as StartSignInSchema,
} from "@morndo/protocol";
import type * as z from "zod/mini";

type StartSignInBody = z.output<typeof StartSignInSchema>;
type SignInCodeBody = z.output<typeof SignInCodeSchema>;
type RequestSignInBody = z.output<typeof RequestSignInSchema>;
import type { Authenticated } from "./access-service.ts";
import { signinAsk, signinCardId, type SignInCard } from "./signin-asks.ts";

export type SignInFleet = {
  nodes(): Promise<string[]>;
  op<O extends "signin.accounts" | "signin.start" | "signin.code" | "signin.status" | "signin.cancel">(
    node: string, op: O, args: OpArgs[O], opts?: { key?: string; timeoutMs?: number },
  ): Promise<{ ok: true; result: OpResult[O] } | { ok: false; error: OpError }>;
};

const FINAL = new Set<SignInPhase>(["done", "failed", "expired", "cancelled"]);

const SETTLED_SHOW_MS = 10 * 60_000;

function fresh(who: Authenticated, now: number): boolean {
  return who.session.verifiedAt >= now - SIGNIN_FRESH_MS;
}

function opProblem(error: OpError): string {
  if (error.code === "not_allowed" || error.code === "busy" || error.code === "bad_args") return error.message;
  return error.code;
}

function sweepWants(runtime: SignInTarget["runtime"], row: AccountRow): boolean {
  if (row.signedIn !== "missing" || row.retired) return false;
  if (runtime === "cursor") return row.name === "main";
  return row.name !== "main";
}

export class SignInService {
  #fleet: SignInFleet;
  #now: () => number;
  #audit: (entry: unknown) => void;
  #newId: () => string;
  #signins = new Map<string, SignIn>();
  #cards = new Map<string, SignInCard>();
  // Cards whose account works again: offered as settled for SETTLED_SHOW_MS, so the Decisions board moves them to
  // Decided (a hub-held Ask that merely vanishes stays open until its TTL, domain E14).
  #settled = new Map<string, { card: SignInCard; at: number }>();

  constructor(o: { fleet: SignInFleet; now: () => number; audit: (entry: unknown) => void; newId?: () => string }) {
    this.#fleet = o.fleet;
    this.#now = o.now;
    this.#audit = o.audit;
    this.#newId = o.newId ?? (() => `si-${randomBytes(9).toString("base64url")}`);
  }

  nodes(): Promise<string[]> {
    return this.#fleet.nodes();
  }

  cards(): { id: string; node: string; runtime: SignInTarget["runtime"]; account: string; create: boolean }[] {
    return [...this.#cards.values()]
      .map(c => ({ id: c.id, node: c.target.node, runtime: c.target.runtime, account: c.target.account, create: c.create }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  settled(): { ask: ReturnType<typeof signinAsk>; at: number }[] {
    const now = this.#now();
    for (const [id, s] of this.#settled) if (now - s.at > SETTLED_SHOW_MS) this.#settled.delete(id);
    return [...this.#settled.values()].sort((a, b) => a.card.id.localeCompare(b.card.id)).map(s => ({ ask: signinAsk(s.card), at: s.at }));
  }

  #settleCard(id: string): void {
    const card = this.#cards.get(id);
    if (!card) return;
    this.#cards.delete(id);
    this.#settled.set(id, { card, at: this.#now() });
  }

  asks() {
    return [...this.#cards.values()].sort((a, b) => a.id.localeCompare(b.id)).map(signinAsk);
  }

  request(body: RequestSignInBody, by: string): { ok: true; card: string } {
    void by;
    const checked = checkTarget(body);
    if (!checked.ok) throw new TypeError(checked.problem);
    const id = signinCardId(checked.target);
    if (!this.#cards.has(id)) {
      this.#cards.set(id, { id, target: checked.target, create: body.create, why: body.why, askedAt: this.#now() });
    }
    return { ok: true, card: id };
  }

  async accounts(node: string, runtime: SignInTarget["runtime"]): Promise<{ ok: true; view: AccountsView } | { ok: false; problem: string }> {
    const checked = checkTarget({ node, runtime, account: "main" });
    if (!checked.ok) return { ok: false, problem: checked.problem };
    const r = await this.#fleet.op(node, "signin.accounts", { runtime });
    if (!r.ok) return { ok: false, problem: opProblem(r.error) };
    return { ok: true, view: { node, runtime, accounts: r.result.accounts } };
  }

  async start(who: Authenticated, body: StartSignInBody): Promise<{ ok: true; view: SignInView } | { ok: false; problem: string }> {
    if (!fresh(who, this.#now())) return { ok: false, problem: "step_up" };
    const checked = checkTarget(body);
    if (!checked.ok) return { ok: false, problem: checked.problem };
    const key = targetKey(checked.target);
    const live = this.#liveFor(key);
    if (live) return { ok: true, view: this.#viewOf(live) };
    const id = this.#newId();
    const r = await this.#fleet.op(checked.target.node, "signin.start", { id, runtime: checked.target.runtime, account: checked.target.account, create: body.create }, { key: id });
    if (!r.ok) return { ok: false, problem: opProblem(r.error) };
    const now = this.#now();
    const signin: SignIn = {
      id, target: checked.target, create: body.create, phase: "waiting",
      link: r.result.link, userCode: r.result.userCode, needsCode: r.result.needsCode, recipient: r.result.recipient,
      startedAt: now, expiresAt: r.result.expiresAt, identity: null, problem: null,
    };
    this.#signins.set(id, signin);
    this.#auditEntry("signin.start", signin);
    return { ok: true, view: this.#viewOf(signin) };
  }

  async code(who: Authenticated, id: string, body: SignInCodeBody): Promise<{ ok: true; view: SignInView } | { ok: false; problem: string }> {
    const s0 = this.#signins.get(id);
    if (!s0) return { ok: false, problem: "not_found" };
    if (!fresh(who, this.#now())) return { ok: false, problem: "step_up" };
    const s = settle(s0, this.#now());
    if (s !== s0) this.#signins.set(id, s);
    if (!acceptsCode(s, this.#now())) return { ok: false, problem: "not_waiting" };
    const r = await this.#fleet.op(s.target.node, "signin.code", { id, sealed: body.sealed });
    if (!r.ok) return { ok: false, problem: opProblem(r.error) };
    if (!r.result.accepted) return { ok: false, problem: "code_refused" };
    const next = { ...s, phase: "checking" as const };
    this.#signins.set(id, next);
    this.#auditEntry("signin.code", next);
    return { ok: true, view: this.#viewOf(next) };
  }

  async view(id: string): Promise<{ ok: true; view: SignInView } | { ok: false; problem: "not_found" }> {
    const s0 = this.#signins.get(id);
    if (!s0) return { ok: false, problem: "not_found" };
    const s = await this.#refresh(s0);
    return { ok: true, view: this.#viewOf(s) };
  }

  async cancel(who: Authenticated, id: string): Promise<{ ok: true; view: SignInView } | { ok: false; problem: string }> {
    void who;
    const s0 = this.#signins.get(id);
    if (!s0) return { ok: false, problem: "not_found" };
    let s = settle(s0, this.#now());
    if (FINAL.has(s.phase)) return { ok: true, view: this.#viewOf(s) };
    const r = await this.#fleet.op(s.target.node, "signin.cancel", { id });
    if (!r.ok) return { ok: false, problem: opProblem(r.error) };
    s = { ...s, phase: "cancelled" };
    this.#signins.set(id, s);
    this.#auditEntry("signin.cancel", s);
    return { ok: true, view: this.#viewOf(s) };
  }

  async sweep(): Promise<void> {
    const nodes = await this.#fleet.nodes();
    for (const node of nodes) {
      for (const runtime of SIGNIN_RUNTIMES) {
        const r = await this.#fleet.op(node, "signin.accounts", { runtime });
        if (!r.ok) continue;
        for (const row of r.result.accounts) {
          const target: SignInTarget = { node, runtime, account: row.name };
          const id = signinCardId(target);
          if (row.signedIn === "ok") {
            this.#settleCard(id);
            continue;
          }
          if (sweepWants(runtime, row) && !this.#cards.has(id)) {
            this.#settled.delete(id);
            this.#cards.set(id, { id, target, create: false, why: null, askedAt: this.#now() });
          }
        }
      }
    }
  }

  #liveFor(key: string): SignIn | null {
    const now = this.#now();
    for (const s of this.#signins.values()) {
      if (targetKey(s.target) !== key) continue;
      const settled = settle(s, now);
      if (settled !== s) this.#signins.set(s.id, settled);
      if (LIVE_PHASES.has(settled.phase)) return settled;
    }
    return null;
  }

  async #refresh(s0: SignIn): Promise<SignIn> {
    let s = settle(s0, this.#now());
    if (s !== s0) this.#signins.set(s.id, s);
    if (!LIVE_PHASES.has(s.phase)) return s;
    const r = await this.#fleet.op(s.target.node, "signin.status", { id: s.id });
    if (!r.ok) return s;
    const prev = s.phase;
    s = { ...s, phase: r.result.phase, identity: r.result.identity, problem: r.result.problem };
    this.#signins.set(s.id, s);
    if (FINAL.has(s.phase) && !FINAL.has(prev)) this.#auditEntry("signin.end", s);
    if (s.phase === "done") this.#settleCard(signinCardId(s.target));
    return s;
  }

  #viewOf(s: SignIn): SignInView {
    return {
      id: s.id, node: s.target.node, runtime: s.target.runtime, account: s.target.account, create: s.create,
      phase: s.phase, link: s.link, userCode: s.userCode, needsCode: s.needsCode, recipient: s.recipient,
      startedAt: s.startedAt, expiresAt: s.expiresAt, identity: s.identity, problem: s.problem,
    };
  }

  #auditEntry(kind: string, s: SignIn): void {
    this.#audit({ kind, node: s.target.node, runtime: s.target.runtime, account: s.target.account, id: s.id, phase: s.phase, at: this.#now() });
  }
}
