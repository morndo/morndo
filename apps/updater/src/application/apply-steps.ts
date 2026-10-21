// The apply's shared steps (design §6.2–§6.6): the step record's moves (RL4), the safe-point and health waits, the
// backup round, and the rollback and the commit whole — everything the apply walks and a recovery walks again from
// whatever mark a crash left. This layer decides; the ports wait, stop and write, and every wait runs through the
// Sleeper and the Clock, so the machine's walls are the only walls there are.
import {
  DATABASES, HEALTH_DEADLINE_MS, PROBATION_MS, advance, beginStep, formatVersion, holdsWrites, judgeHealth,
  judgeProbation, mayRestore, rollbackRestores, safeToApply,
  type BackupRecord, type DatabaseName, type HealthReport, type MigrationStep, type SafePointReport, type SafeWait,
  type Update, type UpdateMark, type UpdateService, type UpdateState, type Version,
} from "@morndo/domain";
import type {
  AlertSink, Backup, Clock, HoldWriter, Installer, RoleProbe, ServiceManager, Sleeper, StoredUpdate, UpdateStore,
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
  services: ServiceManager; probe: RoleProbe; backup: Backup; hold: HoldWriter; installer: Installer;
  store: UpdateStore; clock: Clock; sleeper: Sleeper; alerts: AlertSink;
};

// §6.2's walls: the drain's patience, the polls, §6.4's health deadline and probation.
export type ApplyTiming = { drainMs: number; pollMs: number; healthMs: number; probationMs: number };
export const timingOf = (t?: Partial<ApplyTiming>): ApplyTiming => ({
  drainMs: t?.drainMs ?? 30_000,            // §6.2 step 3's patience with work in flight
  pollMs: t?.pollMs ?? 1_000,
  healthMs: t?.healthMs ?? HEALTH_DEADLINE_MS,
  probationMs: t?.probationMs ?? PROBATION_MS,
});

// ---- the step record (RL4)

// The record of the moment as the walking code holds it. Every move is one of the three below — a mark before the
// step runs, a done-mark after it, a state move between them — and each writes the store before it returns.
export type StepCtx = { deps: ApplyDeps; timing: ApplyTiming; u: StoredUpdate };

const withKept = (u: StoredUpdate, next: Update): StoredUpdate =>
  ({ ...next, format: u.format, startedAt: u.startedAt, doneMarks: u.doneMarks });

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

// Polls until no service reports work in flight, or the drain's wall passes. Null is the safe point; otherwise the
// blockers, one line each, for the deferred outcome's own list. Work in flight is never skipped, however urgent the
// ask: `now` lifts only the attending and window waits, and this walk is never the automatic one.
export async function waitSafePoint(
  ctx: StepCtx, running: readonly UpdateService[], o: { now: boolean },
): Promise<string[] | null> {
  const deadline = ctx.deps.clock.now() + ctx.timing.drainMs;
  for (;;) {
    const reports = await safePointRound(ctx.deps, running);
    const judged = safeToApply({
      reports, automatic: false, machineRunsHub: running.includes("hub"),
      attending: false, window: null, localMinutes: 0, now: o.now,
    });
    if (judged.ok) return null;
    if (ctx.deps.clock.now() >= deadline) return blockerNames(judged.error);
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

// The probation wall, up without a restart. The clock measures it — sleeping is the only way time passes — and the
// restarts are the manager's own count since the starts.
export async function waitProbation(
  ctx: StepCtx, running: readonly UpdateService[], o: { startedAt: number },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  while (ctx.deps.clock.now() - o.startedAt < ctx.timing.probationMs) {
    await ctx.deps.sleeper.sleep(ctx.timing.probationMs - (ctx.deps.clock.now() - o.startedAt));
  }
  let restarts = 0;
  for (const s of running) restarts += await ctx.deps.services.restarts(s);
  const judged = judgeProbation({ upMs: ctx.deps.clock.now() - o.startedAt, restarts });
  return judged.ok ? { ok: true } : { ok: false, reason: judged.error };
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
export async function runRollback(ctx: StepCtx, o: {
  running: readonly UpdateService[];
  cause: string;
  baseline: Record<string, string[]> | null;    // the apply's own, when it has one; a recovery reads fresh
}): Promise<RollbackOutcome> {
  const { deps } = ctx;
  const failed = (reason: string): RollbackOutcome => {
    deps.alerts.raise("update_rollback_failed", reason);
    done(ctx, "rolling_back");
    deps.store.finishUpdate(ctx.u.id, "rollback_failed", deps.clock.now());
    return { kind: "rollback_failed", reason };
  };
  mark(ctx, "rolling_back");
  const targetText = formatVersion(ctx.u.target);
  const oldText = formatVersion(ctx.u.preUpdate.current);
  try {
    if (await deps.services.tmuxInAgentUnit()) {
      // §6.5 step 1 (RL13): the tmux server sits inside the agent's unit, so the agent is not stopped and nothing
      // else moves either. The record stays open at rolling_back, never finished: the recovery unit (every
      // 5 minutes) walks this again once tmux no longer sits there.
      const reason = `tmux inside the node agent's unit; the rollback from ${targetText} waits (${o.cause})`;
      deps.alerts.raise("update_rollback_waiting", reason);
      return { kind: "rollback_waiting", reason };
    }
    await stopServices(deps, o.running);
    // The pair goes back as it was recorded (§6.5 step 2): the units, then the links — current first, then
    // previous, so a crash in between leaves both links on the known-good Version.
    await deps.services.renderUnits(oldText);
    deps.installer.swapBack({
      current: oldText,
      previous: ctx.u.preUpdate.previous === null ? null : formatVersion(ctx.u.preUpdate.previous),
    });
    // RL8: only what a migration changed goes back, and only when the old Version truly cannot open it — and a
    // restore with the Backup gone is refused, never forced.
    const plan = planOf(ctx.u.migrations);
    for (const db of rollbackRestores(plan)) {
      const allowed = mayRestore({
        database: db, restoreOnRollback: plan[db].restoreOnRollback, backupPresent: deps.backup.has(ctx.u.id, db),
      });
      if (!allowed.ok) return failed(`${db}: ${allowed.error} (${o.cause})`);
      deps.backup.restore(ctx.u.id, db);
    }
    await startServices(deps, o.running);
    const baseline = o.baseline ?? await baselineNow(deps, o.running);
    const healthy = await waitHealthy(ctx, o.running, { baseline, target: ctx.u.preUpdate.current });
    if (!healthy.ok) return failed(`${oldText} did not come back healthy: ${healthy.reason}`);
    // Whole again: the hold comes off, the Version is bad here forever (RL7), the Alert says what happened.
    deps.hold.clear();
    deps.store.recordBad(targetText, deps.clock.now());
    deps.alerts.raise("update_rolled_back", `${targetText} rolled back to ${oldText}: ${o.cause}`);
    done(ctx, "rolling_back");
    deps.store.finishUpdate(ctx.u.id, "rolled_back", deps.clock.now());
    return { kind: "rolled_back", version: oldText, reason: o.cause };
  } catch (error) {
    if (error instanceof ApplyInterrupted) throw error;
    return failed(error instanceof Error ? error.message : String(error));
  }
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
  deps.store.recordCommitted(targetText, deps.clock.now());
  done(ctx, "committing");
  deps.store.finishUpdate(ctx.u.id, "committed", deps.clock.now());
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
    const startedAt = deps.clock.now();
    await startServices(deps, o.running);
    done(ctx, "starting");
    moveTo(ctx, "probation");
    const baseline = o.baseline ?? await baselineNow(deps, o.running);
    const healthy = await waitHealthy(ctx, o.running, { baseline, target: ctx.u.target });
    if (!healthy.ok) {
      return await runRollback(ctx, { running: o.running, cause: healthy.reason, baseline: o.baseline });
    }
    const probation = await waitProbation(ctx, o.running, { startedAt });
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
