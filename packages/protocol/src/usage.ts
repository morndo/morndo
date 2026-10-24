// Usage on the wire (ADR-0016): the status-line report an agent's session posts to the hub (the agent CLI's own JSON,
// of which only these fields are read; the rest is dropped), the accounts the hub pushes to the app (the `usage` feed
// frame), and the principal's GET. Types are the domain's own.
import { USAGE_FIXES, USAGE_REASONS, USAGE_SOURCES, type AccountUsage } from "@morndo/domain";
import * as z from "./z.ts";

const text = () => z.string();
const num = () => z.number();
// U14: a used percentage outside 0..101 is not a reading of that window. On the way in it parses to null (the body is
// not rejected, the window beside it stays; 101 is tolerated and the domain makes it 100), and a frame the hub sends never has one.
const pctIn = () => orElse(z.nullable(z.number().check(z.gte(0), z.lte(101))), null);
const pctOut = () => z.number().check(z.gte(0), z.lte(100));
const orElse = z.catch;

// What a status line receives on stdin (code.claude.com/docs/en/statusline, read 2026-10-09), the parts the hub keeps:
// the session, the model, the context used, and the rate-limit windows, each independently absent. `resets_at` is
// epoch seconds there. Anything else is dropped (looseObject keeps unknown keys, the hub reads only these).
const rawWindow = z.looseObject({ used_percentage: z.exactOptional(pctIn()), resets_at: z.exactOptional(z.nullable(num())) });
// A window the account names itself. Absent on a status line; present, these are the windows it has.
// A bad row (wrong type, null, no label, no percentage, one window too many) is dropped later. It does not reject the report.
const rawNamed = orElse(z.looseObject({
  label: z.exactOptional(orElse(z.nullable(z.string()), null)),
  used_percentage: z.exactOptional(pctIn()),
  resets_at: z.exactOptional(orElse(z.nullable(num()), null)),
  resets_on: z.exactOptional(orElse(z.nullable(z.string()), null)),
  length_mins: z.exactOptional(orElse(z.nullable(num()), null)),
  rolling: z.exactOptional(orElse(z.boolean(), false)),
  note: z.exactOptional(orElse(z.nullable(z.string()), null)),
}), {});
export const UsageReportBody = z.looseObject({
  session_id: z.string().check(z.minLength(1), z.maxLength(200)),
  session_name: z.exactOptional(z.nullable(z.string().check(z.maxLength(200)))),
  model: z.exactOptional(z.nullable(z.looseObject({ id: z.exactOptional(z.nullable(z.string().check(z.maxLength(200)))), display_name: z.exactOptional(z.nullable(z.string().check(z.maxLength(200)))) }))),
  context_window: z.exactOptional(z.nullable(z.looseObject({ used_percentage: z.exactOptional(z.nullable(num())) }))),
  rate_limits: z.exactOptional(z.nullable(z.looseObject({
    five_hour: z.exactOptional(z.nullable(rawWindow)),
    seven_day: z.exactOptional(z.nullable(rawWindow)),
    spend_limit: z.exactOptional(z.nullable(z.looseObject({
      used_percentage: z.exactOptional(pctIn()), resets_at: z.exactOptional(z.nullable(num())),
      used_usd: z.exactOptional(z.nullable(num())), limit_usd: z.exactOptional(z.nullable(num())), period: z.exactOptional(z.nullable(z.string().check(z.maxLength(40)))),
    }))),
  }))),
  limits: z.exactOptional(z.nullable(z.array(rawNamed))),
  on_demand: z.exactOptional(z.nullable(z.string())),
});
export type UsageReportBody = z.output<typeof UsageReportBody>;

const windowSchema = z.object({ usedPercentage: pctOut(), resetsAt: z.nullable(num()) });
const spendSchema = z.object({ usedPercentage: pctOut(), resetsAt: z.nullable(num()), usedUsd: z.nullable(num()), limitUsd: z.nullable(num()), period: z.nullable(text()) });
const namedSchema = z.object({
  label: text(), usedPercentage: pctOut(), resetsAt: z.nullable(num()), resetsOn: z.nullable(text()),
  lengthMins: z.exactOptional(z.nullable(num())), rolling: z.exactOptional(z.boolean()), note: z.exactOptional(z.nullable(text())),
  title: z.exactOptional(z.nullable(text())),
});
// The profile the hub overlays on an account (ADR-0034): optional on the wire, so an older hub's account still parses.
const profileSchema = z.object({ email: z.nullable(text()), org: z.nullable(z.enum(["team", "personal"])), plan: z.nullable(text()) });
// The S2 view fields (plan 4.4): where each source's numbers came from and how it is doing, the account's seat, and
// any two sources that disagree about one window. All optional and caught, so an older hub's account still parses.
const sourceViewSchema = z.object({
  source: z.enum(USAGE_SOURCES), node: z.nullable(text()), state: z.enum(["available", "stale", "unavailable", "missing"]),
  since: z.nullable(num()), asOf: z.nullable(num()), reason: z.nullable(z.enum(USAGE_REASONS)), fix: z.nullable(z.enum(USAGE_FIXES)), hint: z.nullable(text()),
});
const seatViewSchema = z.object({
  state: z.enum(["logged-out", "retired", "out", "low", "ok"]), why: z.nullable(z.enum(["usage_limit", "refused", "signed_out", "plan_ended", "billing", "by_hand"])),
  since: num(), backAt: z.nullable(num()), owner: z.enum(["derived", "pool"]), by: text(), fix: z.nullable(z.enum(USAGE_FIXES)),
});
const disagreeSide = z.object({ source: z.enum(USAGE_SOURCES), usedPercent: num(), capturedAt: num() });
const disagreeSchema = z.object({ window: text(), a: disagreeSide, b: disagreeSide });
export const AccountUsageSchema = z.object({
  account: text(), reportedAt: num(),
  fiveHour: orElse(z.nullable(windowSchema), null), sevenDay: orElse(z.nullable(windowSchema), null), spend: orElse(z.nullable(spendSchema), null),
  limits: orElse(z.nullable(z.array(namedSchema)), null), onDemand: orElse(z.nullable(text()), null),
  profile: orElse(z.nullable(profileSchema), null),
  sessions: z.array(z.object({ sessionId: text(), lane: z.nullable(text()), model: z.nullable(text()), contextUsed: z.nullable(num()), at: num() })),
  sources: z.exactOptional(orElse(z.readonly(z.array(sourceViewSchema)), [])),
  seat: z.exactOptional(orElse(z.nullable(seatViewSchema), null)),
  disagree: z.exactOptional(orElse(z.readonly(z.array(disagreeSchema)), [])),
});
// Every connected account, whole, after each hello and whenever a report changed what is shown. The S2 notices
// (plan 4.4) ride along; an older hub's frame, without them, still parses.
export const UsageFrameSchema = z.object({ t: z.literal("usage"), accounts: z.array(z.unknown()), at: num(), notices: z.exactOptional(z.array(z.unknown())) });

// A usage reading a source posts (U14): the windows it can see now, or the one reason it cannot. Epoch seconds here,
// milliseconds in the domain. A bad window row is caught to an empty row and dropped later; it never rejects the
// report. The reason and the hint are free strings on the wire; the domain's closed reason list and hint cleaning
// decide what is kept of them.
const readingsWindow = orElse(z.looseObject({
  id: z.exactOptional(z.string().check(z.maxLength(40))),
  used_percent: z.exactOptional(pctIn()),
  resets_at: z.exactOptional(z.nullable(num())),
  length_mins: z.exactOptional(z.nullable(num())),
  rolling: z.exactOptional(z.boolean()),
  note: z.exactOptional(z.nullable(z.string())),
}), {});
export const UsageReadingsBody = z.looseObject({
  source: z.enum(USAGE_SOURCES),
  node: z.exactOptional(z.nullable(z.string().check(z.maxLength(80)))),
  captured_at: num(),
  every_s: z.exactOptional(z.nullable(num())),
  plan: z.exactOptional(z.nullable(z.string().check(z.maxLength(80)))),
  lease_id: z.exactOptional(z.nullable(z.string().check(z.maxLength(80)))),
  windows: z.exactOptional(z.array(readingsWindow)),
  failure: z.exactOptional(z.nullable(z.looseObject({
    reason: z.string().check(z.maxLength(40)),
    hint: z.exactOptional(z.nullable(z.string().check(z.maxLength(2000)))),
  }))),
});
export type UsageReadingsBody = z.output<typeof UsageReadingsBody>;

// The principal's own forget of a source (plan 4.4, AT-23): the account, and the source (and node) to drop; without
// a source, the whole account is forgotten.
export const UsageForgetBody = z.looseObject({
  account: z.string().check(z.minLength(1), z.maxLength(80)),
  source: z.exactOptional(z.enum(USAGE_SOURCES)),
  node: z.exactOptional(z.nullable(z.string().check(z.maxLength(80)))),
});
export type UsageForgetBody = z.output<typeof UsageForgetBody>;

// A seat's limit hit as the source reports it (U9): the kind is one closed list, the words around it are free. The
// fix is free text here too; the hub only ever shows a fix from the domain's closed list.
export const UsageLimitBody = z.looseObject({
  kind: z.enum(["usage_limit", "refused", "signed_out", "billing", "unknown"]),
  back_at: z.exactOptional(z.nullable(num())),
  by: z.string().check(z.minLength(1), z.maxLength(80)),
  at: z.exactOptional(z.nullable(num())),
  fix: z.exactOptional(z.nullable(z.string().check(z.maxLength(200)))),
  hint: z.exactOptional(z.nullable(z.string().check(z.maxLength(2000)))),
  account: z.exactOptional(z.nullable(z.string().check(z.maxLength(80)))),
});
export type UsageLimitBody = z.output<typeof UsageLimitBody>;

// The pool's word on a seat (U15): what a token with the usage-pool scope posts. `back_at` and `at` are epoch seconds
// here, milliseconds in the domain; a `state` (and its `why`) comes only with "set".
export const UsagePoolBody = z.looseObject({
  account: z.string().check(z.minLength(1), z.maxLength(80)),
  action: z.enum(["set", "cleared"]),
  state: z.exactOptional(z.enum(["logged-out", "retired", "out", "low", "ok"])),
  why: z.exactOptional(z.nullable(z.enum(["usage_limit", "refused", "signed_out", "plan_ended", "billing", "by_hand"]))),
  back_at: z.exactOptional(z.nullable(num())),
  by: z.string().check(z.minLength(1), z.maxLength(80)),
  at: z.exactOptional(z.nullable(num())),
});
export type UsagePoolBody = z.output<typeof UsagePoolBody>;

// The principal's own clear of a seat (U17): the account, and whose seat — without an owner, both.
export const UsageSeatClearBody = z.looseObject({
  account: z.string().check(z.minLength(1), z.maxLength(80)),
  owner: z.exactOptional(z.enum(["pool", "derived"])),
});
export type UsageSeatClearBody = z.output<typeof UsageSeatClearBody>;

// The fleet's usage tap (plan 4.5 item 4): a limit failure a lane hit, and the account a lane started with. `at` is
// milliseconds here (the fleet's own event, never a wire body a source posts). Strict: a body a newer fleet shaped
// differently is dropped by whoever reads it, never guessed at.
const tapFailure = z.strictObject({
  kind: z.literal("failure"),
  lane: z.nullable(z.string().check(z.maxLength(64))),
  window: z.nullable(z.string().check(z.maxLength(64))),
  sessionId: z.exactOptional(z.string().check(z.maxLength(128))),
  error: z.string().check(z.maxLength(60)),
  account: z.nullable(z.string().check(z.maxLength(80))),
  at: num(),
});
const tapLaneAccount = z.strictObject({
  kind: z.literal("lane_account"),
  lane: z.string().check(z.maxLength(64)),
  account: z.string().check(z.maxLength(80)),
  at: num(),
});
export const UsageTapBody = z.union([tapFailure, tapLaneAccount]);
export type UsageTapBody = z.output<typeof UsageTapBody>;
export type UsageTapFailure = Extract<UsageTapBody, { kind: "failure" }>;
export type UsageTapLaneAccount = Extract<UsageTapBody, { kind: "lane_account" }>;

// What an agent token may do beyond its role (U15): a closed list, so a scope a newer hub coined is never kept as one
// of these. Empty (every token minted before this list): none.
export const AGENT_SCOPES = ["usage-pool"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const check = <T extends true>(t: T) => t;
check<Same<z.output<typeof AccountUsageSchema>, AccountUsage>>(true);
