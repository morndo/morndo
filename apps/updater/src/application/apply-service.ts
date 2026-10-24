// The apply service (design §6.2–§6.5, §6.7; RL4–RL9, RL13): what `morndo update` runs once a Version stands
// staged — the whole walk, or the boot's own half of one — and what `morndo update --rollback` runs against a
// commit. The walk is recorded step by step, each mark on record before the step it names runs (RL4); it waits for
// the machine's own safe point (§6.3), and either commits or puts the machine back exactly as it was. Every outcome
// is one of §8.1's answers, and the CLI maps them to exits (§8.4: 75 for a deferred, 1 for a rolled back, 70 for a
// rollback that failed). Only an install this updater made is ever touched (RL14).
import {
  DATABASES, DEFAULT_CHANNEL, DEFAULT_MODE, RECORD_FORMAT, beginRollback, beginUpdate, compareVersions, formatVersion, higherOf,
  parseVersion, planMigrations, maySwap, type DatabaseName, type DbState, type Installation, type MigrationStep,
  type UpdateService, type Version, type Window,
} from "@morndo/domain";
import { ManifestSchema } from "@morndo/protocol";
import { CHECKOUT_SENTENCE } from "./check-service.ts";
import {
  ApplyInterrupted, type ApplyDeps, type ApplyTiming, type StepCtx, abandonAttempt, baselineBefore, continueAfterSwap,
  done, finish, holdForProbation, mark, runRollback, startServices, stopServices, takeBackups, timingOf, waitHoldSeen,
  waitSafePoint,
} from "./apply-steps.ts";
import type {
  AlertSink, ApplyingMarker, Backup, Clock, HoldWriter, Installer, Layout, Revocations, RoleProbe,
  SchemaInspector, ServiceManager, Sleeper, StoredUpdate, UpdateStateSink, UpdateStore, Verifier,
} from "./ports.ts";

export type ApplyOutcome =
  | { kind: "committed"; version: string }
  | { kind: "boot_started"; version: string }                  // §6.7: swapped, recorded at starting, services start on their own
  | { kind: "deferred"; reason: string; blockers: string[] }   // exit 75: nothing was stopped that runs
  | { kind: "abandoned"; reason: string }                      // nothing swapped; the old Version runs again
  | { kind: "rolled_back"; version: string; reason: string }   // exit 1
  | { kind: "rollback_failed"; reason: string }                // exit 70
  | { kind: "rollback_waiting"; reason: string }               // exit 75: tmux in the agent's unit; recovery retries
  | { kind: "no_previous" }                                    // §8.1's rollback with nothing to go back to: exit 78
  | { kind: "busy" }
  | { kind: "nothing_staged" }
  | { kind: "not_ours"; detail: string };                      // RL14

const encodeText = new TextEncoder();

// A document read through its wire schema (the check's own decoder): anything the schema refuses is null, never a
// guess at what it might have meant.
type Decoder<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
const decode = <T>(schema: Decoder<T>, text: string): T | null => {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export class ApplyService {
  readonly #p: {
    services: ServiceManager; probe: RoleProbe; schemas: SchemaInspector; backup: Backup; revocations: Revocations;
    hold: HoldWriter; applying: ApplyingMarker; installer: Installer; store: UpdateStore; clock: Clock;
    sleeper: Sleeper; alerts: AlertSink; verifier: Pick<Verifier, "sha256">; timing?: Partial<ApplyTiming>;
    state: UpdateStateSink; soakMinutes: number;
    /** §5.4's attempt id, when the caller brings none (the control plane's own applies): 16 random bytes, base64url. */
    mintAttempt: () => string;
  };

  constructor(p: {
    services: ServiceManager; probe: RoleProbe; schemas: SchemaInspector; backup: Backup; revocations: Revocations;
    hold: HoldWriter; applying: ApplyingMarker; installer: Installer; store: UpdateStore; clock: Clock;
    sleeper: Sleeper; alerts: AlertSink; verifier: Pick<Verifier, "sha256">; timing?: Partial<ApplyTiming>;
    state: UpdateStateSink; soakMinutes: number; mintAttempt: () => string;
  }) {
    this.#p = p;
  }

  async apply(o: {
    now: boolean; automatic?: boolean; window?: Window | null; boot?: boolean; attempt?: string;
  }): Promise<ApplyOutcome> {
    const {
      services, probe, schemas, backup, revocations, hold, applying, installer, store, clock, sleeper, alerts, verifier,
      state, soakMinutes, mintAttempt,
    } = this.#p;
    const timing = timingOf(this.#p.timing);
    const deps: ApplyDeps = {
      services, probe, backup, revocations, hold, applying, installer, store, clock, sleeper, alerts,
      state, soakMinutes,
    };
    // The id this Update reports itself under (§5.4): the fleet's own on a node (the offer's, or the one the
    // apply unit was handed), minted here only where no other source can exist — the control plane's own applies.
    const attempt = o.attempt ?? mintAttempt();
    // §8.3: only the automatic walk (the tick's) waits for its window; a person's ask never does.
    const automatic = o.automatic ?? false;
    const window = o.window ?? null;

    // §6.2 step 1, the plan — nothing below touches the machine. Only an install this updater made is ours (RL14).
    const layout = installer.layout();
    if (layout.method !== "updater" || layout.current === null || parseVersion(layout.current) === null) {
      return { kind: "not_ours", detail: CHECKOUT_SENTENCE };
    }
    const lock = store.tryLock();          // RL4: one apply at a time, and the sweep's lane is this one too
    if (lock === null) return { kind: "busy" };
    let running: UpdateService[] = [];
    let baseline: Record<string, string[]> | null = null;
    try {
      const staged = store.staged();
      if (staged === null || !installer.has(staged.version)) return { kind: "nothing_staged" };
      const target = parseVersion(staged.version);
      if (target === null) return { kind: "abandoned", reason: `the staged version ${staged.version} does not parse` };
      // RL7: a Version that failed here is never walked again, by any door — not after the fleet resumes its
      // Rollout, not from a staged record that outlived its rollback. Nothing is begun; state.json says why.
      if (store.badVersions().some(text => { const bad = parseVersion(text); return bad !== null && compareVersions(bad, target) === 0; })) {
        state.write({ state: "waiting", version: layout.current, target: staged.version, reason: "bad_here", at: clock.now() });
        return { kind: "deferred", reason: "bad_here", blockers: [] };
      }
      // The Manifest exactly as the check recorded it, re-read through the wire schema and re-hashed against the
      // record's own digest: the plan stands on the bytes that were verified, or not at all.
      const manifestText = store.manifestOf(staged.version);
      const manifest = manifestText === null ? null : decode(ManifestSchema, manifestText);
      if (manifestText === null || manifest === null
        || verifier.sha256(encodeText.encode(manifestText)) !== staged.manifestSha256) {
        return { kind: "abandoned", reason: "the staged manifest changed since it was recorded" };
      }
      const oldText = layout.current;
      const previousText = store.versionRecord(oldText)?.manifest ?? null;
      const previousManifest = previousText === null ? null : decode(ManifestSchema, previousText);
      // What the databases say, a missing one included as the nothing it is (schema 0, floor 0): a first update on
      // a machine with no hub database yet is a plan, not a surprise.
      const databases = {} as Record<DatabaseName, DbState>;
      for (const db of DATABASES) databases[db] = schemas.read(db) ?? { schema: 0, floor: 0 };
      const plan = planMigrations({ databases, target: manifest.schemas, previous: previousManifest?.schemas ?? null });
      if (!plan.ok) return { kind: "abandoned", reason: `${plan.error.database}: ${plan.error.reason}` };
      // The units the swap will render, judged now, before anything is recorded, held or stopped: a unit of one of
      // our names that Morndo did not write (and is not the setup before it, which the render adopts) would fail the
      // render after the services were down. Only `morndo install --force` replaces such a file.
      const foreign = await services.foreignUnits(staged.version, { services: services.services() });
      if (foreign.length > 0) {
        return { kind: "abandoned", reason: `${foreign.join(", ")}: not written by Morndo, so nothing was stopped; move ${foreign.length === 1 ? "it" : "them"} away, or run morndo install --force` };
      }

      // The record (RL4), begun with the machine as it stands and the plan inside it: a recovery reads both back.
      const machine = this.#installation(layout, store, target);
      const firstSave: StoredUpdate = {
        ...beginUpdate({ id: `upd-${clock.now()}`, target, machine }),
        migrations: plan.value,
        format: RECORD_FORMAT,
        startedAt: clock.now(),
        doneMarks: [],
        judgeBaseline: null,
        backupOf: null,
        attempt,
      };
      const ctx: StepCtx = { deps, timing, u: firstSave };
      store.saveUpdate(firstSave);
      // The walk has begun: state.json says so from here until one of its endings rewrites it (§6.3, §7), under
      // the attempt id every later record of this Update carries too (§5.4) — the id the fleet holds a halt against.
      state.write({ state: "applying", version: oldText, target: staged.version, attempt, at: clock.now() });
      running = services.services();

      if (o.boot === true) return await bootApply(ctx, { staged: staged.version, oldText, plan: plan.value, running });

      // §6.3: the machine's own word that nothing is in flight. Work in flight is never skipped, `--now` or not;
      // the poll ends at the drain's wall and the answer is deferred, with nothing written and nothing stopped.
      const blockers = await waitSafePoint(ctx, running, { now: o.now, automatic, window });
      if (blockers !== null) {
        state.write({ state: "waiting", version: oldText, reason: "the safe point never came", attempt, at: clock.now() });
        finish(ctx, "abandoned");
        return { kind: "deferred", reason: "the safe point never came", blockers };
      }
      if (await services.tmuxInAgentUnit()) {        // RL13: this updater never saws off its own branch
        state.write({ state: "waiting", version: oldText, reason: "tmux_in_agent_unit", attempt, at: clock.now() });
        finish(ctx, "abandoned");
        return { kind: "deferred", reason: "tmux_in_agent_unit", blockers: [] };
      }

      // Step 3: the hold goes on, and the last of the in-flight work drains inside its wall. A drain that never
      // finishes is a deferral, not a failure: the hold comes off and the attempt ends, to try again later.
      mark(ctx, "draining");
      // §5's `applying` mark, before the hold it belongs beside: from the drain to the end, its presence is what
      // the recovery unit runs on, so a process that dies past this point is always somebody's to finish.
      applying.set(ctx.u.id);
      hold.write({ services: [...running], reason: "drain", version: staged.version, since: clock.now() });
      // The drain is judged only once every service has said it has seen the hold and stopped taking new work; one
      // that does not say so in time defers the attempt like work that never drains (review of 2026-10-21).
      const unseen = await waitHoldSeen(ctx, running);
      if (unseen !== null) {
        hold.clear();
        state.write({ state: "waiting", version: oldText, reason: "a service did not acknowledge the hold", attempt, at: clock.now() });
        finish(ctx, "abandoned");
        return { kind: "deferred", reason: "a service did not acknowledge the hold", blockers: unseen };
      }
      const drainBlockers = await waitSafePoint(ctx, running, { now: o.now, automatic, window });
      if (drainBlockers !== null) {
        hold.clear();
        state.write({ state: "waiting", version: oldText, reason: "the drain did not finish", attempt, at: clock.now() });
        finish(ctx, "abandoned");
        return { kind: "deferred", reason: "the drain did not finish", blockers: drainBlockers };
      }
      done(ctx, "draining");
      const before = await baselineBefore(deps, running);
      baseline = before.passed;
      // Once per update, before the swap: every owner-path check that was already failing, in one alert.
      if (before.alreadyFailing.length > 0) {
        alerts.raise("update_check_already_failing", before.alreadyFailing
          .map(f => `${f.service}: ${f.check} was already failing before the update to ${staged.version}; it is not held against it`)
          .join(" "));
      }

      // Step 4: the services stop, in the one order that never half-shuts-down twice.
      mark(ctx, "stopping");
      await stopServices(deps, running);
      done(ctx, "stopping");

      // Step 5 (RL5): the backups, then the gate. Any failure here abandons — the hold comes off, the services
      // come back on the old Version, nothing has moved.
      const abandon = async (reason: string): Promise<ApplyOutcome> => {
        hold.clear();
        await startServices(deps, running);
        finish(ctx, "abandoned");
        return { kind: "abandoned", reason };
      };
      mark(ctx, "backing_up");
      const taken = await takeBackups(ctx, plan.value);
      if (!taken.ok) return await abandon(taken.reason);
      const gate = maySwap(plan.value, ctx.u.backups);
      if (!gate.ok) return await abandon(`${gate.error.database}: ${gate.error.reason}`);
      done(ctx, "backing_up");

      // Step 6: the units, then the links — the adapter's own order, previous first, is what makes a crash between
      // the two renames still run the old Version.
      mark(ctx, "swapping");
      await services.renderUnits(staged.version, { services: running });   // the machine's own units only
      installer.swap({ current: staged.version, previous: oldText });
      done(ctx, "swapping");

      // Steps 7 through 10: probation, health, the commit — or the whole way back (§6.5).
      return await continueAfterSwap(ctx, { running, baseline });
    } catch (error) {
      if (error instanceof ApplyInterrupted) throw error;        // a dead process records nothing
      const message = error instanceof Error ? error.message : String(error);
      // The record on disk is the truth of where this stood; re-read it as a recovery would.
      const open = store.openUpdate();
      if (open === null) return { kind: "abandoned", reason: message };
      const ctx: StepCtx = { deps, timing, u: open };
      // §4.4's line: before the swap is done, any failure abandons — and once the target is current, the only
      // other place the machine can stop is where it started.
      if (installer.layout().current === formatVersion(open.target)) {
        return await runRollback(ctx, { running, cause: message, baseline });
      }
      await abandonAttempt(ctx, running);
      return { kind: "abandoned", reason: message };
    } finally {
      lock.release();
    }
  }

  // The principal's rollback of the running Version (§8.1): its own Update, §6.5's walk against the commit that
  // put this Version here. The plan and the Backups are that commit's own (the record's backupOf names it);
  // without one — a Version installed by hand, a record too old — the swap still goes back, and nothing restores.
  async rollback(): Promise<ApplyOutcome> {
    const {
      services, probe, backup, revocations, hold, applying, installer, store, clock, sleeper, alerts,
      state, soakMinutes, mintAttempt,
    } = this.#p;
    const timing = timingOf(this.#p.timing);
    const deps: ApplyDeps = {
      services, probe, backup, revocations, hold, applying, installer, store, clock, sleeper, alerts,
      state, soakMinutes,
    };
    const layout = installer.layout();
    if (layout.method !== "updater" || layout.current === null || parseVersion(layout.current) === null) {
      return { kind: "not_ours", detail: CHECKOUT_SENTENCE };
    }
    const lock = store.tryLock();
    if (lock === null) return { kind: "busy" };
    try {
      const machine = this.#installation(layout, store, parseVersion(store.staged()?.version ?? layout.current)!);
      const begun = beginRollback({ id: `upd-${clock.now()}`, machine });
      if (!begun.ok) return { kind: "no_previous" };
      const owner = store.recentUpdates(200)
        .find(row => row.state === "committed" && formatVersion(row.target) === layout.current) ?? null;
      // The principal's rollback is its own Update, with an attempt id of its own (§5.4): minted, never reused —
      // the commit's id was spent by its own report, and a halt must count this rollback once, by its own id.
      const firstSave: StoredUpdate = {
        ...begun.value,
        migrations: owner?.migrations ?? null,
        backupOf: owner?.id ?? null,
        format: RECORD_FORMAT,
        startedAt: clock.now(),
        doneMarks: [],
        judgeBaseline: null,
        attempt: mintAttempt(),
      };
      const ctx: StepCtx = { deps, timing, u: firstSave };
      store.saveUpdate(firstSave);
      // Announced before anything moves (review of #111): the fleet counts a rollback only under an id it saw in an
      // `applying` record first, and this one leaves the running Version — that Version's Rollout halts.
      state.write({ state: "applying", version: layout.current, target: layout.current, attempt: firstSave.attempt!, at: clock.now() });
      // §5's `applying` mark before anything moves: a death past this point is the recovery unit's to finish.
      applying.set(ctx.u.id);
      const running = services.services();
      return await runRollback(ctx, { running, cause: "the principal asked for the previous Version", baseline: null });
    } catch (error) {
      if (error instanceof ApplyInterrupted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      // The record stays open at rolling_back on purpose: the recovery unit walks it again (§6.6), and the Alert
      // is the critical one — this machine needs a person.
      alerts.raise("update_rollback_failed", `a rollback could not run: ${message}`);
      return { kind: "rollback_failed", reason: message };
    } finally {
      lock.release();
    }
  }

  // The machine as the record's walk needs it (§6.2 step 1): the links and the store as they stand. The settings
  // here are the domain's defaults — the walk itself never reads them; the tick reads the real ones outside.
  #installation(layout: Layout, store: UpdateStore, staged: Version): Installation {
    const current = parseVersion(layout.current!)!;
    const committed = store.highestCommitted();
    return {
      current,
      previous: layout.previous === null ? null : parseVersion(layout.previous),
      staged,
      badVersions: store.badVersions().map(parseVersion).filter((v): v is Version => v !== null),
      highestCommitted: higherOf(current, committed === null ? current : parseVersion(committed) ?? current),
      keySet: store.trust().keySet,
      highestFeedSeq: store.trust().highestFeedSeq,
      installMethod: "updater",
      settings: { channel: DEFAULT_CHANNEL, mode: DEFAULT_MODE, pin: null, window: null },
    };
  }
}

// §6.7's boot apply: the half of the walk a starting machine runs. Nothing is running yet, so there is no safe
// point to wait for — the machine is at one by construction — nothing to hold for a drain and nothing to stop.
// The marks are §6.2's own, so the record stands where a recovery expects it; the backups and the gate are the
// same ones; and at `starting` this returns: the services start on their own (the boot unit is ordered Before
// them), and the recovery unit, ordered after, judges health and commits or rolls back (§6.6).
async function bootApply(ctx: StepCtx, o: {
  staged: string; oldText: string; plan: Record<DatabaseName, MigrationStep>; running: readonly UpdateService[];
}): Promise<ApplyOutcome> {
  const { deps } = ctx;
  try {
    mark(ctx, "draining");
    mark(ctx, "stopping");
    mark(ctx, "backing_up");
    // §5's `applying` mark, as in the whole walk: from here the recovery unit owns this attempt.
    deps.applying.set(ctx.u.id);
    const taken = await takeBackups(ctx, o.plan);
    if (!taken.ok) { finish(ctx, "abandoned"); return { kind: "abandoned", reason: taken.reason }; }
    const gate = maySwap(o.plan, ctx.u.backups);
    if (!gate.ok) { finish(ctx, "abandoned"); return { kind: "abandoned", reason: `${gate.error.database}: ${gate.error.reason}` }; }
    done(ctx, "backing_up");
    mark(ctx, "swapping");
    await deps.services.renderUnits(o.staged, { services: deps.services.services() });
    deps.installer.swap({ current: o.staged, previous: o.oldText });
    done(ctx, "swapping");
    mark(ctx, "starting");
    // The probation hold goes on before any service can start reading it (RL9): if the recovery's rollback would
    // restore a database, every write but a revocation is held from the first start.
    holdForProbation(deps, o.running, { plan: o.plan, version: o.staged });
    // What the recovery judges against from here (§6.7): the last commit's recorded baseline, not a fresh read —
    // nothing answers yet, and what passed at the last commit is what must pass after this one. It travels in the
    // record, so the commit the recovery writes carries it on (§6.7's commit).
    ctx.u = { ...ctx.u, judgeBaseline: deps.store.commitBaseline() };
    deps.store.saveUpdate(ctx.u);
    return { kind: "boot_started", version: o.staged };
  } catch (error) {
    if (error instanceof ApplyInterrupted) throw error;        // a dead process records nothing
    const message = error instanceof Error ? error.message : String(error);
    // The record on disk is the truth of where this stood; re-read it as a recovery would, as apply's own catch
    // does. §4.4's line holds here too: past the swap, the only other place the machine can stop is where it
    // started. A rollback at boot starts the services itself — the manager's own start coalesces with it.
    const open = deps.store.openUpdate();
    if (open === null) return { kind: "abandoned", reason: message };
    const reCtx: StepCtx = { deps, timing: ctx.timing, u: open };
    if (deps.installer.layout().current === formatVersion(open.target)) {
      return await runRollback(reCtx, { running: o.running, cause: message, baseline: null });
    }
    await abandonAttempt(reCtx, o.running);
    return { kind: "abandoned", reason: message };
  }
}
