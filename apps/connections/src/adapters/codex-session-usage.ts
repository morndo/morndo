// One record per Codex thread: the session's running token totals, so a resumed run is
// charged only what it added. A thread id that is not a plain id is never read or written.
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { countOf, type CodexUsageTotals } from "./spend.ts";

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export class CodexSessionUsageFile {
  readonly #dir: string;
  constructor(dir: string) { this.#dir = dir; }

  read(thread: string): CodexUsageTotals | null {
    if (!THREAD_ID.test(thread)) return null;
    let text: string;
    try { text = readFileSync(join(this.#dir, `${thread}.json`), "utf8"); }
    catch { return null; }
    let body: unknown;
    try { body = JSON.parse(text); }
    catch { return null; }
    return totalsOf(body, thread);
  }

  write(totals: CodexUsageTotals): void {
    if (!THREAD_ID.test(totals.thread)) return;
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const dest = join(this.#dir, `${totals.thread}.json`);
    const tmp = join(this.#dir, `.${totals.thread}.${randomBytes(8).toString("hex")}.tmp`);
    const bytes = Buffer.from(`${JSON.stringify({
      thread: totals.thread, input: totals.input, cached: totals.cached, output: totals.output,
    })}\n`);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      try {
        writeSync(fd, bytes);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      chmodSync(tmp, 0o600);
      renameSync(tmp, dest);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* the temp is already gone */ }
      throw error;
    }
  }
}

function totalsOf(value: unknown, thread: string): CodexUsageTotals | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("thread" in value) || value.thread !== thread) return null;
  const input = countOf(value, "input");
  const cached = countOf(value, "cached");
  const output = countOf(value, "output");
  if (input === null || cached === null || output === null) return null;
  return { thread, input, cached, output };
}

export function keepTotals(store: CodexSessionUsageFile, totals: CodexUsageTotals, log: (line: string) => void): void {
  try {
    store.write(totals);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "error";
    log(`could not keep the codex usage record (${code}); the next resume of this thread is charged from the last record that landed`);
  }
}
