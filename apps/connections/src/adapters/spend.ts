// Headless Claude Code reports total_cost_usd on the result event when launched with
// --output-format json (design section 7). A missing cost is null. The lease close then
// charges the reservation, which is the fallback, not a zero spend.
// https://code.claude.com/docs/en/headless — checked 2026-10-10.
import type { SpendMeter } from "../application/ports.ts";

export function costFromOutput(stdout: string): number | null {
  const matches = [...stdout.matchAll(/"total_cost_usd"\s*:\s*(-?[0-9]+(?:\.[0-9]+)?)/g)];
  const last = matches.at(-1);
  if (!last?.[1]) return null;
  const amount = Number(last[1]);
  return Number.isFinite(amount) ? amount : null;
}

export function modelFromOutput(stdout: string): string | null {
  const matches = [...stdout.matchAll(/"model"\s*:\s*"([^"]+)"/g)];
  return matches.at(-1)?.[1] ?? null;
}

export class RunSpend implements SpendMeter {
  fromRun(result: { cost: number | null }): number | null {
    return result.cost !== null && Number.isFinite(result.cost) ? result.cost : null;
  }
  reported(): number | null { return null; }
}
