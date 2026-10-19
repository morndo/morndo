// Builders for the Pool tests: one clock, readings with a 5-hour and a weekly window, a pool of members.
import { addMember, emptyPool, recordReading, setMode, type Holder, type MemberSettings, type Pool, type Reading } from "../src/index.ts";

export const H = 3_600_000;
export const NOW = Date.UTC(2026, 9, 15, 12);
export const NONE: MemberSettings = { keep: false, expires: null, onlyFor: [] };
export type Shape = Partial<Reading> & { short?: number; long?: number; shortIn?: number; longIn?: number };

// Used percentages and hours to each reset; read a minute ago, signed in, on a paid plan, allowed, no credits.
export function reading(member: string, o: Shape = {}): Reading {
  const { short = 20, long = 30, shortIn = 2, longIn = 72, ...rest } = o;
  return {
    member, at: NOW - 60_000, signedIn: true, identity: `id-${member}`, plan: "paid-plan", paid: true, allowed: true,
    credits: { available: 0, expiresAt: null },
    windows: [
      { usedPercent: short, minutes: 300, resetsAt: NOW + shortIn * H },
      { usedPercent: long, minutes: 10_080, resetsAt: NOW + longIn * H },
    ],
    ...rest,
  };
}

export function must<T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.value;
}

// A pool of these members, read as given; rotate mode unless said otherwise.
export function poolOf(readings: readonly Reading[], mode: "pinned" | "rotate" = "rotate", settings: Record<string, MemberSettings> = {}): Pool {
  let p = emptyPool("runtime-x");
  for (const r of readings) p = must(addMember(p, r.member, settings[r.member] ?? NONE, NOW - H));
  if (mode === "rotate") p = must(setMode(p, "rotate", "principal@example.com", NOW - H));
  for (const r of readings) p = recordReading(p, r, r.at);
  return p;
}

export const holder = (pid: number): Holder => ({ node: "node-a", pid, startedAt: pid * 10, bootId: "boot-1", lane: null });
export const ALIVE = (): boolean => true;
