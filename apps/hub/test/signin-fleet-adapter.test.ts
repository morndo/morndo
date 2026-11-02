// The hub's sign-in fleet adapter (ADR-0039): the fleet takes an op key only as "<client>:<…>" (op-body.ts), so the
// service's sign-in id goes out under the hub's own client name.
import { describe, expect, it } from "vitest";
import type { FleetClient } from "@morndo/fleet-client";
import { signinFleet } from "../src/adapters/fleet-adapters.ts";

describe("the sign-in fleet adapter", () => {
  it("keys signin.start as hub:signin:<id>, sends no key when the service gives none, and lists online nodes only", async () => {
    const sent: { node: string; op: string; key?: string; timeoutMs?: number }[] = [];
    const client = {
      nodes: async () => [{ name: "n1", status: "online" }, { name: "n2", status: "offline" }],
      op: async (target: { node: string }, op: string, _args: unknown, opts: { key?: string; timeoutMs?: number }) => {
        sent.push({ node: target.node, op, ...opts });
        return { ok: true, result: {} };
      },
    } as unknown as FleetClient;
    const fleet = signinFleet(client);
    expect(await fleet.nodes()).toEqual(["n1"]);
    await fleet.op("n1", "signin.start", { id: "si-t1", runtime: "claude", account: "a1", create: false }, { key: "si-t1" });
    await fleet.op("n1", "signin.code", { id: "si-t1", sealed: "YWdl" });
    expect(sent).toEqual([
      { node: "n1", op: "signin.start", key: "hub:signin:si-t1", timeoutMs: 45_000 },
      { node: "n1", op: "signin.code", timeoutMs: 15_000 },
    ]);
  });

  it("turns a fleet throw into node_offline for op and an empty node list for nodes", async () => {
    const client = {
      nodes: async () => { throw new Error("socket gone"); },
      op: async () => { throw new Error("socket gone"); },
    } as unknown as FleetClient;
    const fleet = signinFleet(client);
    expect(await fleet.nodes()).toEqual([]);
    expect(await fleet.op("n1", "signin.accounts", { runtime: "claude" })).toEqual({
      ok: false, error: { code: "node_offline", executed: "no", message: "fleet unreachable" },
    });
  });
});
