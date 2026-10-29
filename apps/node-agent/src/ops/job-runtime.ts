// What `morndo-node run` starts for jobs (ADR-0017). The same database, the grant cache, one delivery per notice,
// and the supervisor listening on job.sock. A terminal row hands its notice to that delivery before the sweep
// returns to the timer.
import { join } from "node:path";
import type Database from "better-sqlite3";
import { fleetRecord, type Job } from "@morndo/domain";
import type { EvJob } from "@morndo/protocol";
import type { WalSync } from "../db/wal-sync.ts";
import { deliverJobNotice, JobDeliveries, type TypeNotice } from "./job-delivery.ts";
import { JobGrants } from "./job-grant.ts";
import type { JobGuardPolicy } from "../config.ts";
import type { MachineSample } from "./job-guard.ts";
import { openJobSupervisor, type JobSupervisor } from "./job-supervisor.ts";
import { JobStore } from "./job-store.ts";

const SWEEP_MS = 1000;
const SLICE = "morndo-jobs";

export type JobRuntime = {
  supervisor: JobSupervisor;
  store: JobStore;
  grants: JobGrants;
  deliveries: JobDeliveries;
  close(): void;
};

export async function openJobRuntime(o: {
  db: Database.Database;
  home: string;
  stateDir: string;
  socketPath: string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  limits?: Readonly<Record<string, number>>;
  timeouts?: Readonly<Record<string, number>>;
  enabled?: boolean;
  guard?: JobGuardPolicy;
  readMachine?: () => MachineSample;
  sweepMs?: number;
  say?: (line: string) => void;
  hubBase?: string;
  type?: TypeNotice;
  toolEnv?: NodeJS.ProcessEnv;
  node?: string;
  emit?: (event: EvJob) => void;
  log?: { error: (message: string, error?: unknown) => void };
  walSync?: WalSync;
}): Promise<JobRuntime> {
  const now = o.now ?? Date.now;
  const grants = new JobGrants(o.db, now);
  const deliveries = new JobDeliveries(o.db, o.type ?? (() => false));
  const nodeName = o.node;
  const emit = o.emit;
  let store!: JobStore;
  store = new JobStore(o.db, join(o.stateDir, "job-logs"), now, {
    home: o.home,
    ...(o.walSync ? { walSync: o.walSync } : {}),
    onNotice: notice => { deliverJobNotice(store, deliveries, notice); },
    ...(nodeName !== undefined && emit !== undefined ? { onJob: (job: Job, tail: string) => { emit(fleetRecord(job, { node: nodeName, at: now(), tail })); } } : {}),
  });
  const supervisor = await openJobSupervisor(store, {
    home: o.home,
    stateDir: o.stateDir,
    socketPath: o.socketPath,
    grants,
    ...(o.hubBase ? { hubBase: o.hubBase } : {}),
    ...(o.env ? { env: o.env } : {}),
    ...(o.limits ? { limits: o.limits } : {}),
    ...(o.timeouts ? { timeouts: o.timeouts } : {}),
    ...(o.enabled !== undefined ? { enabled: o.enabled } : {}),
    ...(o.guard ? { guard: o.guard } : {}),
    ...(o.readMachine ? { readMachine: o.readMachine } : {}),
    ...(o.log ? { log: o.log } : {}),
  }, { slice: SLICE, ...(o.say ? { say: o.say } : {}), ...(o.toolEnv ? { toolEnv: o.toolEnv } : {}) });
  await supervisor.listen();
  const timer = setInterval(() => {
    jobTick(store, () => { void supervisor.sweep().catch(e => { o.log?.error("a job sweep failed", e); }); });
  }, o.sweepMs ?? SWEEP_MS);
  timer.unref();
  return {
    supervisor, store, grants, deliveries,
    close: () => { clearInterval(timer); supervisor.close(); },
  };
}

// The sweep timer also drops terminal jobs on the same 7-day rule as the fleet.
export function jobTick(store: JobStore, sweep: () => void): void {
  try { store.prune(); } catch { /* the next tick tries again */ }
  sweep();
}
