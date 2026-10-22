// The apply's shared steps (design §6.2–§6.6): the step record's moves (RL4), the safe-point and health waits, the
// backup round, and the rollback and the commit whole — everything the apply walks and a recovery walks again from
// whatever mark a crash left. This layer decides; the ports wait, stop and write, and every wait runs through the
// Sleeper and the Clock, so the machine's walls are the only walls there are.
import {
  DATABASES, HEALTH_DEADLINE_MS, PROBATION_MS, advance, beginStep, formatVersion, holdsWrites, judgeHealth,
  judgeProbation, mayRestore, parseVersion, rollbackRestores, safeToApply,
  type BackupRecord, type DatabaseName, type HealthReport, type MigrationStep, type SafePointReport, type SafeWait,
  type Update, type UpdateMark, type UpdateService, type UpdateState, type Version, type Window,
} from "@morndo/domain";
import type {
  AlertSink, ApplyingMarker, Backup, Clock, HoldWriter, Installer, Revocations, RoleProbe, ServiceManager, Sleeper,
  StoredUpdate, UpdateStore,
} from "./ports.ts";

// What the tests kill with: an interruption, not a failure. Every catch below lets it through — a dead process
// finishes nothing and records nothing, and the lock goes with the process, exactly as a real crash's would.
export class ApplyInterrupted extends Error {
  constructor(op: string) {
    super(`${op}: interrupted mid-step`);
    this.name = "ApplyInterrupted";
  }
}

// The ports every shared step needs; the apply and the recovery services each hold their own view of these.
export type ApplyDeps = {
  services: ServiceManager; probe: RoleProbe; backup: Backup; revocations: Revocations; hold: HoldWriter;
  applying: ApplyingMarker; installer: Installer; store: UpdateStore; clock: Clock; sleeper: Sleeper;
  alerts: AlertSink;
};

// §6.2's walls: the drain's patience, the polls, §6.4's health deadline and probation.
export type ApplyTiming = { drainMs: number; pollMs: number; healthMs: number; probationMs: number; holdAckMs: number };
export const timingOf = (t?: Partial<ApplyTiming>): ApplyTiming => ({
  drainMs: t?.drainMs ?? 30_000,            // §6.2 step 3's patience with work in flight
  pollMs: t?.pollMs ?? 1_000,
  // How long each service gets to say it has seen the hold (its health's `held`; service-kit HoldWatch re-reads
  // hold.json every second). A service that does not say so in time defers the apply (review of 2026-10-21).
  holdAckMs: t?.holdAckMs ?? 5_000,
  healthMs: t?.healthMs ?? HEALTH_DEADLINE_MS,
  probationMs: t?.probationMs ?? PROBATION_MS,
});

// ---- the step record (RL4)

// The record of the moment as the walking code holds it. Every move is one of the three below — a mark before the
// step runs, a done-mark after it, a state move between them — and each writes the store before it returns.
export type StepCtx = { deps: ApplyDeps; timing: ApplyTiming; u: StoredUpdate };

const withKept = (u: StoredUpdate, next: Update): StoredUpdate =>
  ({ ...next, format: u.format, startedAt: u.startedAt, doneMarks: u.doneMarks, judgeBaseline: u.judgeBaseline, backupOf: u.backupOf });

// Records the mark before the step it names runs. No-op when the record already stands there: a recovery picking
// up at exactly this mark is in order, not out of it.
export function mark(ctx: StepCtx, step: UpdateMark): void {
  if (ctx.u.mark === step) return;
  const stepped = beginStep(ctx.u, step, { lockHeld: true });
  if (!stepped.ok) throw new Error(`step ${step} cannot begin at ${ctx.u.state}`);   // a wiring bug, never an outcome
  ctx.u = withKept(ctx.u, stepped.value);
  ctx.deps.store.saveUpdate(ctx.u);
}

// The step ran: its mark goes on the done list, saved.
export function done(ctx: StepCtx, step: UpdateMark): void {
  if (ctx.u.doneMarks.includes(step)) return;
  ctx.u = { ...ctx.u, doneMarks: [...ctx.u.doneMarks, step] };
  ctx.deps.store.saveUpdate(ctx.u);
}

// A move the diagram allows (§4.4), saved; no-op when the record is already there.
export function moveTo(ctx: StepCtx, state: UpdateState): void {
  if (ctx.u.state === state) return;
  const moved = advance(ctx.u, state);
  if (!moved.ok) throw new Error(`cannot move ${ctx.u.state} to ${state}`);
  ctx.u = withKept(ctx.u, moved.value);
  ctx.deps.store.saveUpdate(ctx.u);
}

// The attempt's one ending: the record closes, then the `applying` mark comes off (§5) — the recovery unit runs
// only while the mark exists, so every terminal state takes it along. What keeps the mark is what keeps the record
// open: a rollback waiting on tmux, and an attempt a dead process left mid-step. The record closes first: a crash
// in between leaves nothing open under a mark, which the next recovery clears with nothing left to do.
export function finish(ctx: StepCtx, state: "committed" | "abandoned" | "rolled_back" | "rollback_failed"): void {
  ctx.deps.store.finishUpdate(ctx.u.id, state, ctx.deps.clock.now());
  ctx.deps.applying.clear();
}

// A record that predates its plan (or a hand-made one) plans nothing: no database migrates, nothing is held or
// restored. The apply always stores the plan with the record, so this is the never-taken branch that still has to
// say something.
const EMPTY_PLAN: Record<DatabaseName, MigrationStep> = {
  hub: { willMigrate: false, backupRequired: false, expectedSchema: 0, restoreOnRollback: false },
  fleet: { willMigrate: false, backupRequired: false, expectedSchema: 0, restoreOnRollback: false },
  node: { willMigrate: false, backupRequired: false, expectedSchema: 0, restoreOnRollback: false },
  connections: { willMigrate: false, backupRequired: false, expectedSchema: 0, restoreOnRollback: false },
};
export const planOf = (migrations: Record<DatabaseName, MigrationStep> | null): Record<DatabaseName, MigrationStep> =>
  migrations ?? EMPTY_PLAN;

// ---- the services, in the one order each way (§6.2 steps 4 and 7)

// The hub stops first and starts last: nothing that depends on it half-shuts-down twice.
const STOP_ORDER: readonly UpdateService[] = ["hub", "node", "fleet"];
const START_ORDER: readonly UpdateService[] = ["fleet", "node", "hub"];
const ordered = (running: readonly UpdateService[], order: readonly UpdateService[]): UpdateService[] =>
  order.filter(s => running.includes(s));

export async function stopServices(deps: ApplyDeps, running: readonly UpdateService[]): Promise<void> {
  for (const s of ordered(running, STOP_ORDER)) await deps.services.stop(s);
}

export async function startServices(deps: ApplyDeps, running: readonly UpdateService[]): Promise<void> {
  for (const s of ordered(running, START_ORDER)) await deps.services.start(s);
}

// ---- the safe point (§6.3)

// One round: every running service answers, and a service that does not answer is a blocker of its own — silence
// is not quiet, it is unknown work.
async function safePointRound(deps: ApplyDeps, running: readonly UpdateService[]): Promise<SafePointReport[]> {
  const reports: SafePointReport[] = [];
  for (const s of running) {
    const report = await deps.probe.safePoint(s);
    reports.push(report ?? { service: s, blockers: ["no_answer"] });
  }
  return reports;
}

const blockerNames = (waits: readonly SafeWait[]): string[] =>
  waits.map(w => (w.kind === "in_flight" ? `${w.service}: ${w.blocker}` : w.kind));

// §8.3's window is local hours of the day; the clock answers epoch milliseconds, and the local day's minutes are
// the Date's own local getters — the one conversion there is, kept where the wait lives.
const localMinutes = (now: number): number => {
  const t = new Date(now);
  return t.getHours() * 60 + t.getMinutes();
};

// Polls until no service reports work in flight, or the drain's wall passes. Null is the safe point; otherwise the
// blockers, one line each, for the deferred outcome's own list. Work in flight is never skipped, however urgent the
// ask: `now` lifts only the attending and window waits. The automatic walk (§8.3's tick) is the only one that waits
// for its window; attending is always "nobody is" for now — the hub reports no attending signal yet, and the
// settings step (PR 6) is where that answer comes from.
export async function waitSafePoint(
  ctx: StepCtx, running: readonly UpdateService[], o: { now: boolean; automatic?: boolean; window?: Window | null },
): Promise<string[] | null> {
  const deadline = ctx.deps.clock.now() + ctx.timing.drainMs;
  for (;;) {
    const reports = await safePointRound(ctx.deps, running);
    const judged = safeToApply({
      reports, automatic: o.automatic ?? false, machineRunsHub: running.includes("hub"),
      attending: false, window: o.window ?? null, localMinutes: localMinutes(ctx.deps.clock.now()), now: o.now,
    });
    if (judged.ok) return null;
    if (ctx.deps.clock.now() >= deadline) return blockerNames(judged.error);
    await ctx.deps.sleeper.sleep(ctx.timing.pollMs);
  }
}

// The services' own word that they have seen the hold (§6.2 step 3): each running service's health says `held` once
// its HoldWatch has read hold.json. Null when they all have; otherwise the ones that did not, by the ack's wall.
export async function waitHoldSeen(ctx: StepCtx, running: readonly UpdateService[]): Promise<string[] | null> {
  const deadline = ctx.deps.clock.now() + ctx.timing.holdAckMs;
  for (;;) {
    const missing: string[] = [];
    for (const s of running) if ((await ctx.deps.probe.seesHold(s)) !== true) missing.push(`${s}: has not seen the hold`);
    if (missing.length === 0) return null;
    if (ctx.deps.clock.now() >= deadline) return missing;
    await ctx.deps.sleeper.sleep(ctx.timing.pollMs);
  }
}

// ---- the baselines (§6.4), twice over

// Before the update: what passed is what must pass after — what already failed is not held against the target. A
// recovery has no before, so its baseline (baselineNow) is every check each service names right now: a service
// sick at the Version being judged stays a failure instead of forgiving itself. A service that answers nothing
// gets its entry either way — silence after the swap is no_report, never a pass by omission.
export async function baselineBefore(deps: ApplyDeps, running: readonly UpdateService[]): Promise<Record<string, string[]>> {
  const baseline: Record<string, string[]> = {};
  for (const s of running) {
    const report = await deps.probe.health(s);
    baseline[s] = report === null ? []
      : Object.entries(report.checks).filter(([, passed]) => passed === true).map(([name]) => name);
  }
  return baseline;
}

export async function baselineNow(deps: ApplyDeps, running: readonly UpdateService[]): Promise<Record<string, string[]>> {
  const baseline: Record<string, string[]> = {};
  for (const s of running) {
    const report = await deps.probe.health(s);
    baseline[s] = report === null ? [] : Object.keys(report.checks);
  }
  return baseline;
}

// ---- health and probation (§6.4, RL7)

const healthLine = (failure: { service: string; check: string }): string => `${failure.service}: ${failure.check}`;

// The services get the whole deadline to answer for their health. What the baseline names must pass, at the target
// Version — a wrong binary is a wrong answer however healthy it looks.
export async function waitHealthy(ctx: StepCtx, running: readonly UpdateService[], o: {
  baseline: Record<string, string[]>; target: Version;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const deadline = ctx.deps.clock.now() + ctx.timing.healthMs;
  for (;;) {
    const after: HealthReport[] = [];
    for (const s of running) {
      const report = await ctx.deps.probe.health(s);
      if (report !== null) after.push(report);
    }
    const judged = judgeHealth({ baseline: o.baseline, after, target: o.target });
    if (judged.ok) return { ok: true };
    if (ctx.deps.clock.now() >= deadline) return { ok: false, reason: healthLine(judged.error) };
    await ctx.deps.sleeper.sleep(ctx.timing.pollMs);
  }
}

// The probation wall (§6.4: healthy, then up "for 60 more"): it runs from the moment health passed, without a
// restart, and at its end the services are asked again — a service that went down inside the minute fails here
// even when the service manager has not restarted it yet (review of 2026-10-21). The clock measures it; sleeping is
// the only way time passes; the restarts are the manager's own count since the starts.
export async function waitProbation(
  ctx: StepCtx, running: readonly UpdateService[], o: { healthyAt: number; baseline: Record<string, string[]> },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  while (ctx.deps.clock.now() - o.healthyAt < ctx.timing.probationMs) {
    await ctx.deps.sleeper.sleep(ctx.timing.probationMs - (ctx.deps.clock.now() - o.healthyAt));
  }
  let restarts = 0;
  for (const s of running) restarts += await ctx.deps.services.restarts(s);
  const judged = judgeProbation({ upMs: ctx.deps.clock.now() - o.healthyAt, restarts });
  if (!judged.ok) return { ok: false, reason: judged.error };
  const after: HealthReport[] = [];
  for (const s of running) {
    const report = await ctx.deps.probe.health(s);
    if (report !== null) after.push(report);
  }
  const still = judgeHealth({ baseline: o.baseline, after, target: ctx.u.target });
  return still.ok ? { ok: true } : { ok: false, reason: `at the end of probation, ${healthLine(still.error)}` };
}

// ---- the backups (§6.2 step 5, RL5)

// A Backup for every database the plan migrates, each recorded as it lands — taken or failed — so the record says
// what there is before anything swaps. The first failure stops the round: nothing has moved yet.
export async function takeBackups(
  ctx: StepCtx, plan: Record<DatabaseName, MigrationStep>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const db of DATABASES) {
    if (!plan[db].backupRequired) continue;
    const taken = await ctx.deps.backup.take(ctx.u.id, db);
    const record: BackupRecord = taken.ok
      ? { database: db, done: true, passedCheck: true, schema: taken.schema }
      : { database: db, done: false, passedCheck: false, schema: null };
    ctx.u = { ...ctx.u, backups: [...ctx.u.backups, record] };
    ctx.deps.store.saveUpdate(ctx.u);
    if (!taken.ok) return { ok: false, reason: `${db}: the backup did not pass its check (${taken.reason})` };
  }
  return { ok: true };
}

// §6.2 step 7's first act (RL9): from start until commit, when a rollback would restore a database, every write
// but a revocation is held — the hold says so. Otherwise the drain's hold simply comes off.
export function holdForProbation(
  deps: ApplyDeps, running: readonly UpdateService[], o: { plan: Record<DatabaseName, MigrationStep>; version: string },
): void {
  if (holdsWrites(o.plan)) {
    deps.hold.write({ services: [...running], reason: "probation", version: o.version, since: deps.clock.now() });
  } else {
    deps.hold.clear();
  }
}

// ---- the rollback (§6.5), whole

export type RollbackOutcome =
  | { kind: "rolled_back"; version: string; reason: string }
  | { kind: "rollback_failed"; reason: string }
  | { kind: "rollback_waiting"; reason: string };

// The machine goes back to the pair it came from. Every step is one the record can stand on again — a recovery
// re-runs this from rolling_back — and the one thing it never does is stop the node agent's tmux: when the server
// sits inside the agent's unit, stopping it is not ours to do, and the rollback waits — the record stays open at
// rolling_back for the recovery unit to pick up again, with the critical Alert (RL13). A rollback that cannot put
// the old Version back healthy is the loudest outcome there is, and it stops there: no loop, and the services are
// left to the service manager (§4.4).
//
// One walk, two records. An update's own rollback goes back to preUpdate.current and blames its target; the
// principal's rollback (§8.1, kind "rollback") is its own Update, whose target IS where it goes and whose blame
// is the Version it leaves behind — preUpdate.current. Its Backups and its plan are the commit's own, named by
// the record's backupOf: the update that put the running Version here planned the migrations and took what a
// restore gives back (§6.5), so its record owns both.
const revocationsDropped = (db: string, dropped: readonly string[], target: string, cause: string): string =>
  `${db}: restoring its backup would drop the revocation of ${dropped.join(", ")}, made since the backup; ${target} keeps running (${cause})`;

export async function runRollback(ctx: StepCtx, o: {
  running: readonly UpdateService[];
  cause: string;
  baseline: Record<string, string[]> | null;    // the apply's own, when it has one; a recovery reads fresh
}): Promise<RollbackOutcome> {
  const { deps } = ctx;
  // A failed rollback is the target failing here all the same: bad on this machine (RL7) and its Rollout halted
  // (RL12) go on record before the alert, so nothing auto-installs it again and the fleet stops it elsewhere.
  const blameText = ctx.u.kind === "rollback" ? formatVersion(ctx.u.preUpdate.current) : formatVersion(ctx.u.target);
  const backText = ctx.u.kind === "rollback" ? formatVersion(ctx.u.target) : formatVersion(ctx.u.preUpdate.current);
  // §6.5's Backups belong to the update that took them; a rollback-kind record points at their owner.
  const backupOf = ctx.u.backupOf ?? ctx.u.id;
  const failed = (reason: string): RollbackOutcome => {
    deps.store.recordBad(blameText, deps.clock.now());
    deps.store.recordHalt(blameText, reason, deps.clock.now());
    deps.alerts.raise("update_rollback_failed", reason);
    done(ctx, "rolling_back");
    finish(ctx, "rollback_failed");
    return { kind: "rollback_failed", reason };
  };
  mark(ctx, "rolling_back");
  try {
    if (await deps.services.tmuxInAgentUnit()) {
      // §6.5 step 1 (RL13): the tmux server sits inside the agent's unit, so the agent is not stopped and nothing
      // else moves either. The record stays open at rolling_back, never finished: the recovery unit (every
      // 5 minutes) walks this again once tmux no longer sits there.
      const reason = `tmux inside the node agent's unit; the rollback from ${blameText} waits (${o.cause})`;
      // The hold is taken again on every visit while the rollback waits: a hold older than 10 minutes is ignored (§5),
      // and the writes a later restore would drop must stay held for as long as that restore may still come (RL9).
      holdForProbation(deps, o.running, { plan: planOf(ctx.u.migrations), version: blameText });
      deps.alerts.raise("update_rollback_waiting", reason);
      return { kind: "rollback_waiting", reason };
    }
    // RL8 and RL10, settled before anything moves: what a migration changed goes back only when the old Version truly
    // cannot open it; a restore with the Backup gone is refused, never forced; and a restore that would bring back a
    // device, agent token or node revoked since the Backup was taken is refused too — the services kept taking
    // revocations during probation (RL9), and what their journals do not hold lives only in the database a restore
    // would replace (the journal's own ids the adapter already leaves out; §11.5). The target keeps running; the
    // principal decides.
    const plan = planOf(ctx.u.migrations);
    const restores = rollbackRestores(plan);
    for (const db of restores) {
      const allowed = mayRestore({
        database: db, restoreOnRollback: plan[db].restoreOnRollback, backupPresent: deps.backup.has(backupOf, db),
      });
      if (!allowed.ok) return failed(`${db}: ${allowed.error} (${o.cause})`);
      const dropped = deps.revocations.droppedBy(backupOf, db, backText);
      if (dropped.length > 0) return failed(revocationsDropped(db, dropped, blameText, o.cause));
    }
    await stopServices(deps, o.running);
    // Again now that nothing runs: a revoke that landed between the check above and the stop lives only in the
    // database the restore would replace. Then the target's services start again and the rollback fails loudly.
    for (const db of restores) {
      const dropped = deps.revocations.droppedBy(backupOf, db, backText);
      if (dropped.length > 0) {
        await startServices(deps, o.running);
        return failed(revocationsDropped(db, dropped, blameText, o.cause));
      }
    }
    // The pair goes back as it was recorded (§6.5 step 2): the units, then the links — current first, then
    // previous, so a crash in between leaves both links on the known-good Version.
    await deps.services.renderUnits(backText, { services: o.running });
    deps.installer.swapBack({
      current: backText,
      // The pair as it stood before the attempt being undone: for an update, what preUpdate recorded (no
      // previous then means no link now); for a rollback, the Version it left — so another rollback can return.
      previous: ctx.u.kind === "rollback"
        ? formatVersion(ctx.u.preUpdate.current)
        : ctx.u.preUpdate.previous === null ? null : formatVersion(ctx.u.preUpdate.previous),
    });
    for (const db of restores) deps.backup.restore(backupOf, db);
    await startServices(deps, o.running);
    const baseline = o.baseline ?? await baselineNow(deps, o.running);
    const healthy = await waitHealthy(ctx, o.running, { baseline, target: parseVersion(backText)! });
    if (!healthy.ok) return failed(`${backText} did not come back healthy: ${healthy.reason}`);
    // Whole again: the hold comes off, the Version is bad here forever (RL7), the Alert says what happened.
    deps.hold.clear();
    deps.store.recordBad(blameText, deps.clock.now());
    deps.store.recordHalt(blameText, o.cause, deps.clock.now());      // RL12: the fleet halts the Rollout (PR 6)
    deps.alerts.raise("update_rolled_back", `${blameText} rolled back to ${backText}: ${o.cause}`);
    done(ctx, "rolling_back");
    finish(ctx, "rolled_back");
    return { kind: "rolled_back", version: backText, reason: o.cause };
  } catch (error) {
    if (error instanceof ApplyInterrupted) throw error;
    return failed(error instanceof Error ? error.message : String(error));
  }
}

// ---- an abandon (§4.4: nothing swapped; the old Version runs again)

// The units are rendered for the target before the links move (§6.2 step 6), so an attempt that stood at swapping
// may have the target's unit files on disk while current is still the old Version: those go back before anything
// starts (review of 2026-10-21). Then the hold comes off, the services start on the old Version, and the attempt ends.
export async function abandonAttempt(ctx: StepCtx, running: readonly UpdateService[]): Promise<void> {
  const { deps } = ctx;
  if (ctx.u.mark === "swapping") await deps.services.renderUnits(formatVersion(ctx.u.preUpdate.current), { services: running });
  deps.hold.clear();
  await startServices(deps, running);
  finish(ctx, "abandoned");
}

// ---- the commit (§6.2 step 10)

// The hold comes off, the Version is good, the commit is on record, and the keeps go: the installs the pair and
// good do not point at, and every Backup but the last three attempts'. A crash inside stands at committing; the
// recovery's finish_commit walks it again, idempotently.
export async function runCommit(ctx: StepCtx): Promise<{ kind: "committed"; version: string }> {
  const { deps } = ctx;
  mark(ctx, "committing");
  const targetText = formatVersion(ctx.u.target);
  const oldText = formatVersion(ctx.u.preUpdate.current);
  deps.hold.clear();
  deps.installer.setGood(targetText);
  // §6.7: the baseline this attempt was judged against goes down with the commit, so the next boot apply judges
  // the services against what passed here — a machine that was already sick at this Version is not held to it.
  deps.store.recordCommitted(targetText, deps.clock.now(), ctx.u.judgeBaseline ?? null);
  done(ctx, "committing");
  finish(ctx, "committed");
  const layout = deps.installer.layout();
  deps.installer.prune([targetText, oldText, layout.good ?? targetText]);
  const committedIds = deps.store.recentUpdates(50)
    .filter(row => row.state === "committed")
    .slice(0, 3)
    .map(row => row.id);
  deps.backup.prune(committedIds);
  return { kind: "committed", version: targetText };
}

// ---- steps 7 through 10, from wherever the starts stand

// The apply just swapped (§6.2); a recovery picks the same walk up at starting or probation (§6.6). The baseline
// is the apply's own when it has one; a recovery reads fresh. From here every failure is a rollback (§4.4): the
// machine is standing on the target, and the only other place it can stop is where it started.
export async function continueAfterSwap(ctx: StepCtx, o: {
  running: readonly UpdateService[];
  baseline: Record<string, string[]> | null;
}): Promise<RollbackOutcome | { kind: "committed"; version: string }> {
  const { deps } = ctx;
  try {
    mark(ctx, "starting");
    holdForProbation(deps, o.running, { plan: planOf(ctx.u.migrations), version: formatVersion(ctx.u.target) });
    await startServices(deps, o.running);
    done(ctx, "starting");
    moveTo(ctx, "probation");
    const baseline = o.baseline ?? await baselineNow(deps, o.running);
    // What this attempt is judged against travels in the record (§6.7): the commit writes it down, and a recovery
    // that finishes the walk still knows it.
    ctx.u = { ...ctx.u, judgeBaseline: baseline };
    deps.store.saveUpdate(ctx.u);
    const healthy = await waitHealthy(ctx, o.running, { baseline, target: ctx.u.target });
    if (!healthy.ok) {
      return await runRollback(ctx, { running: o.running, cause: healthy.reason, baseline: o.baseline });
    }
    const probation = await waitProbation(ctx, o.running, { healthyAt: deps.clock.now(), baseline });
    if (!probation.ok) {
      return await runRollback(ctx, { running: o.running, cause: probation.reason, baseline: o.baseline });
    }
    return await runCommit(ctx);
  } catch (error) {
    if (error instanceof ApplyInterrupted) throw error;
    return await runRollback(ctx, {
      running: o.running,
      cause: error instanceof Error ? error.message : String(error),
      baseline: o.baseline,
    });
  }
}
