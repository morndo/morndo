// The fleet client as the updates service's port (updates §8.1, PR 6c): the Rollout and the nodes for the view,
// the two principal's writes with the signed assertion riding x-morndo-principal (§5.4). A fleet that can't be
// asked is `unavailable` with its own words; a refusal is the fleet's code and words, passed on as they are — the
// owner reads what the fleet said, not the hub's paraphrase of it.
import { FleetClient, FleetOpFailed } from "@morndo/fleet-client";
import type { FleetForUpdates, FleetWriteOutcome } from "../application/updates-ports.ts";

const unavailable = (e: unknown): { ok: false; problem: "unavailable"; message: string } =>
  ({ ok: false, problem: "unavailable", message: e instanceof Error ? e.message : String(e) });

// update.apply answers in the op's envelope: { ok: false, error } is the fleet's refusal (not_allowed, unknown_op),
// never a throw — turned into the write outcome here, with the fleet's own code and words.
async function write(p: Promise<unknown>): Promise<FleetWriteOutcome> {
  try {
    const v = await p;
    if (v && typeof v === "object" && "ok" in v && v.ok === true) return { ok: true };
    const error = v && typeof v === "object" && "error" in v && v.error && typeof v.error === "object" && "code" in v.error
      ? v.error as { code: string; message: unknown } : null;
    if (error && typeof error.message === "string") return { ok: false, problem: "refused", code: error.code, message: error.message };
    return { ok: false, problem: "unavailable", message: "the fleet answered in a shape this hub doesn't know" };
  } catch (e) {
    if (e instanceof FleetOpFailed) return { ok: false, problem: "refused", code: e.error.code, message: e.error.message };
    return unavailable(e);
  }
}

export function fleetForUpdates(client: FleetClient): FleetForUpdates {
  return {
    async rollout() {
      try {
        const r = await client.rollout();
        return { ok: true, rollout: r.rollout, aboveControlPlane: r.aboveControlPlane };
      } catch (e) { return unavailable(e); }
    },
    async nodes() {
      try { return { ok: true, nodes: await client.nodes() }; }
      catch (e) { return unavailable(e); }
    },
    applyUpdate: (node, version, principal) =>
      write(client.op({ node }, "update.apply", { version }, { principal })),
    resumeRollout: (version, principal) =>
      write(client.resumeRollout(version, { principal })),
  };
}
