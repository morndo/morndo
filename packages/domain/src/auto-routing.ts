// Auto routing (ADR-0020; R16–R28). Pure: profile, hard rules, rules pick, scorecard, standing.
// The decider's fences and the decision step land with PR 7. No vendor is named here.
import { err, ok, unreachable, type Result } from "./shared.ts";

export type Tier = "routine" | "standard" | "hard";
export type Size = "S" | "M" | "L" | "XL" | "unknown";
export type TaskKind = "fix" | "feature" | "refactor" | "test" | "docs" | "chore" | "review-fix" | "unknown";
export type ModelClass = "flagship" | "everyday" | "fast" | "unknown";
export type Level = "held" | Tier;
export type Band = "A" | "B" | "C" | "new";
export type Source = "flag" | "board" | "lane-task" | "branch" | "diff" | "findings" | "brief" | "picks" | "ledger" | "default";
export type Signal<T> = { value: T; source: Source };
export type GateVerdict = "ok" | "not-ours" | "off" | "terms" | "expired" | "repo" | "isolation" | "dialect" | "leases" | "budget";

export const RULES_VERSION = "rules-v1";
export const DEFAULT_RESERVE = 5;
export const DEFAULT_DAILY_CAP = 10;
const QUOTA_LINE = 0.9;
const DAY = 86_400_000;
const SCORE_WINDOW = 90 * DAY;
const SCORE_KEEP = 20;
const UNKNOWN_AFTER = 7 * DAY;
const TOKEN = /^[a-z0-9-]{1,64}$/;

// USD per 1M tokens, the catalog's price unit (design section 6.2). Input millions, then output millions.
const PRIOR_MILLIONS: Record<Size, readonly [number, number]> = {
  S: [0.3, 0.03], M: [1.5, 0.1], L: [5, 0.3], XL: [12, 0.6], unknown: [1.5, 0.1],
};

const ROUTINE_KINDS: readonly TaskKind[] = ["docs", "test", "chore", "fix", "review-fix"];
const TITLE_KIND: Readonly<Record<string, TaskKind>> = {
  fix: "fix", docs: "docs", test: "test", refactor: "refactor", chore: "chore", feat: "feature",
};
const BRANCH_PREFIX: readonly (readonly [string, TaskKind])[] = [
  ["fix/", "fix"], ["docs/", "docs"], ["test/", "test"], ["refactor/", "refactor"], ["chore/", "chore"], ["feat/", "feature"],
];
const KEYWORDS: readonly (readonly [string, TaskKind])[] = [["readme", "docs"], ["documentation", "docs"]];

const LEVEL_RANK: Record<Level, number> = { held: 0, routine: 1, standard: 2, hard: 3 };
const BAND_RANK: Record<Band, number> = { A: 0, B: 1, new: 2, C: 3 };
const CLASS_RANK: Record<ModelClass, number> = { flagship: 0, everyday: 1, fast: 2, unknown: 3 };
const TRUST: Record<OutcomeSource, number> = { principal: 5, review: 4, board: 3, lease: 2, ledger: 1 };

export type TaskProfile = {
  role: string;
  group: string;
  risk: Signal<boolean>;
  kind: Signal<TaskKind>;
  size: Signal<Size>;
  round: Signal<number>;
  priority: Signal<"high" | "normal" | "low">;
  workspace: string;
  languages: readonly string[];
  task: string | null;
  lane: string | null;
  implementers: readonly { entry: string; family: string }[];
  brief: { digest: string; items: number; paths: number } | null;
};

export type ProfileInput = {
  role: string;
  workspace: string;
  risk?: boolean;
  kind?: TaskKind;
  size?: Size;
  round?: number;
  priority?: "high" | "normal" | "low";
  languages?: readonly string[];
  task?: string | null;
  lane?: string | null;
  implementers?: readonly { entry: string; family: string }[];
  title?: string;
  branch?: string;
  brief?: { digest: string; items: number; paths: number } | null;
  diff?: { lines: number; files: number } | null;
  findings?: number | null;
  reviewRun?: boolean;
  fixRound?: boolean;
};

export type CandidateFacts = {
  entry: string;
  connection: string;
  kindOf: "subscription" | "api-key";
  family: string;
  modelClass: ModelClass;
  inChain: boolean;
  rank: number;
  available: true | { reason: string; until: number | null };
  gate: GateVerdict;
  reservation: number | null;
  expectedUsd: number | null;
  costFrom: "scorecard" | "prior" | null;
  committedToday: number | null;
  dailyCap: number | null;
  window: number | null;
  level: Level;
  band: Band;
  minutes: number | null;
  heldSince: number | null;
  heldWhy: "demotion" | "pin" | null;
};

export type AutoSettings = {
  taskCeiling: number;
  saveLine: number;
  dailyCaps: Readonly<Record<string, number>>;
  reserves: Readonly<Record<string, number>>;
};

export const DEFAULT_AUTO_SETTINGS: AutoSettings = { taskCeiling: 3, saveLine: 0.5, dailyCaps: {}, reserves: {} };

export type Reason = { code: string; stage: "rules" | "declined"; n?: number; name?: string };
export type Decline = "off" | "role-off" | "hand" | "drifted" | "none-eligible";

export type RulesResult = {
  tier: Tier;
  pick: string | null;
  rulesPick: string | null;
  chain: readonly string[];
  ranked: readonly string[];
  excluded: readonly { entry: string; reason: Reason }[];
  reasons: readonly Reason[];
  stage: "rules";
  declined: Decline | null;
};

export type DecideInput = {
  role: string;
  reviewRule: boolean;
  implementerFamilies: readonly string[];
  reviewFamilies: readonly string[];
  candidates: readonly CandidateFacts[];
  profile: TaskProfile;
  settings: AutoSettings;
  derived: readonly string[];
};

export function roleGroup(role: string): string {
  const cut = role.indexOf("-");
  return cut === -1 ? role : role.slice(0, cut);
}

function modelId(model: string): string {
  const cut = model.indexOf("[");
  return cut === -1 ? model : model.slice(0, cut);
}

export function familyOf(model: string, families: readonly { pattern: string; family: string }[], presetFamily: string): string {
  const id = modelId(model);
  return families.find(row => glob(row.pattern, id))?.family ?? presetFamily;
}

export function modelClassOf(model: string, rows: readonly { pattern: string; class: ModelClass }[]): ModelClass {
  const id = modelId(model);
  return rows.find(row => glob(row.pattern, id))?.class ?? "unknown";
}

function glob(pattern: string, model: string): boolean {
  const body = pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}$`).test(model);
}

export function expectedUsd(
  size: Size,
  price: { input: number; output: number } | null,
  recorded: { n: number; median: number | null },
): { usd: number; from: "scorecard" | "prior" } | null {
  if (recorded.n >= 5 && recorded.median !== null) return { usd: recorded.median, from: "scorecard" };
  if (!price) return null;
  const [inputM, outputM] = PRIOR_MILLIONS[size];
  const usd = Math.round((inputM * price.input + outputM * price.output) * 1e6) / 1e6;
  return { usd, from: "prior" };
}

export function reserveFor(settings: AutoSettings, role: string): number {
  return settings.reserves[role] ?? DEFAULT_RESERVE;
}

export function dailyCapFor(settings: AutoSettings, connection: string): number {
  return settings.dailyCaps[connection] ?? DEFAULT_DAILY_CAP;
}

export function reasonOk(reason: Reason): boolean {
  if (!TOKEN.test(reason.code)) return false;
  if (reason.name !== undefined && !TOKEN.test(reason.name)) return false;
  if (reason.n !== undefined && !Number.isFinite(reason.n)) return false;
  return reason.stage === "rules" || reason.stage === "declined";
}

export function taskProfile(input: ProfileInput): TaskProfile {
  return {
    role: input.role,
    group: roleGroup(input.role),
    risk: input.risk === undefined ? { value: false, source: "default" } : { value: input.risk, source: "flag" },
    kind: kindOf(input),
    size: sizeOf(input),
    round: input.round === undefined ? { value: 1, source: "default" } : { value: input.round, source: "flag" },
    priority: input.priority === undefined ? { value: "normal", source: "default" } : { value: input.priority, source: "board" },
    workspace: input.workspace,
    languages: input.languages ?? [],
    task: input.task ?? null,
    lane: input.lane ?? null,
    implementers: input.implementers ?? [],
    brief: input.brief ? { digest: input.brief.digest, items: input.brief.items, paths: input.brief.paths } : null,
  };
}

function kindOf(input: ProfileInput): Signal<TaskKind> {
  if (input.kind) return { value: input.kind, source: "flag" };
  const title = input.title?.trim().toLowerCase() ?? "";
  const titled = /^(fix|docs|test|refactor|chore|feat)(\([^)]*\))?!?:/.exec(title);
  if (titled?.[1]) {
    const kind = TITLE_KIND[titled[1]];
    if (kind) return { value: kind, source: "board" };
  }
  const branch = input.branch?.trim().toLowerCase() ?? "";
  for (const [prefix, kind] of BRANCH_PREFIX) if (branch.startsWith(prefix)) return { value: kind, source: "branch" };
  for (const [word, kind] of KEYWORDS) if (new RegExp(`\\b${word}\\b`, "i").test(title)) return { value: kind, source: "board" };
  if ((input.round ?? 1) > 1) return { value: "review-fix", source: "ledger" };
  return { value: "unknown", source: "default" };
}

function sizeOf(input: ProfileInput): Signal<Size> {
  if (input.size) return { value: input.size, source: "flag" };
  if (input.reviewRun && input.diff) return { value: diffSize(input.diff.lines, input.diff.files), source: "diff" };
  if (input.fixRound && input.findings !== undefined && input.findings !== null) return { value: findingsSize(input.findings), source: "findings" };
  if (input.brief) return { value: briefSize(input.brief.items, input.brief.paths), source: "brief" };
  return { value: "unknown", source: "default" };
}

function diffSize(lines: number, files: number): Size {
  if (lines <= 50 && files <= 3) return "S";
  if (lines <= 400 && files <= 15) return "M";
  if (lines <= 1500) return "L";
  return "XL";
}

function findingsSize(n: number): Size {
  if (n <= 2) return "S";
  if (n <= 5) return "M";
  return "L";
}

function briefSize(items: number, paths: number): Size {
  if (items >= 12 || paths >= 25) return "XL";
  if (items >= 6 || paths >= 10) return "L";
  if (items <= 2 && paths <= 2) return "S";
  return "M";
}

export function tierOf(profile: TaskProfile): { tier: Tier; reason: Reason } {
  if (profile.risk.value) return { tier: "hard", reason: { code: "risk", stage: "rules" } };
  if (profile.round.value >= 3) return { tier: "hard", reason: { code: "third-round", stage: "rules" } };
  if (profile.size.value === "L" || profile.size.value === "XL") return { tier: "hard", reason: { code: "large", stage: "rules" } };
  if (profile.size.value === "S" && ROUTINE_KINDS.includes(profile.kind.value) && profile.priority.value !== "high") {
    return { tier: "routine", reason: { code: "small-routine-kind", stage: "rules" } };
  }
  return { tier: "standard", reason: { code: "default", stage: "rules" } };
}

export function autoRouted(input: {
  globalAuto: boolean;
  roleAuto: boolean;
  override: "follow" | "own" | "hand";
  drifted: boolean;
}): { auto: true } | { auto: false; reason: "off" | "role-off" | "hand" | "drifted" } {
  if (!input.globalAuto) return { auto: false, reason: "off" };
  if (!input.roleAuto) return { auto: false, reason: "role-off" };
  if (input.override === "hand") return { auto: false, reason: "hand" };
  if (input.drifted) return { auto: false, reason: "drifted" };
  return { auto: true };
}

export function route(input: DecideInput & {
  globalAuto: boolean;
  roleAuto: boolean;
  override: "follow" | "own" | "hand";
  drifted: boolean;
}): RulesResult {
  const gate = autoRouted(input);
  if (!gate.auto) {
    return {
      tier: tierOf(input.profile).tier, pick: null, rulesPick: null, chain: [...input.derived], ranked: [],
      excluded: [], reasons: [{ code: gate.reason, stage: "declined" }], stage: "rules", declined: gate.reason,
    };
  }
  return decide(input);
}

export function decide(input: DecideInput): RulesResult {
  const { tier } = tierOf(input.profile);
  const excluded: { entry: string; reason: Reason }[] = [];
  const eligible: CandidateFacts[] = [];
  for (const candidate of input.candidates) {
    const reason = firstExclusion(candidate, input);
    if (reason) excluded.push({ entry: candidate.entry, reason });
    else eligible.push(candidate);
  }
  const ranked = eligible.map(candidate => ({ candidate, keys: sortKey(tier, candidate, input.settings, input.derived) }))
    .sort((a, b) => compare(a.keys, b.keys));
  const pick = ranked[0]?.candidate ?? null;
  const chain = pick === null ? [...input.derived] : [pick.entry, ...input.derived.filter(entry => entry !== pick.entry)];
  return {
    tier,
    pick: pick?.entry ?? null,
    rulesPick: pick?.entry ?? null,
    chain,
    ranked: ranked.map(row => row.candidate.entry),
    excluded,
    reasons: pick ? [pickReason(tier, pick, ranked[1]?.candidate, input.settings, input.derived)] : [],
    stage: "rules",
    declined: pick === null ? "none-eligible" : null,
  };
}

function firstExclusion(candidate: CandidateFacts, input: DecideInput): Reason | null {
  if (!candidate.inChain || !input.derived.includes(candidate.entry)) return { code: "not-in-chain", stage: "rules" };
  if (candidate.family === "unknown") return { code: "unknown-family", stage: "rules" };
  if (candidate.available !== true) {
    const reason: Reason = { code: "unavailable", stage: "rules" };
    const name = tokenName(candidate.available.reason);
    if (name) reason.name = name;
    if (candidate.available.until !== null) reason.n = candidate.available.until;
    return reason;
  }
  if (candidate.gate !== "ok" && candidate.gate !== "not-ours") return { code: "gate", stage: "rules", name: candidate.gate };
  const budget = budgetExclusion(candidate);
  if (budget) return budget;
  if (candidate.kindOf === "subscription" && candidate.window !== null && candidate.window >= QUOTA_LINE) {
    return { code: "quota", stage: "rules", n: candidate.window };
  }
  const review = reviewExclusion(candidate, input);
  if (review) return review;
  if (candidate.level === "held") {
    const reason: Reason = { code: "held", stage: "rules" };
    const held = tokenName(candidate.heldWhy ?? undefined);
    if (held) reason.name = held;
    if (candidate.heldSince !== null) reason.n = candidate.heldSince;
    return reason;
  }
  return null;
}

function cents(usd: number): number {
  return Math.round(usd * 100);
}

function budgetExclusion(candidate: CandidateFacts): Reason | null {
  if (candidate.kindOf !== "api-key") return null;
  const cap = candidate.dailyCap;
  const spent = candidate.committedToday;
  if (candidate.expectedUsd === null) {
    if (cap !== null && spent !== null && cents(spent) >= cents(cap)) return { code: "budget", stage: "rules", name: "daily-cap" };
    return null;
  }
  if (candidate.reservation !== null && cents(candidate.expectedUsd) > cents(candidate.reservation)) {
    return { code: "budget", stage: "rules", name: "reservation", n: candidate.expectedUsd };
  }
  if (cap !== null && spent !== null && cents(spent) + cents(candidate.expectedUsd) > cents(cap)) {
    return { code: "budget", stage: "rules", name: "daily-cap", n: candidate.expectedUsd };
  }
  return null;
}

function knownFamilies(families: readonly string[]): string[] {
  return families.filter(family => family !== "unknown");
}

function reviewExclusion(candidate: CandidateFacts, input: DecideInput): Reason | null {
  if (!input.reviewRule) return null;
  if (roleGroup(input.role) !== "implement") {
    return knownFamilies(input.implementerFamilies).includes(candidate.family) ? { code: "review", stage: "rules", name: candidate.family } : null;
  }
  const reviewers = knownFamilies(input.reviewFamilies);
  if (reviewers.length === 0) return null;
  const blocked = new Set([...knownFamilies(input.implementerFamilies), candidate.family].filter(family => family !== "unknown"));
  return reviewers.some(family => !blocked.has(family)) ? null : { code: "review", stage: "rules", name: candidate.family };
}

function tokenName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const name = raw.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return TOKEN.test(name) ? name : undefined;
}

type CostRank = { rank: number; usd: number };

function costRank(candidate: CandidateFacts, settings: AutoSettings): CostRank {
  if (candidate.gate === "not-ours") return { rank: 4, usd: 0 };
  if (candidate.kindOf === "subscription") {
    if (candidate.window !== null && candidate.window < settings.saveLine) return { rank: 0, usd: 0 };
    return { rank: 2, usd: 0 };
  }
  if (candidate.expectedUsd === null) return { rank: 4, usd: 0 };
  if (candidate.expectedUsd <= settings.taskCeiling) return { rank: 1, usd: candidate.expectedUsd };
  return { rank: 3, usd: candidate.expectedUsd };
}

function trustedFor(level: Level, tier: Tier): boolean {
  if (level === "held") return false;
  return LEVEL_RANK[level] >= LEVEL_RANK[tier];
}

function sortKey(tier: Tier, candidate: CandidateFacts, settings: AutoSettings, derived: readonly string[]): number[] {
  const trust = tier === "routine" ? 0 : trustedFor(candidate.level, tier) ? 0 : 1;
  const band = BAND_RANK[candidate.band];
  const model = CLASS_RANK[candidate.modelClass];
  const minutes = candidate.minutes ?? Number.POSITIVE_INFINITY;
  const cost = costRank(candidate, settings);
  const place = derived.indexOf(candidate.entry);
  const order = place === -1 ? Number.POSITIVE_INFINITY : place;
  if (tier === "hard") return [trust, band, model, order];
  if (tier === "standard") return [trust, cost.rank, cost.usd, band, minutes, order];
  if (tier === "routine") return [cost.rank, cost.usd, band, minutes, order];
  return unreachable(tier);
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left === right) continue;
    if (!Number.isFinite(left) && !Number.isFinite(right)) continue;
    if (!Number.isFinite(left)) return 1;
    if (!Number.isFinite(right)) return -1;
    return left - right;
  }
  return 0;
}

function pickReason(tier: Tier, winner: CandidateFacts, other: CandidateFacts | undefined, settings: AutoSettings, derived: readonly string[]): Reason {
  if (tier !== "routine" && !trustedFor(winner.level, tier)) return { code: "no-trusted-available", stage: "rules" };
  if (!other) return { code: soleCode(tier, winner, settings), stage: "rules" };
  const left = sortKey(tier, winner, settings, derived);
  const right = sortKey(tier, other, settings, derived);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return { code: keyCode(tier, i, winner, settings), stage: "rules" };
  }
  return { code: "role-order", stage: "rules" };
}

function soleCode(tier: Tier, winner: CandidateFacts, settings: AutoSettings): string {
  if (tier === "hard") return "trusted-for";
  return costRank(winner, settings).rank === 0 ? "included" : "cheapest";
}

function keyCode(tier: Tier, index: number, winner: CandidateFacts, settings: AutoSettings): string {
  if (tier === "hard") return ["trusted-for", "band", "model-class", "role-order"][index] ?? "role-order";
  const costAt = tier === "standard" ? index === 1 || index === 2 : index === 0 || index === 1;
  if (costAt) return costRank(winner, settings).rank === 0 ? "included" : "cheapest";
  if (tier === "standard" && index === 0) return "trusted-for";
  if ((tier === "standard" && index === 3) || (tier === "routine" && index === 2)) return "band";
  if ((tier === "standard" && index === 4) || (tier === "routine" && index === 3)) return "minutes";
  return "role-order";
}

export type AutoChange =
  | { kind: "global-auto"; on: boolean }
  | { kind: "role-auto"; on: boolean; plainStartsOnKey: boolean }
  | { kind: "task-ceiling"; from: number; to: number }
  | { kind: "save-line"; from: number; to: number }
  | { kind: "daily-cap"; from: number; to: number }
  | { kind: "reserve"; from: number; to: number }
  | { kind: "pin"; from: Level; to: Level; sharesChainWithMetered: boolean };

export function changeEffect(change: AutoChange): "session" | "step-up" {
  switch (change.kind) {
    case "global-auto":
    case "role-auto":
    case "save-line":
      return "step-up";
    case "task-ceiling":
    case "daily-cap":
    case "reserve":
      return change.to < change.from ? "session" : "step-up";
    case "pin":
      if (LEVEL_RANK[change.to] > LEVEL_RANK[change.from]) return "step-up";
      if (LEVEL_RANK[change.to] < LEVEL_RANK[change.from]) return change.sharesChainWithMetered ? "step-up" : "session";
      return "session";
    default:
      return unreachable(change);
  }
}

export type OutcomeSource = "principal" | "review" | "board" | "lease" | "ledger";
export type FactKind = "ran" | "fell-back" | "model" | "cost" | "minutes" | "accepted" | "send-backs" | "findings" | "fix-rounds";
export type SpendKind = "estimate" | "provider" | "manual" | "balance";

export type OutcomeFact = {
  route: string;
  at: number;
  kind: FactKind;
  source: OutcomeSource;
  n?: number;
  usd?: number;
  spend?: SpendKind;
  text?: string;
  bool?: boolean;
  by?: string;
  byLane?: string | null;
  lease?: string;
};

const SOURCES: readonly OutcomeSource[] = ["principal", "review", "board", "lease", "ledger"];
const KINDS: readonly FactKind[] = ["ran", "fell-back", "model", "cost", "minutes", "accepted", "send-backs", "findings", "fix-rounds"];
const SPENDS: readonly SpendKind[] = ["estimate", "provider", "manual", "balance"];

export function parseFact(raw: unknown): Result<OutcomeFact, { problem: "refused" }> {
  if (typeof raw !== "object" || raw === null) return err({ problem: "refused" });
  const row = raw as Record<string, unknown>;
  if (typeof row.source !== "string" || !SOURCES.includes(row.source as OutcomeSource)) return err({ problem: "refused" });
  if (typeof row.kind !== "string" || !KINDS.includes(row.kind as FactKind)) return err({ problem: "refused" });
  if (typeof row.route !== "string" || typeof row.at !== "number" || !Number.isFinite(row.at)) return err({ problem: "refused" });
  if (typeof row.text === "string" && row.text.includes("STATUS:")) return err({ problem: "refused" });
  if (typeof row.n === "number" && !Number.isFinite(row.n)) return err({ problem: "refused" });
  if (typeof row.usd === "number" && !Number.isFinite(row.usd)) return err({ problem: "refused" });
  const fact: OutcomeFact = { route: row.route, at: row.at, kind: row.kind as FactKind, source: row.source as OutcomeSource };
  if (typeof row.n === "number") fact.n = row.n;
  if (typeof row.usd === "number") fact.usd = row.usd;
  if (typeof row.spend === "string" && SPENDS.includes(row.spend as SpendKind)) fact.spend = row.spend as SpendKind;
  if (typeof row.text === "string") fact.text = row.text;
  if (typeof row.bool === "boolean") fact.bool = row.bool;
  if (typeof row.by === "string") fact.by = row.by;
  if (typeof row.byLane === "string" || row.byLane === null) fact.byLane = row.byLane as string | null;
  if (typeof row.lease === "string") fact.lease = row.lease;
  return ok(fact);
}

export function recordFact(
  facts: readonly OutcomeFact[],
  fact: OutcomeFact,
  judged: { lane: string | null },
): Result<readonly OutcomeFact[], { problem: "refused" | "trust" | "estimate" | "lane" | "by" }> {
  if (!Number.isFinite(fact.at)) return err({ problem: "refused" });
  if (fact.n !== undefined && !Number.isFinite(fact.n)) return err({ problem: "refused" });
  if (fact.usd !== undefined && !Number.isFinite(fact.usd)) return err({ problem: "refused" });
  if (typeof fact.text === "string" && fact.text.includes("STATUS:")) return err({ problem: "refused" });
  if (fact.source === "review") {
    if (!fact.by) return err({ problem: "by" });
    if (!fact.byLane || !judged.lane) return err({ problem: "lane" });
    if (fact.byLane === judged.lane) return err({ problem: "lane" });
  }
  if (fact.kind === "cost" && fact.spend === "estimate" && fact.usd !== undefined) {
    const current = winning(facts.filter(other => other.lease === fact.lease), fact.route, "cost");
    if (current?.usd !== undefined && fact.usd < current.usd) return err({ problem: "estimate" });
  }
  return ok([...facts, fact]);
}

function winning(facts: readonly OutcomeFact[], route: string, kind: FactKind): OutcomeFact | null {
  const rows = facts.filter(fact => fact.route === route && fact.kind === kind);
  rows.sort((a, b) => TRUST[b.source] - TRUST[a.source] || b.at - a.at);
  return rows[0] ?? null;
}

// Cost and minutes belong to a Lease: a route's Outcome adds up one winning fact per Lease (design 7.1).
function leaseTotal(facts: readonly OutcomeFact[], route: string, kind: "cost" | "minutes"): number | null {
  const rows = facts.filter(fact => fact.route === route && fact.kind === kind);
  let total: number | null = null;
  for (const lease of new Set(rows.map(fact => fact.lease ?? ""))) {
    const won = winning(rows.filter(fact => (fact.lease ?? "") === lease), route, kind);
    const amount = kind === "cost" ? won?.usd : won?.n;
    if (amount !== undefined) total = (total ?? 0) + amount;
  }
  return total;
}

export type ScoreRun = { id: string; at: number; group: string; tier: Tier; task: string | null; lane: string | null };
export type ScoreCell = {
  entry: string;
  group: string;
  tier: Tier;
  coverage: number;
  n: number;
  k: number;
  findings: number | null;
  fixRounds: number;
  medianUsd: number | null;
  medianMinutes: number | null;
  fellBack: number;
  mismatches: number;
  band: Band;
};

export function scorecard(facts: readonly OutcomeFact[], runs: readonly ScoreRun[], before: number): ScoreCell[] {
  const seen = new Map<string, { run: ScoreRun; entry: string }[]>();
  const eligible = runs.filter(run => run.at <= before && before - run.at <= SCORE_WINDOW)
    .sort((a, b) => a.at - b.at);
  for (const run of eligible) {
    const ran = winning(facts.filter(fact => fact.at <= before), run.id, "ran");
    if (!ran?.text) continue;
    const key = `${ran.text}\0${run.group}\0${run.tier}`;
    const list = seen.get(key) ?? [];
    list.push({ run, entry: ran.text });
    seen.set(key, list);
  }
  return [...seen.entries()].map(([, list]) => cellOf(lastOutcomes(list, facts, before), facts, before));
}

// The window is the last SCORE_KEEP outcomes, not runs: a run without an outcome yet must not push real ones out.
function lastOutcomes<T extends { run: ScoreRun }>(list: readonly T[], facts: readonly OutcomeFact[], before: number): readonly T[] {
  const decided = (item: T): boolean => winning(facts.filter(fact => fact.at <= before), item.run.id, "accepted")?.bool !== undefined;
  const kept = list.filter(decided).slice(-SCORE_KEEP);
  const oldest = kept[0];
  if (!oldest || kept.length < SCORE_KEEP) return list;
  return list.slice(list.indexOf(oldest));
}

function cellOf(list: readonly { run: ScoreRun; entry: string }[], facts: readonly OutcomeFact[], before: number): ScoreCell {
  const first = list[0];
  let coverage = 0;
  let n = 0;
  let k = 0;
  let findings = 0;
  let fixRounds = 0;
  let knownFindings = 0;
  const costs: number[] = [];
  const minutes: number[] = [];
  let fellBack = 0;
  let mismatches = 0;
  for (const { run } of list) {
    const prior = facts.filter(fact => fact.route === run.id && fact.at <= before);
    const accepted = winning(prior, run.id, "accepted");
    if (!accepted || accepted.bool === undefined) {
      if (before - run.at >= UNKNOWN_AFTER) coverage += 1;
      continue;
    }
    coverage += 1;
    n += 1;
    if (accepted.bool) k += 1;
    const found = winning(prior, run.id, "findings");
    if (found?.n !== undefined) { findings += found.n; knownFindings += 1; }
    const rounds = winning(prior, run.id, "fix-rounds");
    if (rounds?.n !== undefined) fixRounds += rounds.n;
    const cost = leaseTotal(prior, run.id, "cost");
    if (cost !== null) costs.push(cost);
    const minute = leaseTotal(prior, run.id, "minutes");
    if (minute !== null) minutes.push(minute);
    const back = winning(prior, run.id, "fell-back");
    if (back?.bool) fellBack += 1;
    const model = winning(prior, run.id, "model");
    if (model?.bool === false) mismatches += 1;
  }
  const head = first ?? { run: { id: "", at: 0, group: "", tier: "routine" as const, task: null, lane: null }, entry: "" };
  return {
    entry: head.entry, group: head.run.group, tier: head.run.tier, coverage, n, k,
    findings: knownFindings === 0 ? null : findings / knownFindings,
    fixRounds: n === 0 ? 0 : fixRounds / n,
    medianUsd: median(costs), medianMinutes: median(minutes), fellBack, mismatches,
    band: bandOf(k, n, knownFindings === 0 ? null : findings / knownFindings),
  };
}

function bandOf(k: number, n: number, findings: number | null): Band {
  if (n < 5) return "new";
  const rate = k / n;
  if (rate >= 0.8 && findings !== null && findings <= 1) return "A";
  if (rate >= 0.6) return "B";
  return "C";
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const left = sorted[mid - 1];
  const right = sorted[mid];
  if (right === undefined) return null;
  return sorted.length % 2 === 1 || left === undefined ? right : (left + right) / 2;
}

export function nextRound(earlier: readonly { task: string; group: string; ran: boolean }[], task: string, group: string): number {
  return earlier.filter(row => row.task === task && row.group === group && row.ran).length + 1;
}

export function leaseJoins(route: { task: string | null }, laneTask: string | null): boolean {
  if (laneTask === null || route.task === null) return true;
  return laneTask === route.task;
}

export type StandingRow = { entry: string; group: string; level: Level; pinned: boolean };

export function startStanding(groups: readonly { group: string; chains: readonly (readonly string[])[] }[]): StandingRow[] {
  const levels = new Map<string, Level>();
  const order: string[] = [];
  for (const group of groups) {
    for (const chain of group.chains) {
      chain.forEach((entry, index) => {
        const key = `${group.group}\0${entry}`;
        if (!levels.has(key)) order.push(key);
        const next: Level = index === 0 ? "hard" : "routine";
        const current = levels.get(key);
        levels.set(key, current === undefined || LEVEL_RANK[next] > LEVEL_RANK[current] ? next : current);
      });
    }
  }
  return order.map(key => {
    const cut = key.indexOf("\0");
    return { group: key.slice(0, cut), entry: key.slice(cut + 1), level: levels.get(key) ?? "routine", pinned: false };
  });
}

export function moveStanding(args: {
  level: Level;
  pinned: boolean;
  tier: Tier;
  atTier: readonly { accepted: boolean | "unknown"; fixRounds: number }[];
  deciderChoice: string | null;
}): { level: Level; cause: "promoted" | "demoted" | "unchanged" } {
  void args.deciderChoice;
  if (args.pinned || args.level === "held" || args.atTier.length === 0) return { level: args.level, cause: "unchanged" };
  const last = args.atTier.slice(-5);
  const failures = last.filter(row => row.accepted === false).length;
  if (failures >= 3) {
    const dropped = below(args.tier);
    if (LEVEL_RANK[dropped] < LEVEL_RANK[args.level]) return { level: dropped, cause: "demoted" };
    return { level: args.level, cause: "unchanged" };
  }
  const successes = last.filter(row => row.accepted === true).length;
  const heavy = last.some(row => row.fixRounds >= 3);
  if (args.level === args.tier && args.level !== "hard" && args.atTier.length >= 5 && successes >= 4 && !heavy) {
    return { level: above(args.level), cause: "promoted" };
  }
  return { level: args.level, cause: "unchanged" };
}

function below(tier: Tier): Level {
  if (tier === "hard") return "standard";
  if (tier === "standard") return "routine";
  return "held";
}

function above(level: Level): Level {
  if (level === "routine") return "standard";
  if (level === "standard") return "hard";
  return level;
}
