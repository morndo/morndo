// pane.* (spec §4 "The expectation check", §5.3). A side effect on a pane happens only when, inside the pane's queue,
// under its lock if the policy names one, and immediately before acting, the pane is still the one the caller meant:
// - the worker ID names this node, and its server stamp is the tmux server's stamp now;
// - the pane is in the policy's session and alone in its window;
// - the window has the expected name, and the expected Claude Code session (when given) runs in the pane.
// Anything else is `no_pane`, not executed: a restarted tmux server that reused `%N`, or a renamed or reused pane,
// never receives text meant for another lane. Refusals of the input-box checks (menu_open, no_input_box,
// draft_present) come from node-ops' tmux send before its paste and are answered as errors, not executed; the result's
// `problem` is null or not_submitted (typed, but no submit seen).
// pane.capture (fleet clients spec §5, "Reading") is a read: one pane's last lines, at most 2000 (args.ts), with tmux's
// attribute escapes when asked and wrapped lines joined unless `join` is false (RECONCILIATION.md ruling 10), in an
// answer of at most 256 KiB measured as it travels (LIMITS.captureMaxBytes, one bulk chunk; agent.ts sends it on the bulk
// lane). pane.captureMany keeps its 6 KiB a pane. A pane on tmux's alternate screen (Claude Code's fullscreen renderer),
// asked for more lines than it shows, answers scrollbackMissing: the alternate screen keeps no history, so the caller
// reads the session's transcript instead.
import { LIMITS, parseWorkerId, type Expect, type WorkerRef } from "@morndo/protocol";
import type { PaneLock, SessionInfo, Terminal, Tmux } from "@morndo/node-ops";
import type { Policy } from "../config.ts";
import { mapLimit } from "@morndo/service-kit";
import { capCapture } from "./capture-cap.ts";
import { effect, fail, ok, read, type EffectContext, type Failure, type OpTable } from "./executor.ts";
import type { Inventory } from "./inventory.ts";
import { paneFacts, type PaneFacts } from "./tmux-panes.ts";

export type GuardInput = { node: string; session: string; ref: WorkerRef; expect: Expect; facts: PaneFacts | null; sessionId: string | null };

export function expectationHolds(g: GuardInput): boolean {
  const f = g.facts;
  return f !== null
    && g.ref.node === g.node
    && g.expect.server === g.ref.server
    && f.stamp === g.ref.server
    && f.session === g.session
    && f.windowPanes === 1
    && f.window === g.expect.window
    && (g.expect.sessionId === undefined || g.expect.sessionId === g.sessionId);
}

export type PaneDeps = {
  node: string;
  policy: Policy;
  tmux: Tmux;
  terminal: Terminal;
  inventory: Inventory;
  sessions: () => Map<string, SessionInfo>;
  lock: (path: string, waitS: number) => PaneLock;
  now: () => number;                                      // the node's wall clock, for typedAt (runtime.ts)
  guard?: (g: GuardInput) => boolean;                     // a test replaces it to show what it prevents
};

const paneOf = (workerId: string) => `%${parseWorkerId(workerId)?.pane ?? -1}`;
const SEND_REFUSALS = { menu_open: "a menu is open in the pane", no_input_box: "the pane shows no input box", draft_present: "the pane's input box holds a draft", no_pane: "the pane went away", busy: "the pane is busy" } as const;

export function paneOps(d: PaneDeps): Pick<OpTable, "pane.captureMany" | "pane.capture" | "pane.frame" | "pane.keys" | "pane.send"> {
  const guard = d.guard ?? expectationHolds;
  const socket = d.policy.tmuxSocket;

  // The lock the policy names for the expected window (the manager's pane, say), then the expectation check, then the
  // deadline's last word, then `act`.
  async function guarded<R>(workerId: string, exp: Expect, ctx: EffectContext, act: (pane: string, session: SessionInfo | null) => Promise<{ ok: true; result: R } | Failure>): Promise<{ ok: true; result: R } | Failure> {
    const ref = parseWorkerId(workerId);
    if (!ref) return fail("no_pane", "not a worker ID");
    const pane = `%${ref.pane}`;
    const inner = async (): Promise<{ ok: true; result: R } | Failure> => {
      const facts = await paneFacts(socket, pane);
      if (facts === "unavailable") return fail("timeout", "tmux did not answer: nothing was done");
      const session = d.sessions().get(pane) ?? null;
      if (!guard({ node: d.node, session: d.policy.session, ref, expect: exp, facts, sessionId: session?.sessionId ?? null })) {
        return fail("no_pane", "the pane is not the one expected (server, window or session differ)");
      }
      const late = ctx.ready();
      if (late) return { ok: false, error: late };
      return act(pane, session);
    };
    // Own keys only: a window named "constructor" or "__proto__" would otherwise find Object.prototype's.
    const lockPath = Object.hasOwn(d.policy.lockedPanes, exp.window) ? d.policy.lockedPanes[exp.window] : undefined;
    if (lockPath === undefined) return inner();
    const waitS = Math.max(1, Math.min(20, Math.ceil(ctx.remainingMs() / 1000)));
    const held = await d.lock(lockPath, waitS)(inner);
    return held === "busy" ? fail("busy", "another typist holds the pane's lock") : held;
  }

  return {
    "pane.captureMany": read(async a => {
      // The inventory as the agent last read it (within its own poll interval); read again when a lane asked for isn't in it.
      let snap = await d.inventory.current(LIMITS.inventoryPollMs);
      if (a.workerIds.some(id => !snap.lanes.some(l => l.workerId === id))) snap = await d.inventory.refresh();
      const captures = await mapLimit(a.workerIds, 8, async workerId => {
        const lane = snap.lanes.find(l => l.workerId === workerId);
        const text = lane ? await d.tmux.capture(lane.pane) : null;
        if (text === null) return { workerId, text: null, truncated: false };
        return { workerId, ...capCapture(text, LIMITS.captureBytesPerPane) };
      });
      return ok<"pane.captureMany">({ captures });
    }),

    "pane.capture": read(async a => {
      let snap = await d.inventory.current(LIMITS.inventoryPollMs);
      if (!snap.lanes.some(l => l.workerId === a.workerId)) snap = await d.inventory.refresh();
      const lane = snap.lanes.find(l => l.workerId === a.workerId);
      const text = lane ? await d.tmux.capture(lane.pane, { lines: a.lines, attributes: a.attributes === true, join: a.join !== false }) : null;
      if (text === null || lane === undefined) return ok<"pane.capture">({ text: null, truncated: false });
      // tmux keeps no scrollback on the alternate screen (capture-pane -S: "negative numbers are lines in the history",
      // and there is none there), so more lines than the pane shows cannot come from tmux: said, never guessed at.
      const rows = await d.tmux.altScreenRows(lane.pane);
      const capped = capCapture(text, LIMITS.captureMaxBytes);
      return ok<"pane.capture">(rows !== null && a.lines > rows ? { ...capped, scrollbackMissing: true } : capped);
    }),

    "pane.frame": read(async a => {
      const ref = parseWorkerId(a.workerId);
      const pane = `%${ref?.pane ?? -1}`;
      // One tmux command: the frame, and with it the facts that say the pane is this lane's (its session and server stamp).
      const frame = ref !== null && ref.node === d.node ? await d.terminal.frame(pane, { session: d.policy.session, server: ref.server }) : null;
      if (frame === "unavailable") return fail("timeout", "tmux did not answer: no frame now");
      return ok<"pane.frame">({ frame });
    }),

    // Literal text as typed (terminal.keys), or tmux key names from the allow-list (Task 2's sendKeyNames); args.ts let
    // exactly one of them through.
    "pane.keys": effect(a => `pane:${paneOf(a.workerId)}`, (a, ctx) =>
      guarded(a.workerId, a.expect, ctx, async pane => ok<"pane.keys">({
        ok: a.names !== undefined ? await d.tmux.sendKeyNames(pane, a.names) : await d.terminal.keys(pane, a.data ?? ""),
      }))),

    "pane.send": effect(a => `pane:${paneOf(a.workerId)}`, (a, ctx) =>
      guarded(a.workerId, a.expect, ctx, async (pane, session) => {
        const typedAt = d.now();                          // the node's clock, just before the paste (spec §3.1, echo matching)
        const signal = AbortSignal.timeout(Math.max(1, Math.floor(ctx.remainingMs())));   // Node wants whole milliseconds
        let problem: Awaited<ReturnType<Tmux["send"]>>;
        try { problem = await d.tmux.send(pane, a.text, { signal, ...(session?.engine !== undefined ? { engineLane: true } : {}) }); }
        catch (e) {
          // Only the abort that throwIfAborted raised before the paste spawn is "not executed" (ADR-0012 decision 7: only a
          // refusal before any side effect releases the key). A paste that started and then failed or was killed (its 5 s
          // SIGKILL), even after the deadline, may have typed: it stays in doubt (internal, executed maybe).
          if (signal.aborted && e === signal.reason) return fail("timeout", "the deadline passed before the paste");
          throw e;
        }
        if (problem === null || problem === "not_submitted") return ok<"pane.send">({ problem, typedAt });
        return fail(problem, SEND_REFUSALS[problem]);
      })),
  };
}
