// The ApplyingMarker adapter (design §5): the `applying` mark, one file in the updater's state directory, present
// from the drain until the Update ends — and the only thing the recovery unit runs for (`morndo-update-recover`
// carries a ConditionPathExists on exactly this path). Written atomically like every state the updater owns: a
// temp file beside, fsynced, renamed over, so a look never sees half of one and a write that cannot land leaves
// the mark that is already there. Mode 0600: the mark is the updater's own business.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApplyingMarker } from "../application/ports.ts";

export class ApplyingFileMarker implements ApplyingMarker {
  readonly #path: string;

  constructor(o: { state: string }) {
    this.#path = join(o.state, "applying");
  }

  set(updateId: string): void {
    const temp = `${this.#path}.tmp`;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    rmSync(temp, { force: true });                    // a leftover temp must not keep its old mode through create
    writeFileSync(temp, `${updateId}\n`, { mode: 0o600 });
    const fd = openSync(temp, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.#path);
    const dirFd = openSync(dirname(this.#path), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  }

  clear(): void {
    rmSync(this.#path, { force: true });
  }

  present(): boolean {
    return existsSync(this.#path);
  }
}
