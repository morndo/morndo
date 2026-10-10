// Fleet ops on this node's jobs. job.notice stores one delivery under the notice id the fleet names.
// The text is this node's; the fleet does not keep it (ADR-0014).
import type { OpTable } from "./executor.ts";
import { effect, fail, ok } from "./executor.ts";

export type JobControl = {
  notice(id: string, lane: string, text: string): Promise<{ ok: true; typed: boolean } | { ok: false; error: "id_conflict" }>;
  // The lane the hub bound to this token. A mismatch is not_yours and does not touch the cache.
  laneOf(token: string): string | null;
  lane(id: string): string | null;
  cancel(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  mark?(id: string, notice: "commented" | "given_up"): void;
};

export function jobOps(c: JobControl): Pick<OpTable, "job.notice" | "job.cancel" | "job.noticeResult"> {
  return {
    "job.notice": effect(a => `notice:${a.id}`, async (a, ctx) => {
      const blocked = ctx.ready();
      if (blocked) return fail(blocked.code, blocked.message);
      const decided = await c.notice(a.id, a.lane, a.text);
      if (!decided.ok) return fail("denied", "id_conflict");
      // Stored but not typed: the fleet releases its claim and tries again. executed "no", so this key is not kept.
      if (!decided.typed) return fail("busy", "not_typed");
      return ok<"job.notice">({ ok: true });
    }),
    "job.cancel": effect(a => `job:${a.id}`, async (a, ctx) => {
      const blocked = ctx.ready();
      if (blocked) return fail(blocked.code, blocked.message);
      const owned = c.lane(a.id);
      if (owned === null) return fail("denied", "missing");
      const lane = c.laneOf(a.token);
      if (lane === null || lane !== owned) return fail("denied", "not_yours");
      const decided = await c.cancel(a.id);
      if (decided.ok) return ok<"job.cancel">({ ok: true });
      // Nothing was signalled: the caller may retry. A signal that did go out is not safe to treat as if it had not.
      if (decided.error === "unavailable") return fail("busy", "unavailable");
      if (decided.error === "signalled") return { ok: false, error: { code: "uncertain", executed: "maybe", message: "signalled" } };
      return fail("denied", decided.error);
    }),
    "job.noticeResult": effect(a => `job-notice:${a.id}:${a.notice}`, async (a, ctx) => {
      const blocked = ctx.ready();
      if (blocked) return fail(blocked.code, blocked.message);
      c.mark?.(a.id, a.notice);
      return ok<"job.noticeResult">({ ok: true });
    }),
  };
}
