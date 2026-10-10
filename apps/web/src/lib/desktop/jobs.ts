// A job as the hub's feed shows it (design §7): the list fields, never the command or the tail.

export type ShownJob = {
  id: string; node: string; lane: string; name: string; class: string; state: string;
  outcome: string | null; exit: number | null; durationSec: number | null; notice: string; task: string | null;
};
export type JobCount = { node: string; running: number; queued: number; failed: number };

const text = (v: unknown): v is string => typeof v === "string";
const numOrNull = (v: unknown) => v === null || typeof v === "number";

export function decodeJob(raw: unknown): ShownJob | null {
  if (typeof raw !== "object" || raw === null) return null;
  const j = raw as Record<string, unknown>;
  if (!text(j.id) || !text(j.node) || !text(j.lane) || !text(j.name) || !text(j.class) || !text(j.state) || !text(j.notice)) return null;
  if (!(j.outcome === null || text(j.outcome)) || !numOrNull(j.exit) || !numOrNull(j.durationSec)) return null;
  if (!(j.task === null || text(j.task))) return null;
  return {
    id: j.id, node: j.node, lane: j.lane, name: j.name, class: j.class, state: j.state,
    outcome: j.outcome as string | null, exit: j.exit as number | null, durationSec: j.durationSec as number | null,
    notice: j.notice, task: j.task as string | null,
  };
}

// Enter or Space on a job chip opens the job. The card must not see that key.
export function chipOpensJob(key: string): boolean {
  return key === "Enter" || key === " ";
}

// Two nodes may both run `--id build`. The chip, the open job and the older-jobs list use this, not the id alone.
export function jobKey(job: { node: string; id: string }): string {
  return `${job.node}:${job.id}`;
}

// The chips on one task: the jobs aimed at it. Opening one does not move the task.
export function jobsOn(task: string, jobs: readonly ShownJob[]): ShownJob[] {
  return jobs.filter(job => job.task === task);
}

export function decodeJobs(raw: unknown[]): { jobs: ShownJob[]; dropped: number } {
  const jobs: ShownJob[] = [];
  let dropped = 0;
  for (const item of raw) {
    const job = decodeJob(item);
    if (job) jobs.push(job);
    else dropped += 1;
  }
  return { jobs, dropped };
}
