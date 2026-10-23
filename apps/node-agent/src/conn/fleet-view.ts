// The fleet view file (updates §6.7, §7): ~/.local/state/morndo-node/fleet-view.json, what this node's agent last
// heard from the fleet — the build the control plane runs, the Rollout as it stands, and the offer the fleet made
// this node (§5.4) — with the moment it was heard. The agent writes it; the node's updater reads it and follows it. A word only counts while it is fresh
// (FRESH_VIEW_MS, ten minutes), so while the agent is connected and online its observedAt is refreshed at every
// health tick: a quiet fleet still counts as a live one, and a stale file means the agent stopped talking, not that
// the Rollout stopped. Writes are atomic (atomic-write.ts) and never throw into the welcome or the health that
// caused them: a failing disk is logged, not traded for a dropped connection.
import type { FleetViewFile, RolloutWire } from "@morndo/protocol";
import { writeFileAtomic } from "../atomic-write.ts";
import type { Logger } from "../log.ts";

// What a welcome may carry (updates §7): the fields optional, so a fleet from before the updates design, and the
// join placeholder welcome, stay what they were — absent reads as null, a fleet that said nothing. `offer` (§5.4):
// the Rollout this node may take and the attempt id the fleet issued it for that; absent means the fleet offered
// this node nothing, which the file says as null — a node without an offer applies nothing.
export type Heard = {
  controlPlane?: { version: string; commit: string | null };
  rollout?: RolloutWire | null;
  offer?: { version: string; attempt: string };
};

export class FleetView {
  #path: string;
  #log: Logger;
  #file: FleetViewFile | null = null;

  constructor(o: { path: string; log: Logger }) {
    this.#path = o.path;
    this.#log = o.log;
  }

  /** A welcome: the view as the welcome had it, and the moment it was heard. */
  heard(w: Heard, at: number): void {
    this.#file = {
      observedAt: at, controlPlane: w.controlPlane ?? null, rollout: w.rollout ?? null, offer: w.offer ?? null,
    };
    this.#write();
  }

  /**
   * A `rollout` frame (§5.4): the Rollout moves, the control plane's build stays what the welcome said, and the
   * offer is whatever this frame carried — a frame without one clears it to null, so an offer dies with the word
   * that last said it and a node never applies on a stale one.
   */
  rollout(r: RolloutWire, offer: { version: string; attempt: string } | null, at: number): void {
    const was = this.#file;
    this.#file = { observedAt: at, controlPlane: was?.controlPlane ?? null, rollout: r, offer };
    this.#write();
  }

  /** The health tick's touch: the same word, heard now. Nothing to touch before the first welcome. */
  refresh(at: number): void {
    if (this.#file === null) return;
    this.#file = { ...this.#file, observedAt: at };
    this.#write();
  }

  #write(): void {
    try { writeFileAtomic(this.#path, `${JSON.stringify(this.#file)}\n`); }
    catch (e) { this.#log.warn("could not write fleet-view.json", e); }
  }
}
