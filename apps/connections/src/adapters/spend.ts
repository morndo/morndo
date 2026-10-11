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
export type CatalogPrice = { at: string; model: string; input: number; output: number; cacheRead?: number };

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Price = { input: number; output: number; cacheRead?: number };

export function catalogTokenCost(stdout: string, prices: readonly CatalogPrice[], model: string): number | null {
  const body = lastResult(stdout);
  if (!body) return null;
  const table = priceTable(prices);
  const rows = modelRows(body);
  if (rows === null) return null;
  if (rows.length === 0) {
    const aggregate = loopUsage(body);
    const price = table.get(model) ?? table.get(reportedModel(body) ?? "");
    if (!aggregate) return price ? null : costFromOutput(stdout);
    if (!price) return costFromOutput(stdout);
    const part = charge(aggregate, price);
    return part === null ? null : roundDollars(part);
  }
  let total = 0;
  for (const row of rows) {
    const price = table.get(row.model);
    if (!price) return costFromOutput(stdout);
    const part = charge(row, price);
    if (part === null) return null;
    total += part;
  }
  return roundDollars(total);
}

// cacheRead is the vendor's cached-input price per 1M tokens. Z.ai lists Cached Input and no cache-creation
// price (https://docs.z.ai/guides/overview/pricing, read 2026-10-11), so cache creation is charged as input.
// A row with no cacheRead price charges cache reads as input too.
function charge(tokens: Tokens, price: Price | undefined): number | null {
  if (!price) return null;
  const readRate = price.cacheRead ?? price.input;
  const amounts = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, price.input, price.output, readRate];
  if (amounts.some(amount => !Number.isFinite(amount) || amount < 0)) return null;
  return (tokens.input * price.input + tokens.cacheRead * readRate + tokens.cacheWrite * price.input + tokens.output * price.output) / 1_000_000;
}

function roundDollars(amount: number): number {
  return Math.round(amount * 1_000_000) / 1_000_000;
}

function priceTable(prices: readonly CatalogPrice[]): Map<string, Price> {
  const sorted = [...prices].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  const table = new Map<string, Price>();
  for (const row of sorted) {
    table.set(row.model, row.cacheRead === undefined
      ? { input: row.input, output: row.output }
      : { input: row.input, output: row.output, cacheRead: row.cacheRead });
  }
  return table;
}

type ResultBody = { modelUsage?: unknown; usage?: unknown; model?: unknown };

function reportedModel(body: ResultBody): string | null {
  return typeof body.model === "string" && body.model !== "" ? body.model : null;
}

function lastResult(stdout: string): ResultBody | null {
  let found: ResultBody | null = null;
  for (const candidate of jsonObjects(stdout)) {
    try {
      const body: unknown = JSON.parse(candidate);
      if (isResult(body)) found = body;
    } catch { /* a status line, not a result */ }
  }
  return found;
}

function jsonObjects(text: string): string[] {
  const found: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") { inString = true; continue; }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        found.push(text.slice(start, index + 1));
        start = -1;
      }
    }
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

function optionalCount(value: object, key: string): number | null {
  if (!(key in value)) return 0;
  const count = (value as Record<string, unknown>)[key];
  return typeof count === "number" ? count : null;
}

function modelRows(body: ResultBody): ({ model: string } & Tokens)[] | null {
  if (body.modelUsage === undefined) return [];
  if (typeof body.modelUsage !== "object" || body.modelUsage === null || Array.isArray(body.modelUsage)) return null;
  const rows: ({ model: string } & Tokens)[] = [];
  for (const [model, value] of Object.entries(body.modelUsage)) {
    if (!isTokenRow(value)) return null;
    const cacheRead = optionalCount(value, "cacheReadInputTokens");
    const cacheWrite = optionalCount(value, "cacheCreationInputTokens");
    if (cacheRead === null || cacheWrite === null) return null;
    rows.push({ model, input: value.inputTokens, output: value.outputTokens, cacheRead, cacheWrite });
  }
  return rows;
}

function loopUsage(body: ResultBody): Tokens | null {
  const usage = body.usage;
  if (typeof usage !== "object" || usage === null) return null;
  if (!("input_tokens" in usage) || !("output_tokens" in usage)) return null;
  if (typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") return null;
  const cacheRead = optionalCount(usage, "cache_read_input_tokens");
  const cacheWrite = optionalCount(usage, "cache_creation_input_tokens");
  if (cacheRead === null || cacheWrite === null) return null;
  return { input: usage.input_tokens, output: usage.output_tokens, cacheRead, cacheWrite };
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
