// Lane state events (fleet clients spec §7): `needs_input` when a session's status turns `waiting` (any menu: a question,
// a permission prompt, a usage-limit dialog), with the question that menu asks read from this node's own screen (Task 2's
// menuQuestion, kira's rule); `answered` when it leaves `waiting`. Each is appended to the durable hook stream (the
// spool) on the path "/lane", with the window and session it came from, and goes to the fleet as a hook does: kept until
// acknowledged, replayed after a reconnect, with its own seq (plan Contracts, HookEvent). The relay never accepts "/lane"
// from outside (relay/server.ts answers 404), so no hook script can make one.
// - Statuses come from the inventory, read every 2 s (LIMITS.inventoryPollMs), by session.
// - A session first seen waiting (at the agent's start, say) gets its needs_input then: at least once, since a missed
//   one would leave a lane waiting unseen. A session gone while waiting gets its `answered`.
// - Which lanes the manager hears of (not its own, not laneEvents.ignore) is the fleet's to decide (spec §7, Task 9).
// - Any change of a status kicks the deliverer: a lane that stops waiting may take its delivery now.
// - Observations run one at a time, so the loop's read and the one after a welcome never both send an event.
import { setTimeout as sleep } from "node:timers/promises";
import { menuQuestion } from "@morndo/node-ops";
import type { Logger } from "./log.ts";
import type { Lane } from "./ops/inventory.ts";
import type { Spool } from "./relay/spool.ts";

export type LaneStateBody = { event: "needs_input" | "answered"; sessionId: string | null; question?: string };
export type LaneStateDeps = {
  spool: Pick<Spool, "append">;
  appended: () => void;                                    // the stream sender's kick
  screen: (pane: string) => Promise<string | null>;       // the pane's last lines, plain
  now: () => number;
  changed: () => void;                                     // the deliverer's kick
  log: Logger;
  retryMs?: number;                                        // the second look for a question (a test's shorter one)
};

const QUESTION_RETRY_MS = 500;

export class LaneStates {
  #d: LaneStateDeps;
  #seen = new Map<string, { status: Lane["status"]; window: string }>();   // session → its last status, and its window
  #chain: Promise<unknown> = Promise.resolve();

  constructor(d: LaneStateDeps) { this.#d = d; }

  observe(lanes: readonly Lane[]): Promise<void> {
    const next = this.#chain.then(() => this.#observe(lanes));
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #observe(lanes: readonly Lane[]): Promise<void> {
    const live = new Map<string, Lane>();
    for (const l of lanes) if (l.sessionId !== null) live.set(l.sessionId, l);
    let changed = false;
    for (const [sid, l] of live) {
      const was = this.#seen.get(sid);
      this.#seen.set(sid, { status: l.status, window: l.window });
      if (was !== undefined && was.status === l.status) continue;
      changed = true;
      if (l.status === "waiting") await this.#needsInput(sid, l);
      else if (was?.status === "waiting") this.#append(sid, l.window, { event: "answered", sessionId: sid });
    }
    for (const [sid, was] of [...this.#seen]) {
      if (live.has(sid)) continue;
      this.#seen.delete(sid);
      changed = true;
      if (was.status === "waiting") this.#append(sid, was.window, { event: "answered", sessionId: sid });
    }
    if (changed) this.#d.changed();
  }

  // The menu may draw a moment after the status turns: one more look before the event goes without a question.
  async #needsInput(sid: string, l: Lane): Promise<void> {
    let question = await this.#question(l.pane);
    if (question === null) {
      await sleep(this.#d.retryMs ?? QUESTION_RETRY_MS);
      question = await this.#question(l.pane);
    }
    this.#append(sid, l.window, { event: "needs_input", sessionId: sid, ...(question !== null ? { question } : {}) });
  }

  async #question(pane: string): Promise<string | null> {
    const shown = await this.#d.screen(pane);
    return shown === null ? null : menuQuestion(shown);
  }

  #append(sid: string, window: string, body: LaneStateBody): void {
    const r = this.#d.spool.append({ path: "/lane", at: this.#d.now(), session: sid, window, body });
    if (r.ok) this.#d.appended();
    else this.#d.log.warn(`a lane event (${body.event}) could not be spooled (${r.why}); counted as a drop`);
  }
}
