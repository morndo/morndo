// Filing a decision brief (ADR-0023 §5): an agent token, the same lint the CLI runs, then one row per version. A worker's
// brief is a draft the manager forwards or declines (owner decision Q1). An open brief is an Ask the escalation
// service sights (`tracking: "hub"`, or the list item a `ref` names). The audit records the id, version, asker and
// token, never the text. A refusal is a log line of its codes, not an audit row.
import {
  HUB_TTL_MS, KEEP_SETTLED_MS, lintBrief,
  type Asker, type BoardActor, type BriefProblem, type DecisionBrief,
} from "@morndo/domain";
import { parseBriefMarkdown } from "../adapters/brief-template.ts";
import { log } from "../adapters/log.ts";
import type { BriefAudit, BriefRecord, BriefState, Store } from "../adapters/store.ts";
import type { EscalationService } from "./escalation-service.ts";

const MAX_OPEN = 20;
const WHY_CAP = 300;
const REF = /^ny-[A-Za-z0-9_-]{1,29}$/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000D-\u001F\u007F]/;

// What one poll sights. `ref` set: this joins that list item (the list decides E10) instead of a hub-tracked ask.
// `closed`: the asker withdrew or settled it, so the Ask is settled even when the list still has it.
export type BriefSighting = {
  id: string;
  ref: string | null;
  brief: DecisionBrief;
  version: number;
  at: number;
  asker: Asker;
  draftedBy: string | null;
  closed: { resolution: string | null; at: number } | null;
};

type Filer = { kind: "manager" | "worker"; name: string; token: string };
type Warning = BriefProblem;

export type FileResult =
  | { ok: "filed"; id: string; version: number; warnings: Warning[] }
  | { ok: "dry"; warnings: Warning[] }
  | { ok: "refused"; problems: BriefProblem[] }
  | { ok: false; problem: "bad_ref" | "ref_taken" | "too_many_open" | "not_allowed" | "no_ledger" };

export type BriefAction =
  | { ok: true; id: string; version: number; status: BriefState }
  | { ok: false; problem: "unknown" | "not_allowed" | "reason_needed" | "too_long" | "bad_text" | "too_many_open" | "not_open" | "bad_ref" | "ref_taken" | "due_past" | "no_ledger" };

export type BriefAnswer = { kind: "option"; key: string; label: string } | { kind: "words" } | null;
export type BriefSummary = {
  id: string; version: number; topic: string; headline: string; status: BriefState | "expired";
  answer: BriefAnswer; draftedBy: string | null; asker: { kind: "manager" | "worker"; name: string };
  resolution: string | null;
};
export type BriefDetail = BriefSummary & { brief: DecisionBrief };

const filer = (actor: BoardActor): Filer | null =>
  actor.kind === "principal" ? null : { kind: actor.kind, name: actor.name, token: actor.token };

export class BriefService {
  #store: Store;
  #escalations: EscalationService;
  #now: () => number;
  #managerName: string;
  #managerWorkerId: () => string | null;
  #hasLedger: boolean;

  constructor(p: {
    store: Store; escalations: EscalationService; managerName: string;
    managerWorkerId?: () => string | null; now?: () => number; hasLedger?: boolean;
  }) {
    this.#store = p.store;
    this.#escalations = p.escalations;
    this.#now = p.now ?? Date.now;
    this.#managerName = p.managerName;
    this.#managerWorkerId = p.managerWorkerId ?? (() => null);
    this.#hasLedger = p.hasLedger ?? false;
  }

  // Open briefs the principal should see, and ones the asker has closed (so the Ask leaves the list now, not seven
  // days later). Drafts stay with the manager. Called from the escalation poll; it must not poll again.
  sightings(): BriefSighting[] {
    const now = this.#now();
    const out: BriefSighting[] = [];
    for (const row of this.#store.currentBriefs()) {
      if (row.state === "open" && row.ref === null && now >= row.brief.due + HUB_TTL_MS) {
        this.#store.setBriefState(row.id, row.version, "expired", null, row.brief.due + HUB_TTL_MS);
        continue;
      }
      // A draft the manager never forwarded was never an ask: not on the board, and not a settlement of a list item.
      // A withdrawn or settled row is sighted only when the principal was the asker (he filed it, or it was forwarded).
      const shown = row.state === "open" || (row.askerKind === "manager" && (row.state === "withdrawn" || row.state === "settled"));
      if (!shown) continue;
      if ((row.state === "withdrawn" || row.state === "settled") && row.closedAt !== null && now - row.closedAt > KEEP_SETTLED_MS) continue;
      out.push(this.#sight(row));
    }
    return out;
  }

  #sight(row: BriefRecord): BriefSighting {
    const asker: Asker = row.askerKind === "manager"
      ? { kind: "manager", name: "Manager", workerId: this.#managerWorkerId() }
      : { kind: "worker", name: row.askerName, workerId: null };
    const closed = row.state === "withdrawn" || row.state === "settled"
      ? { resolution: row.resolution, at: row.closedAt ?? row.filedAt }
      : null;
    return {
      id: row.id, ref: row.ref, brief: row.brief, version: row.version, at: row.filedAt, asker,
      draftedBy: row.draftedBy, closed,
    };
  }

  file(body: { kind: "markdown"; text: string } | { kind: "json"; value: unknown }, actor: BoardActor, dry: boolean): FileResult {
    const who = filer(actor);
    if (!who) return { ok: false, problem: "not_allowed" };
    const { draft, problems } = body.kind === "markdown" ? parseBriefMarkdown(body.text) : { draft: body.value, problems: [] as BriefProblem[] };
    return this.#accept(draft, problems, who, dry, null);
  }

  restate(id: string, body: { kind: "markdown"; text: string } | { kind: "json"; value: unknown }, actor: BoardActor, dry: boolean): FileResult | { ok: false; problem: "unknown" | "not_allowed" | "not_open" } {
    const who = filer(actor);
    if (!who) return { ok: false, problem: "not_allowed" };
    const row = this.#store.brief(id);
    if (!row || !this.#canSee(row, who)) return { ok: false, problem: "unknown" };
    if (!this.#isAsker(row, who)) return { ok: false, problem: "not_allowed" };
    if (row.state !== "open" && row.state !== "draft") return { ok: false, problem: "not_open" };
    const { draft, problems } = body.kind === "markdown" ? parseBriefMarkdown(body.text) : { draft: body.value, problems: [] as BriefProblem[] };
    return this.#accept(draft, problems, who, dry, row);
  }

  #accept(draft: unknown, adapterProblems: BriefProblem[], who: Filer, dry: boolean, previous: BriefRecord | null): FileResult {
    const now = this.#now();
    const lint = lintBrief(draft, now);
    const errors = [...adapterProblems.filter(p => p.level === "error"), ...lint.problems.filter(p => p.level === "error")];
    if (errors.length || !lint.brief) {
      log.info(`brief refused (${errors.length}): ${[...new Set(errors.map(p => p.code))].join(", ")}`);
      return { ok: "refused", problems: errors };
    }
    const warnings = lint.problems.filter(p => p.level === "warning");
    const brief = lint.brief;
    const state: BriefState = previous ? previous.state : who.kind === "worker" ? "draft" : "open";
    // Only an open brief claims a ref. A draft keeps the ref in its text for a later forward, and holds no id.
    const ref = state === "open" ? brief.ref : null;
    const early = this.#filingRefusal(brief, state, ref, previous, who);
    if (early) return early;
    if (dry) return { ok: "dry", warnings };
    const result = this.#store.transaction(() => {
      const taken = ref !== null && !previous ? this.#store.brief(ref) : null;
      if (taken && this.#holdsRef(taken)) return { ok: false as const, problem: "ref_taken" as const };
      const askerKind = previous?.askerKind ?? who.kind;
      const askerName = previous?.askerName ?? who.name;
      if (state === "open" && !previous && this.#store.openBriefCount(askerKind, askerName) >= MAX_OPEN) return { ok: false as const, problem: "too_many_open" as const };
      const n = ref === null && !previous ? this.#store.peekBriefNumber() : null;
      const id = previous?.id ?? ref ?? `d-${n}`;
      const version = previous ? previous.version + 1 : (taken?.version ?? 0) + 1;
      const row: BriefRecord = {
        id, version, ref, askerKind, askerName, tokenId: who.token,
        filedByKind: previous?.filedByKind ?? who.kind, filedByName: previous?.filedByName ?? who.name,
        brief, state, filedAt: now, resolution: null, draftedBy: previous?.draftedBy ?? null, closedAt: null,
      };
      this.#store.insertBrief(row);
      if (n !== null) this.#store.takeBriefNumber(n);
      this.#audit(previous ? "BriefRestated" : "BriefFiled", row, who, now);
      return { ok: "filed" as const, id, version, warnings };
    });
    if (result.ok === "filed") this.#refresh();
    return result;
  }

  list(actor: BoardActor, o: { open: boolean; drafts: boolean }): { ok: true; requests: BriefSummary[] } | { ok: false; problem: "not_allowed" } {
    const who = filer(actor);
    if (!who) return { ok: false, problem: "not_allowed" };
    this.#refresh();
    const rows = this.#store.currentBriefs().filter(r => this.#listed(r, who, o.drafts));
    const requests = rows.filter(r => !o.open || r.state === "open").map(r => this.#summary(r));
    return { ok: true, requests };
  }

  show(actor: BoardActor, id: string): { ok: true; request: BriefDetail } | { ok: false; problem: "unknown" | "not_allowed" } {
    const who = filer(actor);
    if (!who) return { ok: false, problem: "not_allowed" };
    this.#refresh();
    const row = this.#store.brief(id);
    if (!row || !this.#canSee(row, who)) return { ok: false, problem: "unknown" };
    return { ok: true, request: { ...this.#summary(row), brief: row.brief } };
  }

  withdraw(actor: BoardActor, id: string, why: string): BriefAction {
    return this.#close(actor, id, "withdrawn", why, "BriefWithdrawn", false);
  }
  settle(actor: BoardActor, id: string, note: string | null): BriefAction {
    const why = this.#why(note ?? "", true);
    if (typeof why !== "string") return { ok: false, problem: why.problem };
    return this.#close(actor, id, "settled", why || null, "BriefSettled", true);
  }
  decline(actor: BoardActor, id: string, why: string): BriefAction {
    const who = filer(actor);
    if (!who || who.kind !== "manager") return { ok: false, problem: "not_allowed" };
    const text = this.#why(why, false);
    if (typeof text !== "string") return { ok: false, problem: text.problem };
    const row = this.#store.brief(id);
    if (!row) return { ok: false, problem: "unknown" };
    if (row.state !== "draft") return { ok: false, problem: "not_open" };
    const now = this.#now();
    this.#store.setBriefState(id, row.version, "declined", text, now);
    this.#audit("BriefDeclined", row, who, now);
    return { ok: true, id, version: row.version, status: "declined" };
  }
  forward(actor: BoardActor, id: string): BriefAction {
    const who = filer(actor);
    if (!who || who.kind !== "manager") return { ok: false, problem: "not_allowed" };
    const row = this.#store.brief(id);
    if (!row) return { ok: false, problem: "unknown" };
    if (row.state !== "draft") return { ok: false, problem: "not_open" };
    const now = this.#now();
    if (lintBrief(row.brief, now).problems.some(p => p.code === "due_past")) return { ok: false, problem: "due_past" };
    const ref = row.brief.ref;
    if (ref !== null && !REF.test(ref)) return { ok: false, problem: "bad_ref" };
    if (ref !== null && !this.#hasLedger) return { ok: false, problem: "no_ledger" };
    if (ref !== null) {
      const taken = this.#store.brief(ref);
      if (taken && this.#holdsRef(taken)) return { ok: false, problem: "ref_taken" };
    }
    if (this.#store.openBriefCount("manager", this.#managerName) >= MAX_OPEN) return { ok: false, problem: "too_many_open" };
    const claimed = ref === null
      ? { id, version: row.version }
      : this.#store.claimForward(id, row.version, ref, this.#managerName, who.token, row.askerName);
    if (ref === null) this.#store.forwardBrief(id, row.version, this.#managerName, who.token, row.askerName);
    this.#audit("BriefForwarded", { ...row, id: claimed.id, version: claimed.version }, who, this.#now());
    this.#refresh();
    return { ok: true, id: claimed.id, version: claimed.version, status: "open" };
  }

  #close(actor: BoardActor, id: string, state: "withdrawn" | "settled", why: string | null, type: BriefAudit["type"], openOnly: boolean): BriefAction {
    const who = filer(actor);
    if (!who) return { ok: false, problem: "not_allowed" };
    if (state === "withdrawn") {
      const text = this.#why(why ?? "", false);
      if (typeof text !== "string") return { ok: false, problem: text.problem };
      why = text;
    }
    const row = this.#store.brief(id);
    if (!row || !this.#canSee(row, who)) return { ok: false, problem: "unknown" };
    if (!this.#isAsker(row, who)) return { ok: false, problem: "not_allowed" };
    if (openOnly && row.state !== "open") return { ok: false, problem: "not_open" };
    if (!openOnly && row.state !== "open" && row.state !== "draft") return { ok: false, problem: "not_open" };
    const now = this.#now();
    this.#store.setBriefState(id, row.version, state, why, now);
    this.#audit(type, row, who, now);
    this.#refresh();
    return { ok: true, id, version: row.version, status: state };
  }

  #why(text: string, optional: boolean): string | { problem: "reason_needed" | "too_long" | "bad_text" } {
    const t = text.trim();
    if (!t) return optional ? "" : { problem: "reason_needed" };
    if (t.length > WHY_CAP) return { problem: "too_long" };
    if (CONTROL.test(t)) return { problem: "bad_text" };
    return t;
  }

  // Open, settled and expired rows hold the ref. A draft never does, and neither does a withdrawn or declined row.
  #holdsRef(row: BriefRecord): boolean {
    return row.state !== "draft" && row.state !== "withdrawn" && row.state !== "declined";
  }

  // The checks filing and a dry run share. A dry run returns after them and writes nothing.
  #filingRefusal(brief: DecisionBrief, state: BriefState, ref: string | null, previous: BriefRecord | null, who: Filer): FileResult | null {
    if (brief.ref !== null && !REF.test(brief.ref)) return { ok: false, problem: "bad_ref" };
    if (brief.ref !== null && !this.#hasLedger) return { ok: false, problem: "no_ledger" };
    if (previous && brief.ref !== previous.brief.ref) return { ok: false, problem: "bad_ref" };
    const taken = ref !== null && !previous ? this.#store.brief(ref) : null;
    if (taken && this.#holdsRef(taken)) return { ok: false, problem: "ref_taken" };
    const askerKind = previous?.askerKind ?? who.kind;
    const askerName = previous?.askerName ?? who.name;
    if (state === "open" && !previous && this.#openCount(askerKind, askerName) >= MAX_OPEN) return { ok: false, problem: "too_many_open" };
    return null;
  }

  #openCount(kind: "manager" | "worker", name: string): number {
    return this.#store.openBriefCount(kind, name);
  }

  #isAsker(row: BriefRecord, who: Filer): boolean {
    return row.askerKind === who.kind && row.askerName === who.name;
  }
  #canSee(row: BriefRecord, who: Filer): boolean {
    if (who.kind === "manager") return true;
    return row.filedByKind === "worker" && row.filedByName === who.name;
  }
  #listed(row: BriefRecord, who: Filer, drafts: boolean): boolean {
    if (who.kind === "worker") return row.filedByKind === "worker" && row.filedByName === who.name;
    if (row.state === "draft") return drafts;
    return row.askerKind === "manager" && row.askerName === who.name;
  }

  #summary(row: BriefRecord): BriefSummary {
    const onBoard = this.#escalations.board().items.find(i => i.id === row.id);
    let status: BriefSummary["status"] = row.state;
    if (row.state === "open" && onBoard && (onBoard.status === "settled" || onBoard.status === "expired")) status = onBoard.status;
    const choice = onBoard?.decision?.choice ?? null;
    const answer: BriefAnswer = choice === null ? null : choice.kind === "option" ? { kind: "option", key: choice.key, label: choice.label } : { kind: "words" };
    return {
      id: row.id, version: row.version, topic: row.brief.topic, headline: row.brief.headline, status,
      answer, draftedBy: row.draftedBy, asker: { kind: row.askerKind, name: row.askerName }, resolution: row.resolution,
    };
  }

  #audit(type: BriefAudit["type"], row: BriefRecord, who: Filer, at: number) {
    const event: BriefAudit = { type, id: row.id, version: row.version, asker: { kind: who.kind, name: who.name }, token: who.token, at };
    this.#store.record([event]);
  }

  // The board after this poll. A ref the list has actually closed is closed on the row too (E10), so it stops counting
  // as open. A "missing" item the grace window has temporarily called settled is not a decision and is not stored.
  #refresh() {
    this.#escalations.poll();
    for (const item of this.#escalations.board().items) {
      const row = this.#store.brief(item.id);
      if (!row || row.state !== "open") continue;
      const settled = item.source === "settled";
      const expired = item.status === "expired" && item.source !== "missing";
      if (!settled && !expired) continue;
      this.#store.setBriefState(row.id, row.version, settled ? "settled" : "expired", item.resolution, item.settledAt ?? this.#now());
    }
  }
}
