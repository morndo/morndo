// Usage on the wire (ADR-0016): the status-line report an agent's session posts to the hub (the agent CLI's own JSON,
// of which only these fields are read; the rest is dropped), the accounts the hub pushes to the app (the `usage` feed
// frame), and the principal's GET. Types are the domain's own.
import type { AccountUsage } from "@morndo/domain";
import * as z from "./z.ts";

const text = () => z.string();
const num = () => z.number();
const orElse = z.catch;

// What a status line receives on stdin (code.claude.com/docs/en/statusline, read 2026-10-09), the parts the hub keeps:
// the session, the model, the context used, and the rate-limit windows, each independently absent. `resets_at` is
// epoch seconds there. Anything else is dropped (looseObject keeps unknown keys, the hub reads only these).
const rawWindow = z.looseObject({ used_percentage: z.exactOptional(z.nullable(num())), resets_at: z.exactOptional(z.nullable(num())) });
// A window the account names itself. Absent on a status line; present, these are the windows it has.
// A bad row (no label, no percentage, one window too many) is dropped later. It does not reject the report.
const rawNamed = z.looseObject({
  label: z.exactOptional(z.string()),
  used_percentage: z.exactOptional(z.nullable(num())),
  resets_at: z.exactOptional(z.nullable(num())),
  resets_on: z.exactOptional(z.nullable(z.string())),
});
export const UsageReportBody = z.looseObject({
  session_id: z.string().check(z.minLength(1), z.maxLength(200)),
  session_name: z.exactOptional(z.nullable(z.string().check(z.maxLength(200)))),
  model: z.exactOptional(z.nullable(z.looseObject({ id: z.exactOptional(z.nullable(z.string().check(z.maxLength(200)))), display_name: z.exactOptional(z.nullable(z.string().check(z.maxLength(200)))) }))),
  context_window: z.exactOptional(z.nullable(z.looseObject({ used_percentage: z.exactOptional(z.nullable(num())) }))),
  rate_limits: z.exactOptional(z.nullable(z.looseObject({
    five_hour: z.exactOptional(z.nullable(rawWindow)),
    seven_day: z.exactOptional(z.nullable(rawWindow)),
    spend_limit: z.exactOptional(z.nullable(z.looseObject({
      used_percentage: z.exactOptional(z.nullable(num())), resets_at: z.exactOptional(z.nullable(num())),
      used_usd: z.exactOptional(z.nullable(num())), limit_usd: z.exactOptional(z.nullable(num())), period: z.exactOptional(z.nullable(z.string().check(z.maxLength(40)))),
    }))),
  }))),
  limits: z.exactOptional(z.nullable(z.array(rawNamed))),
  on_demand: z.exactOptional(z.nullable(z.string().check(z.maxLength(80)))),
});
export type UsageReportBody = z.output<typeof UsageReportBody>;

const windowSchema = z.object({ usedPercentage: num(), resetsAt: z.nullable(num()) });
const spendSchema = z.object({ usedPercentage: num(), resetsAt: z.nullable(num()), usedUsd: z.nullable(num()), limitUsd: z.nullable(num()), period: z.nullable(text()) });
const namedSchema = z.object({ label: text(), usedPercentage: num(), resetsAt: z.nullable(num()), resetsOn: z.nullable(text()) });
export const AccountUsageSchema = z.object({
  account: text(), reportedAt: num(),
  fiveHour: orElse(z.nullable(windowSchema), null), sevenDay: orElse(z.nullable(windowSchema), null), spend: orElse(z.nullable(spendSchema), null),
  limits: orElse(z.nullable(z.array(namedSchema)), null), onDemand: orElse(z.nullable(text()), null),
  sessions: z.array(z.object({ sessionId: text(), lane: z.nullable(text()), model: z.nullable(text()), contextUsed: z.nullable(num()), at: num() })),
});
// Every connected account, whole, after each hello and whenever a report changed what is shown.
export const UsageFrameSchema = z.object({ t: z.literal("usage"), accounts: z.array(z.unknown()), at: num() });

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const check = <T extends true>(t: T) => t;
check<Same<z.output<typeof AccountUsageSchema>, AccountUsage>>(true);
