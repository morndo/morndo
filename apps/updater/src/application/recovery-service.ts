// The recovery service (design §6.6): what runs after a crash — the updater's own start, before anything else it
// might do. It takes the apply lock (while an apply holds it, nothing else acts), reads the record from disk, and
// finishes the attempt the domain's table names: abandon what never swapped, carry on what did, judge what had just
// started, finish a commit that stood at its own mark, roll back what was mid-rollback. A record this build does
// not know gets the critical Alert and no action at all — never a guess.
import { formatVersion, parseVersion, recover as decide } from "@morndo/domain";
import {
  ApplyInterrupted, type ApplyDeps, type ApplyTiming, type StepCtx, abandonAttempt, continueAfterSwap, runCommit,
  runRollback, timingOf,
} from "./apply-steps.ts";
import type {
  AlertSink, ApplyingMarker, Backup, Clock, HoldWriter, Installer, Revocations, RoleProbe, ServiceManager, Sleeper,
  UpdateStore,
} from "./ports.ts";

export type RecoverOutcome =
  | { kind: "busy" }
  | { kind: "nothing_open" }
  | { kind: "abandoned" }
  | { kind: "committed"; version: string }
  | { kind: "rolled_back"; version: string; reason: string }
  | { kind: "rollback_failed"; reason: string }
  | { kind: "rollback_waiting"; reason: string }
  | { kind: "unknown_record"; detail: string };

export class RecoveryService {
  readonly #p: {
    services: ServiceManager; probe: RoleProbe; backup: Backup; revocations: Revocations; hold: HoldWriter;
    applying: ApplyingMarker; installer: Installer; store: UpdateStore; clock: Clock; sleeper: Sleeper;
    alerts: AlertSink; timing?: Partial<ApplyTiming>;
  };

  constructor(p: {
    services: ServiceManager; probe: RoleProbe; backup: Backup; revocations: Revocations; hold: HoldWriter;
    applying: ApplyingMarker; installer: Installer; store: UpdateStore; clock: Clock; sleeper: Sleeper;
    alerts: AlertSink; timing?: Partial<ApplyTiming>;
  }) {
    this.#p = p;
  }

  async recover(): Promise<RecoverOutcome> {
    const { services, probe, backup, revocations, hold, applying, installer, store, clock, sleeper, alerts } = this.#p;
    const timing = timingOf(this.#p.timing);
    const deps: ApplyDeps = { services, probe, backup, revocations, hold, applying, installer, store, clock, sleeper, alerts };
    const lock = store.tryLock();                   // §6.6: whatever runs next takes the apply lock first
    if (lock === null) return { kind: "busy" };
    try {
      const open = store.openUpdate();
      if (open === null) {
        // The lock in hand and nothing open: no apply is standing, so a mark still on disk is the window a dead
        // process left between its record's end and the mark's own removal (§5). It comes off here, or the
        // recovery unit — which runs only while the mark exists — would run forever with nothing to do.
        applying.clear();
        return { kind: "nothing_open" };
      }
      const layout = installer.layout();
      const current = layout.method === "updater" && layout.current !== null ? parseVersion(layout.current) : null;
      if (current === null) {
        if (store.firstAlert(open.id, "update_unknown_record", clock.now())) {    // one Alert per record, not one per run
          alerts.raise("update_unknown_record", `an open record at ${formatVersion(open.target)} with no current Version`);
        }
        return { kind: "unknown_record", detail: "no current Version to recover around" };
      }
      const decision = decide({
        format: open.format, mark: open.mark, committed: false, current,
        preUpdate: { current: open.preUpdate.current }, target: open.target, lockHeld: true,
      });
      if (!decision.ok) return { kind: "busy" };    // lockHeld is true here; the answer is never a crash regardless
      const ctx: StepCtx = { deps, timing, u: open };
      const running = services.services();
      switch (decision.value.act) {
        case "nothing":
          if (store.firstAlert(open.id, "update_unknown_record", clock.now())) alerts.raise("update_unknown_record", decision.value.unknown);
          return { kind: "unknown_record", detail: decision.value.unknown };
        case "abandon":
          // Nothing swapped: the old units back if the swap had begun, the hold off, the services on the old
          // Version, the attempt ended.
          await abandonAttempt(ctx, running);
          return { kind: "abandoned" };
        case "continue_apply":
        case "judge_health":
          // The swap finished (or the services are up, or will be): the same walk from the starts, judged against
          // the baseline the record carries when it has one — a boot apply's own (§6.7) — or a fresh one.
          return await continueAfterSwap(ctx, { running, baseline: open.judgeBaseline ?? null });
        case "continue_rollback":
          return await runRollback(ctx, { running, cause: "recovered mid-rollback", baseline: open.judgeBaseline ?? null });
        case "finish_commit":
          return await runCommit(ctx);
      }
    } catch (error) {
      if (error instanceof ApplyInterrupted) throw error;
      // A port that failed mid-recovery leaves the record open on purpose: the next recovery tries again, and the
      // Alert is the critical one — this machine needs a person.
      const message = error instanceof Error ? error.message : String(error);
      alerts.raise("update_rollback_failed", `recovery could not finish: ${message}`);
      return { kind: "rollback_failed", reason: message };
    } finally {
      lock.release();
    }
  }
}
