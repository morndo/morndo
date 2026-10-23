// The revocation journal (RL10, docs/design/updates/README.md §11.5): every revocation a service writes to its
// database is appended here first, and each start applies what the journal holds. A database restored from an older
// copy then brings no revoked device, agent token or node back: whatever the restored file forgets, the journal
// remembers (AC4, FL4). The file is revoked.log, beside the database it shadows.
import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, readSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/** What a journal entry revokes: a hub endpoint, a hub agent token, or a fleet node — the three ids a restore could
 *  bring back. The connections store has no journal: it has no service to apply one at start. Endpoints and agent
 *  tokens have ids no later one reuses; a node keeps its name across a revoke and a join again, so a node's entry
 *  names the enrolment it revoked too, and a later enrolment under the same name is not revoked by it. */
export type RevocationKind = "endpoint" | "agent_token" | "node";
export type RevocationEntry =
  | { kind: "endpoint" | "agent_token"; id: string; at: number }
  | { kind: "node"; id: string; enrolment: string; at: number };
/** A complete line (newline-terminated) that is not a whole entry: skipped, and reported to whoever reads. */
export type BadLine = { line: number; why: string };

const asEntry = (v: unknown): RevocationEntry | string => {
  if (typeof v !== "object" || v === null) return "not an object";
  const e = v as Record<string, unknown>;
  if (typeof e.id !== "string" || e.id.length === 0 || typeof e.at !== "number") return "it has no id or at";
  if (e.kind === "endpoint" || e.kind === "agent_token") return { kind: e.kind, id: e.id, at: e.at };
  if (e.kind === "node") {
    return typeof e.enrolment === "string" && e.enrolment.length > 0
      ? { kind: "node", id: e.id, enrolment: e.enrolment, at: e.at } : "a node entry without its enrolment";
  }
  return "its kind is not endpoint, agent_token or node";
};

/** One key per thing revoked: what compaction keeps one entry of. */
export const revocationKey = (e: RevocationEntry): string => e.kind === "node" ? `node:${e.id}:${e.enrolment}` : `${e.kind}:${e.id}`;

/** The size above which a start compacts the journal (`compact`): about ten thousand entries. */
export const JOURNAL_COMPACT_BYTES = 1024 * 1024;

/** How long an append or a compaction waits for the other to finish with the journal. */
const JOURNAL_LOCK_WAIT_MS = 10_000;

export class RevocationJournal {
  readonly #path: string;

  constructor(path: string) { this.#path = path; }

  // One JSON line per revocation. The file is opened with O_APPEND ("a"), so two processes' lines land after one
  // another instead of over each other, created 0600 like the databases it shadows, and every line is fsynced before
  // append returns: callers write the journal before the database, so a crash between the two leaves a revocation the
  // next start applies — never one only the database knows. The directory is fsynced the one time the file is made,
  // so the file's own name survives the crash it is there for.
  append(entry: RevocationEntry): void {
    this.#locked(() => this.#append(entry));
  }

  #append(entry: RevocationEntry): void {
    const line = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
    const made = !existsSync(this.#path);
    const fd = openSync(this.#path, "a+", 0o600);
    try {
      // A torn last line — a crash cut an earlier append short — is cut off first: glued to this line it would
      // make one whole bad line, and every later start would refuse the journal. The torn entry was never
      // whole, and its database write never came (the journal goes first), so nothing is lost by cutting it.
      // A live writer's line is never seen half-written here: each line is one write(2) on an O_APPEND file.
      const size = fstatSync(fd).size;
      if (size > 0) {
        const tail = Buffer.alloc(1);
        readSync(fd, tail, 0, 1, size - 1);
        if (tail[0] !== 0x0a) {
          const whole = Buffer.alloc(size);
          readSync(fd, whole, 0, size, 0);
          ftruncateSync(fd, whole.lastIndexOf(0x0a) + 1);
        }
      }
      for (let at = 0; at < line.length;) at += writeSync(fd, line, at);   // a partial write loops until whole
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (made) {
      const dir = openSync(dirname(this.#path), "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
  }

  // Every well-formed line, in the order they were appended, and the lines that are not. A last line without its
  // newline is a write a crash cut short and is skipped quietly; the append after such a crash cuts it off before it
  // writes its own line. Any other bad line is skipped and reported, never thrown: a service that refused to start on
  // one would lose every revocation the rest of the journal holds, and crash-loop besides. An absent file is a
  // journal with nothing in it.
  read(): { entries: RevocationEntry[]; bad: BadLine[] } {
    let text: string;
    try { text = readFileSync(this.#path, "utf8"); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], bad: [] };
      throw e;
    }
    const entries: RevocationEntry[] = [];
    const bad: BadLine[] = [];
    text.split("\n").slice(0, -1).forEach((line, i) => {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch (e) { bad.push({ line: i + 1, why: (e as Error).message }); return; }
      const entry = asEntry(parsed);
      if (typeof entry === "string") bad.push({ line: i + 1, why: entry });
      else entries.push(entry);
    });
    return { entries, bad };
  }

  entries(): RevocationEntry[] { return this.read().entries; }

  // A start's housekeeping: past `maxBytes`, the journal is rewritten with one entry per thing revoked (the latest),
  // whole by rename, so it neither grows without end nor is read whole at length at every start. Bad lines are not
  // carried over (the caller reported them on its read). It holds the journal's lock from its read to its rename,
  // so another process's append waits and lands in the rewritten file. Answers whether it rewrote.
  compact(maxBytes = JOURNAL_COMPACT_BYTES, hooks: { beforeRename?: () => void } = {}): boolean {
    return this.#locked(() => this.#compact(maxBytes, hooks));
  }

  // One process at a time writes the journal: an append, or a compaction from its read to its rename, so a line
  // never lands in a file the rename is about to replace. The lock is SQLite's own exclusive lock on a file beside
  // the journal — the kernel drops it with a process that dies holding it, so a crash leaves no stale lock — and a
  // writer waits for it up to JOURNAL_LOCK_WAIT_MS. Revocations are rare and each holds it for one fsync.
  #locked<T>(fn: () => T): T {
    const lockPath = `${this.#path}.lock`;
    const lock = new Database(lockPath, { timeout: JOURNAL_LOCK_WAIT_MS });
    try {
      chmodSync(lockPath, 0o600);
      lock.pragma("locking_mode = EXCLUSIVE");
      lock.exec("BEGIN EXCLUSIVE");
      return fn();
    } finally { lock.close(); }
  }

  #compact(maxBytes: number, hooks: { beforeRename?: () => void }): boolean {
    let size: number;
    try { size = statSync(this.#path).size; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
    if (size <= maxBytes) return false;
    const latest = new Map<string, RevocationEntry>();
    for (const e of this.read().entries) latest.set(revocationKey(e), e);
    const temp = `${this.#path}.compact`;
    const fd = openSync(temp, "w", 0o600);
    try {
      const body = Buffer.from([...latest.values()].map(e => `${JSON.stringify(e)}\n`).join(""), "utf8");
      for (let at = 0; at < body.length;) at += writeSync(fd, body, at);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    hooks.beforeRename?.();
    renameSync(temp, this.#path);
    const dir = openSync(dirname(this.#path), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
    return true;
  }
}
