// The revocation journal (RL10, docs/design/updates/README.md §11.5): every revocation a service writes to its
// database is appended here first, and each start applies what the journal holds. A database restored from an older
// copy then brings no revoked device, agent token or node back: whatever the restored file forgets, the journal
// remembers (AC4, FL4). The file is revoked.log, beside the database it shadows.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** What a journal entry revokes: a hub endpoint, a hub agent token, or a fleet node — the three ids a restore could
 *  bring back. The connections store has no journal: it has no service to apply one at start. */
export type RevocationKind = "endpoint" | "agent_token" | "node";
export type RevocationEntry = { kind: RevocationKind; id: string; at: number };

/** A line that is complete (newline-terminated) but not a whole entry. Reading on would risk losing a revocation in
 *  silence, which is the one thing the journal must never do, so it is thrown instead of skipped. */
export class JournalUnreadable extends Error {
  constructor(line: number, why: string) {
    super(`revoked.log line ${line} is not a revocation entry: ${why}`);
    this.name = "JournalUnreadable";
  }
}

const KINDS: readonly string[] = ["endpoint", "agent_token", "node"];
const asEntry = (v: unknown, line: number): RevocationEntry => {
  if (typeof v !== "object" || v === null) throw new JournalUnreadable(line, "not an object");
  const e = v as Record<string, unknown>;
  if (!KINDS.includes(e.kind as string) || typeof e.id !== "string" || e.id.length === 0 || typeof e.at !== "number") {
    throw new JournalUnreadable(line, "it is not { kind: endpoint | agent_token | node, id, at }");
  }
  return { kind: e.kind as RevocationKind, id: e.id, at: e.at };
};

export class RevocationJournal {
  readonly #path: string;

  constructor(path: string) { this.#path = path; }

  // One JSON line per revocation. The file is opened with O_APPEND ("a"), so two processes' lines land after one
  // another instead of over each other, created 0600 like the databases it shadows, and every line is fsynced before
  // append returns: callers write the journal before the database, so a crash between the two leaves a revocation the
  // next start applies — never one only the database knows. The directory is fsynced the one time the file is made,
  // so the file's own name survives the crash it is there for.
  append(entry: RevocationEntry): void {
    const line = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
    const made = !existsSync(this.#path);
    const fd = openSync(this.#path, "a", 0o600);
    try {
      for (let at = 0; at < line.length;) at += writeSync(fd, line, at);   // a partial write loops until whole
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (made) {
      const dir = openSync(dirname(this.#path), "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
  }

  // Every well-formed line, in the order they were appended. A last line without its newline is a write the crash
  // cut short and is skipped; the append after such a crash starts a fresh line of its own. An absent file is a
  // journal with nothing in it.
  entries(): RevocationEntry[] {
    let text: string;
    try { text = readFileSync(this.#path, "utf8"); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    return text.split("\n").slice(0, -1).map((line, i) => {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch (e) { throw new JournalUnreadable(i + 1, (e as Error).message); }
      return asEntry(parsed, i + 1);
    });
  }
}
