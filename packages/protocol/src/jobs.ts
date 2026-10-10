// Job events and the fleet's job list (ADR-0017; docs/design/background-jobs §4, §7). The command line is not a
// field: a decoded job has the state, the redacted tail and the notify target. The agent channel carries this
// as `t: "job"` (ev.job). GET /v1/jobs answers from the same shape.
import type { FleetJob, JobOutcome, JobState, NoticeState, QueueReason } from "@morndo/domain";
import { JOB_CLASS, JOB_ID, JOB_OUTCOMES, JOB_STATES, LANE_NAME, NOTICE_MAX, NOTICE_STATES, QUEUE_REASONS } from "@morndo/domain";
import { taskKey } from "./board.ts";
import { NODE_NAME } from "./worker-id.ts";
import * as z from "./z.ts";

const str = (max: number) => z.string().check(z.maxLength(max));
const jobId = () => z.string().check(z.regex(JOB_ID));
const nodeName = () => z.string().check(z.regex(NODE_NAME));
const lane = () => z.string().check(z.regex(LANE_NAME));
const jobClass = () => z.string().check(z.regex(JOB_CLASS));

const STATES = JOB_STATES satisfies readonly JobState[];
const OUTCOMES = JOB_OUTCOMES satisfies readonly JobOutcome[];
const NOTICES = NOTICE_STATES satisfies readonly NoticeState[];
const REASONS = QUEUE_REASONS satisfies readonly QueueReason[];

export const JobNotifySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("lane"), name: lane() }),
  z.object({ kind: z.literal("task"), key: taskKey() }),
  z.object({ kind: z.literal("fleet") }),
]);

const jobFields = {
  id: jobId(),
  node: nodeName(),
  lane: lane(),
  name: str(64),
  class: jobClass(),
  state: z.enum(STATES),
  outcome: z.nullable(z.enum(OUTCOMES)),
  exit: z.nullable(z.int().check(z.gte(0), z.lte(255))),
  durationSec: z.nullable(z.number().check(z.gte(0))),
  notify: JobNotifySchema,
  task: z.nullable(taskKey()),
  notice: z.enum(NOTICES),
  at: z.number().check(z.gte(0)),
  // Older agents omit `ended`. A finished job then takes its observation time; an open job has not ended.
  ended: z.exactOptional(z.nullable(z.number().check(z.gte(0)))),
  tail: z.string().check(z.maxLength(NOTICE_MAX)),
  position: z.nullable(z.int().check(z.gte(1))),
  reason: z.nullable(z.enum(REASONS)),
  error: z.nullable(z.literal("did_not_start")),
};

type EndedFrame = { ended?: number | null; outcome: JobOutcome | null; at: number };

function deriveEnded<T extends EndedFrame>(job: T): Omit<T, "ended"> & { ended: number | null } {
  const ended = job.ended !== undefined ? job.ended : job.outcome === null ? null : job.at;
  return { ...job, ended };
}

// GET /v1/jobs: one row. Unknown fields (a command, a path) are dropped, not stored.
export const JobViewSchema = z.pipe(z.object(jobFields), z.transform(deriveEnded));
export type JobView = z.output<typeof JobViewSchema>;

// The event the node sends and /v1/events publishes. `t` is "job" (design §4).
export const EvJob = z.pipe(z.object({ v: z.literal(1), t: z.literal("job"), ...jobFields }), z.transform(deriveEnded));
export type EvJob = z.output<typeof EvJob>;

export const JobsListSchema = z.object({ jobs: z.array(JobViewSchema), stale: z.boolean() });
export type JobsList = z.output<typeof JobsListSchema>;

// The hub's feed (design §7): the list and the counts beside each node. The tail stays on the fleet.
export const JobCountSchema = z.object({ node: z.string(), running: z.number(), queued: z.number(), failed: z.number() });
export const JobsFrameSchema = z.object({
  t: z.literal("jobs"),
  jobs: z.array(z.unknown()),
  counts: z.array(JobCountSchema),
  more: z.number(),
  stale: z.boolean(),
  at: z.number(),
});

export const JobsQuerySchema = z.object({
  node: z.exactOptional(nodeName()),
  lane: z.exactOptional(lane()),
  state: z.exactOptional(z.enum(STATES)),
});
export type JobsQuery = z.output<typeof JobsQuerySchema>;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const check = <T extends true>(t: T) => t;
check<Same<EvJob, FleetJob>>(true);
