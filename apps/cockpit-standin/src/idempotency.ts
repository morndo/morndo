import { createHash } from "node:crypto";
import type { Command, CommandResult } from "@morndo/cockpit-api";
import { Problem } from "./protocol.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, ordered(record[key])]));
}

export class Idempotency {
  private readonly entries = new Map<string, { expires: number; digest: string; result: CommandResult }>();

  constructor(privateClock = Date.now) {
    this.clock = privateClock;
  }

  private readonly clock: () => number;

  run(reader: string, key: string | undefined, command: Command, execute: () => CommandResult): CommandResult {
    if (key === undefined) return execute();
    if (!key.length || key.length > 200) throw new Problem("badRequest", "Invalid Idempotency-Key.");
    const scope = JSON.stringify([reader, key]);
    const now = this.clock();
    const digest = createHash("sha256").update(JSON.stringify(ordered(command))).digest("hex");
    const saved = this.entries.get(scope);
    if (saved && saved.expires > now) {
      if (saved.digest !== digest) throw new Problem("idempotencyKeyReused", "The key already belongs to another command.");
      return saved.result;
    }
    const result = execute();
    this.entries.set(scope, { expires: now + DAY_MS, digest, result: structuredClone(result) });
    return result;
  }

  sweep(): number {
    const now = this.clock();
    let deleted = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expires > now) continue;
      this.entries.delete(key);
      deleted++;
    }
    return deleted;
  }
}
