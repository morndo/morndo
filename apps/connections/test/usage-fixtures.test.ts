// The fixture matrix (AT-38, plan section 5): every source that has a line-parser in this repository carries a
// fixture for each required edge kind, and each fixture parses to the outcome class the kind names — so a parser
// whose edge case regresses, or whose fixture was never written, fails here by name. The fixtures are made-up
// values, never a real account's. Round 1: the Z.ai parser is a stub, so the matrix's vendor-api cases are red
// with "not implemented"; the claude cases pass against the existing parser and fixtures.
//
// Not here: Codex reads the app server's JSON through its own typed reader (tests in usage-codex.test.ts),
// Cursor's reader stays outside.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeReport } from "../src/adapters/usage-claude.ts";
import { parseZaiQuota } from "../src/adapters/usage-zai.ts";

// What every parser here returns, flattened to the parts the outcome classes speak of.
type Parsed =
  | { ok: true; windows: { id: string; used_percent: number; resets_at: number | null }[] }
  | { ok: false; reason: string; retryAfterS: number | null; hint: string | null };

type SourceEntry = {
  dir: string;
  ext: string;
  // Claude's files were named before this table existed: its null-window case is the null-percent file, its
  // no-scope case the null-report one. Every other kind is the file of its own name.
  fileOf: (kind: string) => string;
  load: (file: string) => unknown;
  parse: (raw: unknown) => Parsed;
  // The sign-in-or-scope failure of this source: no_scope for Claude, signed_out for Z.ai (an HTTP 200 with code 401).
  noScopeReason: string;
};

const FIXTURES = join(import.meta.dirname, "fixtures/usage");

const SOURCES_WITH_PARSERS: Record<string, SourceEntry> = {
  "claude-usage": {
    dir: "claude",
    ext: "jsonl",
    fileOf: kind => (kind === "null-window" ? "null-percent" : kind === "no-scope" ? "null-report" : kind),
    load: file => readFileSync(join(FIXTURES, "claude", `${file}.jsonl`), "utf8").split("\n").filter(l => l !== ""),
    parse: raw => parseClaudeReport(raw as string[]),
    noScopeReason: "no_scope",
  },
  "vendor-api": {
    dir: "zai",
    ext: "json",
    fileOf: kind => kind,
    load: file => JSON.parse(readFileSync(join(FIXTURES, "zai", `${file}.json`), "utf8")) as { status: number; retryAfter: string | null; body: unknown },
    parse: raw => parseZaiQuota(raw as { status: number; retryAfter: string | null; body: unknown }),
    noScopeReason: "signed_out",
  },
};

const REQUIRED_KINDS = ["null-window", "timestamp-percent", "expired", "rate-limited-retry", "rate-limited-no-retry", "no-scope", "unknown-shape"] as const;
type Kind = (typeof REQUIRED_KINDS)[number];

// The outcome class each edge kind must give: a window dropped or missing, a window dropped, a window kept with a
// past reset, rate_limited with the retry, rate_limited without it, the sign-in-or-scope failure, unknown_screen.
const OUTCOME: Record<Kind, (r: Parsed, entry: SourceEntry) => void> = {
  "null-window": r => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The fixture offers two limits; the unreadable one is dropped (for Z.ai, to `missing`), never shown as 0%.
    expect(r.windows).toHaveLength(1);
  },
  "timestamp-percent": r => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The fixture offers two limits; the epoch-valued percent is out of range, so that window is dropped.
    expect(r.windows).toHaveLength(1);
    for (const w of r.windows) expect(w.used_percent).toBeLessThanOrEqual(100);
  },
  "expired": r => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A past reset is kept as it is; dropping it is the hub's staleness rule, not the parser's.
    expect(r.windows.some(w => w.resets_at !== null && w.resets_at < Math.floor(Date.now() / 1000))).toBe(true);
  },
  "rate-limited-retry": r => {
    if (r.ok) throw new Error("expected a failure");
    expect(r.reason).toBe("rate_limited");
    expect(r.retryAfterS).not.toBeNull();
  },
  "rate-limited-no-retry": r => {
    if (r.ok) throw new Error("expected a failure");
    expect(r.reason).toBe("rate_limited");
    expect(r.retryAfterS).toBeNull();
  },
  "no-scope": (r, entry) => {
    if (r.ok) throw new Error("expected a failure");
    expect(r.reason).toBe(entry.noScopeReason);
  },
  "unknown-shape": r => {
    if (r.ok) throw new Error("expected a failure");
    expect(r.reason).toBe("unknown_screen");
  },
};

const pathOf = (entry: SourceEntry, kind: string): string => join(FIXTURES, entry.dir, `${entry.fileOf(kind)}.${entry.ext}`);

// The (source, kind) pairs whose fixture file is not there; the matrix test fails naming exactly these.
const missingFixtures = (table: Record<string, SourceEntry>): string[] => {
  const missing: string[] = [];
  for (const [source, entry] of Object.entries(table))
    for (const kind of REQUIRED_KINDS) if (!existsSync(pathOf(entry, kind))) missing.push(`${source}/${kind}`);
  return missing;
};

describe("every source with a parser has its edge fixtures (AT-38)", () => {
  it("no required (source, kind) fixture is missing", () => {
    const missing = missingFixtures(SOURCES_WITH_PARSERS);
    expect(missing, `missing edge fixtures: ${missing.join(", ")}`).toEqual([]);
  });

  it("each edge fixture parses to its outcome class", () => {
    for (const [, entry] of Object.entries(SOURCES_WITH_PARSERS))
      for (const kind of REQUIRED_KINDS) OUTCOME[kind](entry.parse(entry.load(entry.fileOf(kind))), entry);
  });

  it("a source missing one required kind is reported by name (an in-test copy with one file renamed)", () => {
    const renamed: Record<string, SourceEntry> = {
      ...SOURCES_WITH_PARSERS,
      "vendor-api": { ...SOURCES_WITH_PARSERS["vendor-api"]!, fileOf: (kind: string) => (kind === "expired" ? "expired-renamed" : kind) },
    };
    expect(missingFixtures(renamed)).toEqual(["vendor-api/expired"]);
  });
});
