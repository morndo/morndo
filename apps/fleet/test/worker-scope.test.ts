// The worker socket's policy on its own (T-440): pure, so a closed-by-default rule can be pinned without a fleet.
import { OP_NAMES, type OpName } from "@morndo/protocol";
import { describe, expect, it } from "vitest";
import { workerOpVerdict, type WorkerLook, type WorkerScope } from "../src/application/worker-scope.ts";

const scope: WorkerScope = { protectedLanes: new Set(["manager"]), startNodes: new Set(["pc"]) };
const names = new Map([["pc.3fa2c1d0.0", "pc-lane"], ["ctl.3fa2c1d0.0", "manager"], ["ctl.3fa2c1d0.1", "worker-a"]]);
const look: WorkerLook = {
  nameOfWorker: id => names.get(id) ?? null,
  nodeOfLane: name => (name === "pc-lane" ? "pc" : name === "manager" || name === "worker-a" ? "ctl" : null),
};

describe("worker socket policy", () => {
  it("an op the policy does not list is refused, whatever its target and arguments", () => {
    const v = workerOpVerdict(scope, { target: { node: "pc" }, op: "future.op" as OpName, args: {} }, look);
    expect(v).toMatchObject({ ok: false, reason: expect.stringContaining("worker socket") });
  });

  it("the ops closed to the worker socket are refused on a startNode too", () => {
    const closed: OpName[] = ["job.notice", "job.noticeResult", "memory.sync", "connections.priority", "connections.role", "connections.revoke", "connections.narrow", "update.apply", "lane.deliver", "delivery.cancel",
      "transcript.size", "transcript.read", "transcript.locate"];
    for (const op of closed) expect(workerOpVerdict(scope, { target: { node: "pc" }, op, args: {} }, look), op).toMatchObject({ ok: false });
  });

  it("every op the protocol has is decided: either allowed with a node or lane that fits, or refused", () => {
    for (const op of OP_NAMES) {
      const v = workerOpVerdict(scope, { target: { node: "ctl" }, op, args: {} }, look);
      expect(typeof v.ok, op).toBe("boolean");
    }
  });
});
