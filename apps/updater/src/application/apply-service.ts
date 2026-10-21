// The apply service (design §6.2–§6.5; RL4–RL9, RL13): what `morndo update` runs once a Version stands staged. The
// walk is recorded step by step, each mark on record before the step it names runs (RL4); it waits for the
// machine's own safe point (§6.3), and either commits or puts the machine back exactly as it was. Every outcome is
// one of §8.1's answers, and the CLI maps them to exits (§8.4: 75 for a deferred, 1 for a rolled back, 70 for a
// rollback that failed). Only an install this updater made is ever touched (RL14).
import {
  DATABASES, DEFAULT_CHANNEL, DEFAULT_MODE, RECORD_FORMAT, beginUpdate, formatVersion, higherOf, parseVersion,
  planMigrations, maySwap, type DatabaseName, type DbState, type Installation, type UpdateService, type Version,
} from "@morndo/domain";
import { ManifestSchema } from "@morndo/protocol";
import { CHECKOUT_SENTENCE } from "./check-service.ts";
import {
  ApplyInterrupted, type ApplyDeps, type ApplyTiming, type StepCtx, abandonAttempt, baselineBefore, continueAfterSwap,
  done, mark, runRollback, startServices, stopServices, takeBackups, timingOf, waitSafePoint,
} from "./apply-steps.ts";
import type {
  AlertSink, Backup, Clock, HoldWriter, Installer, Revocations, RoleProbe, SchemaInspector, ServiceManager, Sleeper,
  StoredUpdate, UpdateStore, Verifier,
} from "./ports.ts";

export type ApplyOutcome =
  | { kind: "committed"; version: string }
  | { kind: "deferred"; reason: string; blockers: string[] }   // exit 75: nothing was stopped that runs
  | { kind: "abandoned"; reason: string }                      // nothing swapped; the old Version runs again
  | { kind: "rolled_back"; version: string; reason: string }   // exit 1
  | { kind: "rollback_failed"; reason: string }                // exit 70
  | { kind: "rollback_waiting"; reason: string }               // exit 75: tmux in the agent's unit; recovery retries
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
    hold: HoldWriter; installer: Installer; store: UpdateStore; clock: Clock; sleeper: Sleeper; alerts: AlertSink;
    verifier: Pick<Verifier, "sha256">; timing?: Partial<ApplyTiming>;
  };

  constructor(p: {
    services: ServiceManager; probe: RoleProbe; schemas: SchemaInspector; backup: Backup; revocations: Revocations;
    hold: HoldWriter; installer: Installer; store: UpdateStore; clock: Clock; sleeper: Sleeper; alerts: AlertSink;
    verifier: Pick<Verifier, "sha256">; timing?: Partial<ApplyTiming>;
  }) {
    this.#p = p;
  }

  async apply(o: { now: boolean }): Promise<ApplyOutcome> {
    const { services, probe, schemas, backup, revocations, hold, installer, store, clock, sleeper, alerts, verifier } = this.#p;
    const timing = timingOf(this.#p.timing);
    const deps: ApplyDeps = { services, probe, backup, revocations, hold, installer, store, clock, sleeper, alerts };

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
      // The Manifest exactly as the check recorded it, re-read through the wire schema and re-hashed against the
      // record's own digest: the plan stands on the bytes that were verified, or not at all.
      const manifestText = store.manifestOf(staged.version);
      const manifest = manifestText === null ? null : decode(ManifestSchema, manifestText);
      if (manifestText === null || manifest === null
        || verifier.sha256(encodeText.encode(manifestText)) !== staged.manifestSha256) {
        return { kind: "abandoned", reason: "the staged manifest changed since it was recorded" };
      }
      const oldText = layout.current;
      const current = parseVersion(oldText)!;
      const previousText = store.versionRecord(oldText)?.manifest ?? null;
      const previousManifest = previousText === null ? null : decode(ManifestSchema, previousText);
      // What the databases say, a missing one included as the nothing it is (schema 0, floor 0): a first update on
      // a machine with no hub database yet is a plan, not a surprise.
      const databases = {} as Record<DatabaseName, DbState>;
      for (const db of DATABASES) databases[db] = schemas.read(db) ?? { schema: 0, floor: 0 };
      const plan = planMigrations({ databases, target: manifest.schemas, previous: previousManifest?.schemas ?? null });
      if (!plan.ok) return { kind: "abandoned", reason: `${plan.error.database}: ${plan.error.reason}` };

      // The record (RL4), begun with the machine as it stands and the plan inside it: a recovery reads both back.
      const committed = store.highestCommitted();
      const machine: Installation = {
        current,
        previous: layout.previous === null ? null : parseVersion(layout.previous),
        staged: target,
        badVersions: store.badVersions().map(parseVersion).filter((v): v is Version => v !== null),
        highestCommitted: higherOf(current, committed === null ? current : parseVersion(committed) ?? current),
        keySet: store.trust().keySet,
        highestFeedSeq: store.trust().highestFeedSeq,
        installMethod: "updater",
        settings: { channel: DEFAULT_CHANNEL, mode: DEFAULT_MODE, pin: null, window: null },
      };
      const firstSave: StoredUpdate = {
        ...beginUpdate({ id: `upd-${clock.now()}`, target, machine }),
        migrations: plan.value,
        format: RECORD_FORMAT,
        startedAt: clock.now(),
        doneMarks: [],
      };
      const ctx: StepCtx = { deps, timing, u: firstSave };
      store.saveUpdate(firstSave);
      running = services.services();

      // §6.3: the machine's own word that nothing is in flight. Work in flight is never skipped, `--now` or not;
      // the poll ends at the drain's wall and the answer is deferred, with nothing written and nothing stopped.
      const blockers = await waitSafePoint(ctx, running, { now: o.now });
      if (blockers !== null) {
        store.finishUpdate(ctx.u.id, "abandoned", clock.now());
        return { kind: "deferred", reason: "the safe point never came", blockers };
      }
      if (await services.tmuxInAgentUnit()) {        // RL13: this updater never saws off its own branch
        store.finishUpdate(ctx.u.id, "abandoned", clock.now());
        return { kind: "deferred", reason: "tmux_in_agent_unit", blockers: [] };
      }

      // Step 3: the hold goes on, and the last of the in-flight work drains inside its wall. A drain that never
      // finishes is a deferral, not a failure: the hold comes off and the attempt ends, to try again later.
      mark(ctx, "draining");
      hold.write({ services: [...running], reason: "drain", version: staged.version, since: clock.now() });
      // The services re-read the hold every second; the drain is judged only once each has had a full interval to
      // see it and stop taking new work (review of 2026-10-21).
      await deps.sleeper.sleep(timing.holdSeenMs);
      const drainBlockers = await waitSafePoint(ctx, running, { now: o.now });
      if (drainBlockers !== null) {
        hold.clear();
        store.finishUpdate(ctx.u.id, "abandoned", clock.now());
        return { kind: "deferred", reason: "the drain did not finish", blockers: drainBlockers };
      }
      done(ctx, "draining");
      baseline = await baselineBefore(deps, running);

      // Step 4: the services stop, in the one order that never half-shuts-down twice.
      mark(ctx, "stopping");
      await stopServices(deps, running);
      done(ctx, "stopping");

      // Step 5 (RL5): the backups, then the gate. Any failure here abandons — the hold comes off, the services
      // come back on the old Version, nothing has moved.
      const abandon = async (reason: string): Promise<ApplyOutcome> => {
        hold.clear();
        await startServices(deps, running);
        store.finishUpdate(ctx.u.id, "abandoned", clock.now());
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
      await services.renderUnits(staged.version);
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
}
