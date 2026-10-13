// The additive linter (ADR-0019 §11.2): a migration declared "additive" promises an older service can still read the
// database it leaves. It is a promise the compiler can't check, so this runs the migration — against a real throwaway
// in-memory SQLite database, the same way it will really run — and fails on anything not on the additive list: a DROP,
// a rename, a rebuilt table (CREATE … AS SELECT), a NOT NULL column without a default, a column with a CHECK, a unique
// index on a table an older service writes, a foreign key that restricts or cascades its deletes, a trigger or a view.
// Running it for real is what makes the lint honest: a condition in up() decides on real rows and a real schema, so
// the statements it hides are linted too, not just the ones a stub would let pass. A migration may do all of that,
// but then it says `compat: "breaking"` and raises the floor it owes the services below it.
import Database from "better-sqlite3";
import type { Migration } from "./migrate.ts";

// Runs a migration against the throwaway database, recording every statement it hands to exec/prepare/pragma as it
// runs. A statement the lint fails is reported and not executed: the throwaway carries on without it.
class Run {
  readonly statements: string[] = [];
  readonly violations: string[] = [];
  private readonly db: Database.Database;
  private readonly lint: boolean;
  // What existed when this migration started: the tables an older service — one from before this migration, which is
  // what "additive" promises about — may still write.
  private readonly before: ReadonlySet<string>;

  constructor(db: Database.Database, lint: boolean) {
    this.db = db;
    this.lint = lint;
    this.before = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name),
    );
  }

  exec(sql: string): void {
    for (const statement of statementsOf(sql)) this.statement(statement);
  }

  prepare(sql: string): Database.Statement {
    const statements = statementsOf(sql);
    this.statements.push(...statements);
    if (this.lint) for (const statement of statements) this.judge(statement);
    return this.db.prepare(sql);
  }

  pragma(what: string): unknown {
    this.statements.push(`PRAGMA ${what}`);
    return this.db.pragma(what);
  }

  private statement(statement: string): void {
    this.statements.push(statement);
    if (this.lint && this.judge(statement)) return;            // reported, not run
    this.db.exec(statement);
  }

  private judge(statement: string): boolean {
    const violation = violationsOf(statement, this.before);
    if (violation === null) return false;
    this.violations.push(violation);
    return true;
  }
}

// Splits a multi-statement exec() string on semicolons outside strings and comments, comments stripped first — far
// enough for linting the migrations this repo writes (no trigger bodies with semicolons outside BEGIN…END).
function stripComments(sql: string): string {
  let out = "", quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], next = sql[i + 1];
    if (quote) { out += c; if (c === quote) quote = null; continue; }
    if (c === "-" && next === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && next === "*") { i += 2; while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; continue; }
    out += c;
  }
  return out;
}

function statementsOf(sql: string): string[] {
  const out: string[] = [];
  let current = "", quote: string | null = null;
  for (const c of stripComments(sql)) {
    if (quote) { current += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; current += c; continue; }
    if (c === ";") { out.push(current.trim()); current = ""; continue; }
    current += c;
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

// Moves data without changing what the database means to an older reader: a rebuild declared breaking runs these too.
const DATA = /^(INSERT|UPDATE|DELETE|REPLACE|SELECT|WITH|PRAGMA)\b/i;
// A column added to an existing table is readable as NULL (or its default) by an older service: nullable or defaulted.
const ADD_COLUMN = /^ALTER\s+TABLE\s+(["'`\w.]+)\s+ADD\s+(?:COLUMN\s+)?(.+)$/is;
const NOT_NULL_WITHOUT_DEFAULT = /\bNOT\s+NULL\b/i;
const HAS_DEFAULT = /\bDEFAULT\b/i;
const ON_DELETE_RESTRICT_OR_CASCADE = /\bON\s+DELETE\s+(RESTRICT|CASCADE)\b/i;

// Blanks the contents of string literals, keeping the quotes, so words in data ('DEFAULT', 'NOT NULL') cannot satisfy
// a keyword test. Double-quoted identifiers are left alone: they name things.
function withoutLiterals(text: string): string {
  let out = "", quote: string | null = null;
  for (const c of text) {
    if (quote !== null) {
      out += c === quote ? c : " ";
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === "`") { quote = c; out += c; continue; }
    out += c;
  }
  return out;
}

// The table a CREATE … INDEX names, unquoted.
function indexedTable(body: string): string | null {
  const on = body.match(/\bON\s+([^\s(]+)\s*\(/i);
  return on?.[1]?.replace(/^["'`[]+|["'`\]]+$/g, "") ?? null;
}

// Splits a CREATE TABLE body on the commas that separate columns and constraints, not the ones inside parentheses.
function topLevelParts(body: string): string[] {
  const parts: string[] = [];
  let depth = 0, current = "";
  for (const c of body) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += c;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

// A foreign key in a new table that reaches into a table from before this migration and deletes or rejects its rows:
// RESTRICT fails an older service's deletes, CASCADE silently removes rows it never named.
function foreignKeyViolation(body: string, before: ReadonlySet<string>): string | null {
  for (const part of topLevelParts(withoutLiterals(body))) {
    const reference = part.match(/\bREFERENCES\s+([^\s(,]+)/i);
    if (!reference?.[1] || !ON_DELETE_RESTRICT_OR_CASCADE.test(part)) continue;
    const table = reference[1].replace(/^["'`[]+|["'`\]]+$/g, "");
    if (!before.has(table)) continue;
    const action = part.match(ON_DELETE_RESTRICT_OR_CASCADE)?.[1]?.toUpperCase() ?? "";
    return action === "CASCADE"
      ? `points a foreign key at the existing table ${table} with ON DELETE CASCADE: an older service's deletes would silently drop rows`
      : `points a foreign key at the existing table ${table} with ON DELETE RESTRICT: an older service's deletes would fail`;
  }
  return null;
}

/** The statements a migration runs, in order — what the linter sees, and what a review of it reads. */
export function migrationStatements(migration: Migration): string[] {
  const db = new Database(":memory:");
  try {
    const run = new Run(db, false);
    migration.up(run as unknown as Database.Database);
    return run.statements;
  } finally {
    db.close();
  }
}

function violationsOf(statement: string, before: ReadonlySet<string>): string | null {
  if (DATA.test(statement)) return null;
  const create = statement.match(/^CREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX|VIEW|TRIGGER|VIRTUAL\s+TABLE)\b(.*)$/is);
  if (create?.[1] !== undefined && create[2] !== undefined) {
    const what = create[1].replace(/\s+/g, " ").toUpperCase();
    if (what === "TABLE") {
      if (/^\s+(IF\s+NOT\s+EXISTS\s+)?[^\s(]+\s+AS\b/i.test(create[2])) {
        return "rebuilds a table (CREATE TABLE … AS SELECT)";
      }
      return foreignKeyViolation(create[2], before);                                        // otherwise a new table: additive
    }
    if (what === "INDEX") return null;                                                      // a new plain index: additive
    if (what === "UNIQUE INDEX") {
      const table = indexedTable(create[2]);
      if (table !== null && before.has(table)) {
        return "creates a unique index on an existing table: an older service's inserts could violate it";
      }
      return null;                                                                          // on this migration's own table
    }
    return `creates a ${what.toLowerCase()}, which an older service may not know`;
  }
  const addColumn = statement.match(ADD_COLUMN);
  if (addColumn?.[2] !== undefined) {
    const definition = withoutLiterals(addColumn[2]);
    if (/\bCHECK\b/i.test(definition)) {
      return "adds a column with a CHECK: an older service's writes could fail it";
    }
    if (NOT_NULL_WITHOUT_DEFAULT.test(definition) && !HAS_DEFAULT.test(definition)) {
      return "adds a NOT NULL column with no default: an older service could not insert";
    }
    return null;                                                                            // a nullable or defaulted column: additive
  }
  if (/^ALTER\s+TABLE\b/i.test(statement)) return "changes a table other than by adding a column";
  const head = statement.split(/\s+/).slice(0, 3).join(" ");
  return `${head} is not on the additive list (§11.2)`;
}

function violationsIn(migration: Migration, db: Database.Database): string[] {
  // A migration declared breaking owes the floor, not the list — but it still runs, so the migrations after it meet
  // the schema it leaves.
  const run = new Run(db, migration.compat !== "breaking");
  migration.up(run as unknown as Database.Database);
  return run.violations.map(violation => `migration ${migration.version} (${migration.name}): ${violation}`);
}

/** What a migration declared "additive" does that an older service could not read; a "breaking" one owes nothing. */
export function additiveViolations(migration: Migration): string[] {
  const db = new Database(":memory:");
  try {
    return violationsIn(migration, db);
  } finally {
    db.close();
  }
}

/** Lints a service's whole list the way it will really run — one database, every migration in order, so each meets
 *  the schema the ones before it left. Empty when every additive migration holds to §11.2. */
export function lintMigrations(migrations: readonly Migration[]): string[] {
  const db = new Database(":memory:");
  try {
    const out: string[] = [];
    for (const migration of migrations) out.push(...violationsIn(migration, db));
    return out;
  } finally {
    db.close();
  }
}
