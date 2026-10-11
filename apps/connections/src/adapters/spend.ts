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

// A third-party route with a catalog price is priced per 1M tokens (design 7.1).
// modelUsage covers the main loop, subagents and auxiliary calls; outputTokens already includes thinking tokens.
// When the catalog has no price for the model, the runtime's total_cost_usd is the only figure, so it is used
// instead of charging the whole reservation. A priced model with no token counts stays null.
// https://code.claude.com/docs/en/agent-sdk/typescript and https://code.claude.com/docs/en/headless
// — checked 2026-10-11.
export type CatalogPrice = { at: string; model: string; input: number; output: number };

export function catalogTokenCost(stdout: string, prices: readonly CatalogPrice[], model: string): number | null {
  const body = lastResult(stdout);
  if (!body) return null;
  const table = priceTable(prices);
  const rows = modelRows(body);
  if (rows === null) return null;
  if (rows.length === 0) {
    const aggregate = loopUsage(body);
    if (!aggregate) return table.has(model) ? null : costFromOutput(stdout);
    const price = table.get(model);
    if (!price) return costFromOutput(stdout);
    return charge(aggregate.input, aggregate.output, price);
  }
  let total = 0;
  for (const row of rows) {
    const price = table.get(row.model);
    if (!price) return costFromOutput(stdout);
    const part = charge(row.input, row.output, price);
    if (part === null) return null;
    total += part;
  }
  return roundDollars(total);
}

function charge(input: number, output: number, price: { input: number; output: number } | undefined): number | null {
  if (!price || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  if (!Number.isFinite(price.input) || !Number.isFinite(price.output) || price.input < 0 || price.output < 0) return null;
  return (input * price.input + output * price.output) / 1_000_000;
}

function roundDollars(amount: number): number {
  return Math.round(amount * 1_000_000) / 1_000_000;
}

function priceTable(prices: readonly CatalogPrice[]): Map<string, { input: number; output: number }> {
  const sorted = [...prices].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  const table = new Map<string, { input: number; output: number }>();
  for (const row of sorted) table.set(row.model, { input: row.input, output: row.output });
  return table;
}

type ResultBody = { modelUsage?: unknown; usage?: unknown };

function lastResult(stdout: string): ResultBody | null {
  let found: ResultBody | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const body: unknown = JSON.parse(trimmed);
      if (isResult(body)) found = body;
    } catch { /* a status line, not a result */ }
  }
  return found;
}

function isResult(value: unknown): value is ResultBody {
  if (typeof value !== "object" || value === null) return false;
  return ("type" in value && value.type === "result") || "modelUsage" in value || "usage" in value;
}

function isTokenRow(value: unknown): value is { inputTokens: number; outputTokens: number } {
  if (typeof value !== "object" || value === null) return false;
  if (!("inputTokens" in value) || !("outputTokens" in value)) return false;
  return typeof value.inputTokens === "number" && typeof value.outputTokens === "number";
}

function modelRows(body: ResultBody): { model: string; input: number; output: number }[] | null {
  if (body.modelUsage === undefined) return [];
  if (typeof body.modelUsage !== "object" || body.modelUsage === null || Array.isArray(body.modelUsage)) return null;
  const rows: { model: string; input: number; output: number }[] = [];
  for (const [model, value] of Object.entries(body.modelUsage)) {
    if (!isTokenRow(value)) return null;
    rows.push({ model, input: value.inputTokens, output: value.outputTokens });
  }
  return rows;
}

function loopUsage(body: ResultBody): { input: number; output: number } | null {
  const usage = body.usage;
  if (typeof usage !== "object" || usage === null) return null;
  if (!("input_tokens" in usage) || !("output_tokens" in usage)) return null;
  if (typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") return null;
  return { input: usage.input_tokens, output: usage.output_tokens };
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
