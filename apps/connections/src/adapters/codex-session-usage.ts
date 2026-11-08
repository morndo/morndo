// One record per Codex thread: the session's running token totals, so a resumed run is
// charged only what it added. A thread id that is not a plain id is never read or written.
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { countOf, type CodexAdded, type CodexUsageTotals } from "./spend.ts";

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 10;
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function sleepMs(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

function addTotals(a: CodexUsageTotals, b: CodexAdded): CodexUsageTotals {
  return { thread: a.thread, input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output };
}

function subTotals(totals: CodexUsageTotals, base: CodexUsageTotals): CodexAdded {
  return { input: totals.input - base.input, cached: totals.cached - base.cached, output: totals.output - base.output };
}

function gteTotals(totals: CodexUsageTotals, base: CodexUsageTotals): boolean {
  return totals.input >= base.input && totals.cached >= base.cached && totals.output >= base.output;
}

export class CodexSessionUsageFile {
  readonly #dir: string;
  readonly #lockWaitMs: number;
  constructor(dir: string, options: { lockWaitMs?: number } = {}) {
    this.#dir = dir;
    this.#lockWaitMs = options.lockWaitMs ?? 5000;
  }

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

  settle<T>(totals: CodexUsageTotals, run: { start: CodexUsageTotals | null; resumed: boolean }, price: (added: CodexAdded | null) => T): T {
    const whole: CodexAdded = { input: totals.input, cached: totals.cached, output: totals.output };
    if (!THREAD_ID.test(totals.thread)) return price(run.resumed ? null : whole);

    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const lockPath = join(this.#dir, `${totals.thread}.lock`);
    const deadline = Date.now() + this.#lockWaitMs;
    let ours: string | null = null;
    for (;;) {
      try {
        const fd = openSync(lockPath, "wx", 0o600);
        closeSync(fd);
        ours = lockPath;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const st = statSync(lockPath);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
        } catch { /* the lock vanished or cannot be read */ }
        if (Date.now() >= deadline) throw new Error(`codex usage record for ${totals.thread} is locked`);
        sleepMs(LOCK_RETRY_MS);
      }
    }
    try {
      const current = this.read(totals.thread);
      const base = run.start !== null && run.start.thread === totals.thread ? run.start : current;
      let added: CodexAdded | null;
      let next: CodexUsageTotals;
      if (base === null) {
        added = run.resumed ? null : whole;
        if (added === null) next = totals;
        else next = current === null ? totals : addTotals(current, whole);
      } else if (gteTotals(totals, base)) {
        added = subTotals(totals, base);
        next = addTotals(current ?? base, added);
      } else {
        added = whole;
        next = totals;
      }
      const cost = price(added);
      this.write(next);
      return cost;
    } finally {
      if (ours !== null) {
        try { unlinkSync(ours); } catch { /* another run took the lock */ }
      }
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
