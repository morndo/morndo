// The hub's sign-in fleet adapter (ADR-0039): the fleet takes an op key only as "<client>:<…>" (op-body.ts), so the
// service's sign-in id goes out under the hub's own client name, and signin.start and signin.code ride the hub's proof.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodePrincipalHeader, parsePrincipalAssertion } from "@morndo/protocol";
import type { FleetClient } from "@morndo/fleet-client";
import { loadOrCreateIdentity } from "../src/adapters/identity.ts";
import { principalSigner } from "../src/adapters/principal-signer.ts";
import { signinFleet } from "../src/adapters/fleet-adapters.ts";

describe("the sign-in fleet adapter", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("keys signin.start, signs start and code for that node and id, and sends no principal for the other ops", async () => {
    dir = mkdtempSync(join(tmpdir(), "signin-adapter-"));
    const sign = principalSigner(loadOrCreateIdentity(dir));
    const sent: { node: string; op: string; key?: string; timeoutMs?: number; principal?: string }[] = [];
    const client = {
      nodes: async () => [{ name: "n1", status: "online" }, { name: "n2", status: "offline" }],
      op: async (target: { node: string }, op: string, _args: unknown, opts: { key?: string; timeoutMs?: number; principal?: string }) => {
        sent.push({ node: target.node, op, ...opts });
        return { ok: true, result: {} };
      },
    } as unknown as FleetClient;
    const fleet = signinFleet(client, sign);
    expect(await fleet.nodes()).toEqual(["n1"]);
    await fleet.op("n1", "signin.start", { id: "si-t1", runtime: "claude", account: "a1", create: false }, { key: "si-t1" });
    await fleet.op("n1", "signin.code", { id: "si-t1", sealed: "YWdl" });
    await fleet.op("n1", "signin.status", { id: "si-t1" });
    await fleet.op("n1", "signin.accounts", { runtime: "claude" });
    await fleet.op("n1", "signin.cancel", { id: "si-t1" });
    expect(sent.map(s => ({ node: s.node, op: s.op, key: s.key, timeoutMs: s.timeoutMs, hasPrincipal: s.principal !== undefined }))).toEqual([
      { node: "n1", op: "signin.start", key: "hub:signin:si-t1", timeoutMs: 45_000, hasPrincipal: true },
      { node: "n1", op: "signin.code", timeoutMs: 15_000, hasPrincipal: true },
      { node: "n1", op: "signin.status", timeoutMs: 15_000, hasPrincipal: false },
      { node: "n1", op: "signin.accounts", timeoutMs: 15_000, hasPrincipal: false },
      { node: "n1", op: "signin.cancel", timeoutMs: 15_000, hasPrincipal: false },
    ]);
    for (const op of ["signin.start", "signin.code"] as const) {
      const header = sent.find(s => s.op === op)?.principal;
      expect(header).toBeTypeOf("string");
      const decoded = decodePrincipalHeader(header!);
      expect(decoded).not.toBeNull();
      const assertion = parsePrincipalAssertion(new TextDecoder().decode(decoded!.payload));
      expect(assertion).toMatchObject({ op, node: "n1", signin: "si-t1" });
    }
  });

  it("turns a fleet throw into node_offline for op and an empty node list for nodes", async () => {
    const client = {
      nodes: async () => { throw new Error("socket gone"); },
      op: async () => { throw new Error("socket gone"); },
    } as unknown as FleetClient;
    const fleet = signinFleet(client, () => "unused");
    expect(await fleet.nodes()).toEqual([]);
    expect(await fleet.op("n1", "signin.accounts", { runtime: "claude" })).toEqual({
      ok: false, error: { code: "node_offline", executed: "no", message: "fleet unreachable" },
    });
  });
});
