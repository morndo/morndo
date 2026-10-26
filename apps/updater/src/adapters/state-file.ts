// The updater's own state file (updates §6.3, §7): ~/.local/state/morndo-update/state.json, one write per
// outcome — staged, waiting, applying, current, rolled_back, rollback_failed — the agent's health reads back.
// Written atomically like every state the updater owns (applying-file's own way): a temp file beside, fsynced,
// renamed over, at 0600; a write that fails changes no outcome, so it never throws. The wire's label cap (200)
// is enforced by clipping, never by refusing: the file describes what happened, after it did.
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UpdateStateFile } from "@morndo/protocol";
import type { UpdateStateSink } from "../application/ports.ts";

const clip = (text: string): string => (text.length <= 200 ? text : `${text.slice(0, 199)}…`);

export class StateFileWriter implements UpdateStateSink {
  readonly #path: string;

  constructor(o: { path: string }) {
    this.#path = o.path;
  }

  write(s: UpdateStateFile): void {
    const clipped: UpdateStateFile = {
      ...s,
      ...(s.reason === undefined ? {} : { reason: clip(s.reason) }),
      ...(s.failedCheck === undefined ? {} : { failedCheck: clip(s.failedCheck) }),
    };
    const temp = `${this.#path}.tmp`;
    try {
      mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
      rmSync(temp, { force: true });                    // a leftover temp must not keep its old mode through create
      writeFileSync(temp, `${JSON.stringify(clipped)}\n`, { mode: 0o600 });
      const fd = openSync(temp, "r+");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.#path);
      const dirFd = openSync(dirname(this.#path), "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch {
      // The state file is a report, not a step: an outcome that cannot be written still happened.
    }
  }
}
