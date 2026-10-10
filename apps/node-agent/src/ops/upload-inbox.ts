// file.put's staging (spec §5.3): an upload from the fleet arrives in chunks into
// ~/.local/state/morndo-node/inbox/.partial/<upload> and moves into the inbox on its final chunk, where a lane on this
// node opens it by path. Chunks arrive in order (offset = the bytes so far), up to 25 MiB in all; a partial upload
// untouched for 10 minutes is deleted. Files are 0600 in a 0700 directory. What the inbox holds counts toward the
// node's disk budget (LIMITS.spoolMaxBytes, with the hook spool and the relay's copies; Task 9): `room` says how much
// is still free, and a chunk that doesn't fit is refused before anything is written.
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { LIMITS, type OpArgs } from "@morndo/protocol";
import { fail, ok, type EffectContext, type Outcome } from "./executor.ts";

export const PARTIAL_TTL_MS = 10 * 60_000;
// The sweep of every old file (a synchronous scan of two directories) runs at most this often, not at every 256 KiB chunk.
// The upload being written is still judged at each chunk, by its own file alone.
const SWEEP_EVERY_MS = 60_000;
// A partial's idleness is its mtime's age on the wall clock (the 10 minutes above). A wall-clock step (a time sync)
// would age every partial at once, a live upload's included, so for an upload this process is writing the time since its
// last chunk is also kept on the monotonic clock, process.hrtime.bigint() ("relative to an arbitrary time in the past,
// and not related to the time of day and therefore not subject to clock drift", Node.js process docs, v24). When the
// two clocks disagree about that time by more than this, the wall clock was stepped and the monotonic time is the one
// trusted. A partial left by an earlier process has no record here and is judged by its mtime alone.
const CLOCK_STEP_MS = 1000;

export function safeName(name: string): string {
  const cleaned = basename(name).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 100);
  return cleaned || "upload";
}

export class UploadInbox {
  readonly dir: string;
  #partial: string;
  #now: () => number;
  #room: () => number;
  #sweptAt = Number.NEGATIVE_INFINITY;
  #mono = (): bigint => process.hrtime.bigint();
  #touched = new Map<string, { wall: number; mono: bigint }>();   // upload -> its last chunk on both clocks (this process)

  constructor(o: { dir: string; now?: () => number; room?: () => number }) {
    this.dir = o.dir;
    this.#partial = join(o.dir, ".partial");
    this.#now = o.now ?? Date.now;
    this.#room = o.room ?? (() => Number.POSITIVE_INFINITY);
  }

  // The bytes the inbox holds: finished uploads and partial ones.
  bytes(): number {
    let total = 0;
    for (const dir of [this.dir, this.#partial]) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        try { const st = statSync(join(dir, f)); if (st.isFile()) total += st.size; } catch { /* gone meanwhile */ }
      }
    }
    return total;
  }

  async put(a: OpArgs["file.put"], ctx: EffectContext): Promise<Outcome<"file.put">> {
    mkdirSync(this.#partial, { recursive: true, mode: 0o700 });
    if (this.#now() - this.#sweptAt >= SWEEP_EVERY_MS) { this.#sweptAt = this.#now(); this.sweep(); }
    const partial = join(this.#partial, a.upload);
    try { if (this.#idleMs(a.upload, statSync(partial).mtimeMs, this.#now()) > PARTIAL_TTL_MS) this.#forget(a.upload, partial); } catch { /* none yet */ }
    const have = existsSync(partial) ? statSync(partial).size : 0;
    if (a.offset !== have) return fail("bad_args", `offset ${a.offset} does not follow the ${have} bytes received (or the upload expired)`);
    const bytes = Buffer.from(a.bytes, "base64");
    if (bytes.length > LIMITS.chunkBytes) return fail("bad_args", "a chunk is at most 256 KiB");
    if (have + bytes.length > LIMITS.maxFileBytes) {
      this.#forget(a.upload, partial);
      return fail("too_large", "an upload is at most 25 MiB");
    }
    const target = join(this.dir, `${a.upload}-${safeName(a.name)}`);
    if (a.final && existsSync(target)) return fail("bad_args", "this upload already finished");
    if (bytes.length > this.#room()) return fail("too_large", "this node's disk budget for uploads and hooks is full");
    const late = ctx.ready();
    if (late) return { ok: false, error: late };
    appendFileSync(partial, bytes, { mode: 0o600 });
    this.#touched.set(a.upload, { wall: this.#now(), mono: this.#mono() });
    if (!a.final) return ok<"file.put">({ path: null });
    renameSync(partial, target);
    this.#touched.delete(a.upload);
    return ok<"file.put">({ path: target });
  }

  // How long the partial `upload` has been untouched: its mtime's age, unless the wall clock and the monotonic clock
  // disagree about the time since its last chunk here (a step), when it is the monotonic time (see CLOCK_STEP_MS).
  #idleMs(upload: string, mtimeMs: number, now: number): number {
    const last = this.#touched.get(upload);
    if (!last) return now - mtimeMs;
    const wallSince = now - last.wall;
    const monoSince = Number(this.#mono() - last.mono) / 1e6;
    return Math.abs(wallSince - monoSince) > CLOCK_STEP_MS ? monoSince : now - mtimeMs;
  }

  #forget(upload: string, partial: string) {
    rmSync(partial, { force: true });
    this.#touched.delete(upload);
  }

  // Partial uploads untouched for 10 minutes; finished files older than a week (as the hub's own inbox keeps them).
  sweep(): number {
    const now = this.#now();
    let removed = 0;
    const drop = (dir: string, olderThan: number, age: (f: string, mtimeMs: number) => number) => {
      if (!existsSync(dir)) return;
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        try {
          const st = statSync(p);
          if (st.isFile() && age(f, st.mtimeMs) > olderThan) { rmSync(p, { force: true }); removed++; }
        } catch { /* gone meanwhile */ }
      }
    };
    drop(this.#partial, PARTIAL_TTL_MS, (f, mtimeMs) => {
      const idle = this.#idleMs(f, mtimeMs, now);
      if (idle > PARTIAL_TTL_MS) this.#touched.delete(f);
      return idle;
    });
    drop(this.dir, 7 * 24 * 3_600_000, (_f, mtimeMs) => now - mtimeMs);
    return removed;
  }
}
