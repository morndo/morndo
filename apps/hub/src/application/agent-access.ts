// Agent tokens (ADR-0015, B1): how the manager's lane and the workers' lanes prove who they are to the hub when they
// change the board. A token is issued from the hub's console (the trust root, as pairing is), shown once, and kept only
// as a hash. Its `role` decides what it may act as on each call: the manager's token acts as the manager; a worker's
// token acts as the lane it names in the call, so one token can serve every lane on a machine. The name a worker token
// claims is recorded with each change as what it claimed, and the app marks an assignee that isn't a running lane.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { LANE_NAME, type BoardActor } from "@morndo/domain";
import { AGENT_SCOPES } from "@morndo/protocol";
import type { RevocationJournal } from "@morndo/service-kit";
import type { AgentToken, Store } from "../adapters/store.ts";

export const TOKEN_PREFIX = "mat_";                     // "morndo agent token"
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

export type AgentRefusal = "no_token" | "unknown_token" | "revoked" | "lane_needed" | "bad_name";

export class AgentAccess {
  #store: Store;
  #now: () => number;
  #managerName: string;
  #journal: RevocationJournal | null;
  constructor(store: Store, managerName: string, now: () => number = Date.now, journal?: RevocationJournal) {
    this.#store = store; this.#managerName = managerName; this.#now = now; this.#journal = journal ?? null;
  }

  // A new token for the console. The secret is returned once; the store keeps its hash. `scopes` (U15): what the token
  // may do beyond its role, words of the closed list only — anything else is a caller's mistake, never stored.
  issue(name: string, role: AgentToken["role"], scopes: readonly string[] = []): { token: AgentToken; secret: string } {
    for (const s of scopes) if (!(AGENT_SCOPES as readonly string[]).includes(s)) throw new TypeError(`an agent token's scope is one of: ${AGENT_SCOPES.join(", ")}`);
    const secret = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const token: AgentToken = { id: randomUUID(), name: name.trim().slice(0, 80) || role, role, scopes: [...new Set(scopes)], secretHash: hash(secret), createdAt: this.#now(), lastUsedAt: null, revokedAt: null, unboundCount: 0, lastUnboundAt: null };
    this.#store.saveAgentToken(token);
    return { token, secret };
  }
  list(): AgentToken[] { return this.#store.agentTokens(); }
  // A usage reading posted with a plain worker token, counted once per request.
  noteUnbound(id: string): void { this.#store.noteUnboundReading(id, this.#now()); }
  revoke(id: string): boolean {
    const t = this.#store.agentToken(id);
    if (!t || t.revokedAt !== null) return false;
    // RL10 (updates design §11.5): journaled before the store write, so a crash between the two is repaired at the
    // next start and a database restored from an older copy can't bring the token back.
    this.#journal?.append({ kind: "agent_token", id, at: this.#now() });
    this.#store.saveAgentToken({ ...t, revokedAt: this.#now() });
    return true;
  }

  // Who a call is from: the bearer secret, and for a worker token the lane it acts as. A manager token acts as the
  // manager whatever lane it names. Unknown and revoked look different to the caller (its own token is its own business).
  // A refusal names the token when there is one (a live token that didn't say its lane), so the caller can charge it
  // rather than the address.
  authenticate(bearer: string | null, lane: string | null): { ok: true; actor: BoardActor; token: AgentToken } | { ok: false; refused: AgentRefusal; token?: AgentToken } {
    if (!bearer || !bearer.startsWith(TOKEN_PREFIX)) return { ok: false, refused: "no_token" };
    const token = this.#store.agentTokenBySecretHash(hash(bearer));
    if (!token) return { ok: false, refused: "unknown_token" };
    if (token.revokedAt !== null) return { ok: false, refused: "revoked" };
    let actor: BoardActor;
    if (token.role === "manager") actor = { kind: "manager", name: this.#managerName, token: token.id };
    else {
      const name = (lane ?? "").trim();
      if (!name) return { ok: false, refused: "lane_needed", token };
      if (!LANE_NAME.test(name)) return { ok: false, refused: "bad_name", token };
      // A worker token naming the manager's lane acts as a worker named so: it never gains the manager's rights.
      actor = { kind: "worker", name, token: token.id };
    }
    this.#store.touchAgentToken(token.id, this.#now());
    return { ok: true, actor, token };
  }
}
