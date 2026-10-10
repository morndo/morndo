// Anti-corruption adapter over the manager's needs-you list: its ledger file, a JSON document the manager alone writes
// The hub only reads it, and only when MORNDO_LEDGER names it.
// Its items grew by hand, so field names vary: the question is in "question", "item" or "what"; the time it was added
// in "ts", "added" or "addedAt"; open items have no "status" or "open"; closed ones are in "needsYouClosed" or carry
// another status. Everything is translated here; the domain sees only LedgerItem values.
// An item may also give its short form: "title" (a few words),
// "summary" (one sentence), "minutes", "options" ([{key, label}], the recommended first), "link" and "details". Each is
// optional; one that doesn't fit is left out, never guessed. "kind" stays: "tap" a decision, "time" a task.
import { readFileSync, statSync } from "node:fs";
import { optionsProblem, type ButtonOption } from "./manager-protocol.ts";

export type LedgerItem = {
  id: string;
  need: "decision" | "time";        // "tap": a decision he can answer in chat; "time": needs his time or hands
  title: string;                    // the question as the list words it, often long
  shortTitle: string | null;        // the list's own title, a few words
  summary: string | null;           // one sentence: what he does or decides
  minutes: number | null;           // how long it takes him
  options: ButtonOption[];          // the list's own options, the recommended first; none when it gives none
  link: string | null;              // an http(s) address to open
  details: string | null;           // everything else, long
  ifNoAnswer: string | null;
  recommendation: string | null;
  deadline: number | null;
  blocking: boolean;
  project: string | null;
  addedAt: number | null;
  open: boolean;
  resolution: string | null;
  closedAt: number | null;
};

export type LedgerRead = { ok: true; items: LedgerItem[]; at: number } | { ok: false; error: string; at: number };

const str = (v: unknown, max = 600) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

// "2026-10-01" is a whole day: due at its end, in the hub's time zone. Anything else must parse as a time.
export function parseDeadline(v: unknown): number | null {
  const s = str(v, 40);
  if (!s) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 23, 59, 59).getTime();
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
// One line: a title or a sentence never breaks.
const line = (v: unknown, max: number) => { const t = str(v, max * 2)?.replace(/\s+/g, " "); return t ? t.slice(0, max) : null; };
const link = (v: unknown) => {
  const s = str(v, 2000);
  if (!s) return null;
  try { const u = new URL(s); return u.protocol === "https:" || u.protocol === "http:" ? u.href : null; } catch { return null; }
};
// Whole minutes, from 1 to a day.
const minutes = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1440 ? Math.max(1, Math.round(v)) : null);
// Options the tap line can carry (the manager protocol's grammar), or none.
function options(v: unknown): ButtonOption[] {
  if (!Array.isArray(v)) return [];
  const o = v.map(x => (x && typeof x === "object" && typeof (x as Record<string, unknown>).key === "string" && typeof (x as Record<string, unknown>).label === "string"
    ? { key: String((x as Record<string, unknown>).key), label: String((x as Record<string, unknown>).label).trim() } : null));
  return optionsProblem(o) || o.some(x => !x?.label) ? [] : (o as ButtonOption[]);
}
const time = (...vs: unknown[]) => {
  for (const v of vs) {
    const s = str(v, 40);
    const t = s ? Date.parse(s) : NaN;
    if (!Number.isNaN(t)) return t;
  }
  return null;
};

function item(x: Record<string, unknown>, closedList: boolean): LedgerItem | null {
  const id = str(x.id, 40);
  if (!id || !/^[A-Za-z0-9_-]{1,32}$/.test(id)) return null;
  const status = str(x.status, 40);
  return {
    id,
    need: x.kind === "time" ? "time" : "decision",
    title: str(x.question) ?? str(x.item) ?? str(x.what) ?? line(x.title, 80) ?? line(x.summary, 300) ?? id,
    shortTitle: line(x.title, 80),
    summary: line(x.summary, 300),
    minutes: minutes(x.minutes),
    options: options(x.options),
    link: link(x.link),
    details: str(x.details, 4000),
    ifNoAnswer: str(x.default, 300),
    recommendation: str(x.recommendation, 600),
    deadline: parseDeadline(x.deadline),
    blocking: x.blocking === true,
    project: str(x.task, 80),
    addedAt: time(x.ts, x.added, x.addedAt),
    open: !closedList && (status === null || status === "open"),
    resolution: str(x.answer, 400) ?? str(x.resolution, 400) ?? str(x.closedReason, 400),
    closedAt: time(x.closedAt, x.closed),
  };
}

export function parseLedger(doc: unknown): LedgerItem[] {
  const d = (doc ?? {}) as Record<string, unknown>;
  const list = (k: string) => (Array.isArray(d[k]) ? (d[k] as unknown[]) : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  const out = new Map<string, LedgerItem>();
  for (const x of list("needsYouClosed")) { const i = item(x, true); if (i) out.set(i.id, i); }
  for (const x of list("needsYou")) { const i = item(x, false); if (i) out.set(i.id, i); }   // the live list wins
  return [...out.values()];
}

// Re-reads only when the file changed; a file that can't be read or parsed (missing, half-written) is "not ok",
// never an empty list, so nothing is taken as closed because of a bad read.
export function ledgerReader(path: string, now: () => number = Date.now) {
  let cache: { mtimeMs: number; size: number; items: LedgerItem[] } | null = null;
  return (): LedgerRead => {
    try {
      const st = statSync(path);
      if (!cache || cache.mtimeMs !== st.mtimeMs || cache.size !== st.size) {
        cache = { mtimeMs: st.mtimeMs, size: st.size, items: parseLedger(JSON.parse(readFileSync(path, "utf8"))) };
      }
      return { ok: true, items: cache.items, at: now() };
    } catch (e) {
      cache = null;
      return { ok: false, error: (e as NodeJS.ErrnoException).code ?? "unreadable", at: now() };
    }
  };
}
