// The settings page (ADR-0018 §11). Built here, so a component never decides availability, order or a chain.
// The message is the page allowlist: no ref, no fingerprint, no secret.
import {
  availability, chainText, deriveChain, drifted, engineText, isKey, roleOrder, spentOf,
  type Directory, type Policy,
} from "@morndo/domain";
import { ConnectionsPage, CONNECTION_WORDS, type VendorPreset } from "@morndo/protocol";
import type { Alert } from "./ports.ts";

const LEVEL_AT = [[0.95, "full"], [0.8, "high"], [0.5, "half"]] as const;
export type BudgetLevel = "steady" | "half" | "high" | "full";
export const budgetLevel = (ratio: number): BudgetLevel => {
  for (const [at, name] of LEVEL_AT) if (ratio >= at) return name;
  return "steady";
};

export type PageUsage = { fiveHour: number | null; sevenDay: number | null };
export type OutsideChain = { role: string; chain: readonly string[]; risk: readonly string[] | null };

const ALERT_DETAIL: Record<string, string> = {
  drift: CONNECTION_WORDS.drift,
  kept: CONNECTION_WORDS.keepHand,
  authority: "A run lost its holder",
  defaults: "A default pick was skipped",
  threshold: "A budget or expiry line was crossed",
};

export function buildPage(input: {
  version: number;
  directory: Directory;
  policy: Policy;
  presets: readonly VendorPreset[];
  alerts: readonly Alert[];
  outside: readonly OutsideChain[];
  usage: Readonly<Record<string, PageUsage>>;
  now: number;
}): ConnectionsPage {
  const known = input.directory.connections.filter(c => c.status !== "revoked").map(c => ({ name: c.name, kind: c.kind }));
  const connections = input.directory.connections.map(c => {
    const preset = input.presets.find(p => p.id === c.vendor);
    const spent = isKey(c) && c.budget.kind === "capped" && c.budget.amount > 0 ? spentOf(c.spend) / c.budget.amount : null;
    const reported = input.usage[c.name];
    return {
      name: c.name,
      kind: c.kind,
      vendor: c.vendor,
      runtime: c.runtime,
      availability: availability(c, input.now, preset?.terms.revision ?? ""),
      budgetPercent: spent === null ? null : Math.min(100, Math.round(spent * 100)),
      budgetLevel: spent === null ? null : budgetLevel(spent),
      expiry: isKey(c) ? c.expiry : null,
      spendSource: isKey(c) ? c.spend.at(-1)?.source ?? null : null,
      usageFiveHour: reported ? reported.fiveHour : null,
      usageSevenDay: reported ? reported.sevenDay : null,
    };
  });
  const roles = input.policy.roles.map(row => {
    const names = roleOrder(input.policy, row, known);
    const chain = chainText(deriveChain(row.picks, names, row.override === "hand"));
    const seen = input.outside.find(item => item.role === row.role);
    return {
      role: row.role,
      override: row.override,
      order: (row.priority?.order ?? []).filter(name => known.some(item => item.name === name)),
      picks: row.picks.map(engineText),
      riskPicks: (row.riskPicks ?? []).map(engineText),
      chain,
      drifted: seen ? drifted(row, seen.chain, seen.risk) : false,
      first: chain[0] ?? names[0] ?? null,
    };
  });
  const page = {
    version: input.version,
    connections,
    mode: input.policy.priority.mode,
    order: input.policy.priority.order.filter(name => known.some(item => item.name === name)),
    roles,
    alerts: input.alerts.map(alert => ({
      kind: "connection" as const,
      name: alert.name,
      detail: (ALERT_DETAIL[alert.kind] ?? alert.detail).slice(0, 200),
    })),
    catalog: input.presets.map(preset => ({
      id: preset.id,
      label: preset.label,
      kinds: preset.kinds,
      runtimes: preset.runtimes.map(runtime => runtime.runtime),
      termsSummary: preset.terms.summary,
      termsSources: preset.terms.sources,
      isolation: preset.isolation,
    })),
  };
  const parsed = ConnectionsPage.safeParse(page);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error));
  return parsed.data;
}
