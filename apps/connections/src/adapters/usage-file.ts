// Usage windows for a subscription, stored beside the connections home. A missing or unreadable file is no usage.
import { readFileSync } from "node:fs";
import type { PageUsage } from "../application/page.ts";

export function readUsage(path: string): Readonly<Record<string, PageUsage>> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const usage: Record<string, PageUsage> = {};
    for (const [name, row] of Object.entries(parsed)) {
      if (!row || typeof row !== "object") continue;
      const fiveHour = (row as { fiveHour?: unknown }).fiveHour;
      const sevenDay = (row as { sevenDay?: unknown }).sevenDay;
      if (typeof fiveHour !== "number" || typeof sevenDay !== "number") continue;
      usage[name] = { fiveHour, sevenDay };
    }
    return usage;
  } catch {
    return {};
  }
}
