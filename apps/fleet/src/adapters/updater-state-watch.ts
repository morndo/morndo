// The control plane's own updater, as its state file says (updates §7; review of #107): the fleet runs on the
// control plane, one Install with its updater, and reads ~/.local/state/morndo-update/state.json the way it reads
// hold.json — a file the updater writes and nothing on the network can. A rollback recorded there halts its
// Rollout; no client route may (a lane on the control plane runs as the same user and could call one). Read once a
// second, as the hold is; a file that is missing, unreadable or not of the shape is no word at all.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UpdateStateFileSchema, parseBody, type UpdateStateFile } from "@morndo/protocol";

export const updaterStateFile = (home: string = process.env.HOME || homedir()): string =>
  join(home, ".local", "state", "morndo-update", "state.json");

export class UpdaterStateWatch {
  #path: string;
  #onReport: (r: UpdateStateFile) => void;
  #lastAt: number | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(o: { path: string; onReport: (r: UpdateStateFile) => void }) {
    this.#path = o.path;
    this.#onReport = o.onReport;
  }

  start(): void {
    this.refresh();
    this.#timer = setInterval(() => this.refresh(), 1000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  // One read: a report is passed on when its `at` differs from the last one passed on (the updater rewrites the file
  // at every outcome). The receiver is idempotent per machine and target, so a restart that reads it again is harmless.
  refresh(): void {
    let text: string;
    try { text = readFileSync(this.#path, "utf8"); } catch { return; }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return; }
    const r = parseBody(UpdateStateFileSchema, raw);
    if (r === null || r.at === this.#lastAt) return;
    this.#lastAt = r.at;
    this.#onReport(r);
  }
}
