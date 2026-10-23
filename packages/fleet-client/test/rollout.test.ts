// The fleet client's rollout routes (updates design §4.5, §7): rollout() and the three writes, each against the route
// it belongs to, with the answer checked for shape as every read is; and the guard that the client's alert kinds are
// exactly the protocol's, so a kind one of them adds and the other misses fails here, not in a lane that never hears
// an alert. A plain HTTP server on a Unix socket stands in for the fleet: these tests check the client's requests,
// not the fleet's behaviour (apps/fleet/test/rollout.test.ts covers that).
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALERT_KINDS as PROTOCOL_KINDS, type RolloutWire } from "@morndo/protocol";
import { ALERT_KINDS, FleetClient, FleetMismatch } from "../src/fleet-client.ts";

type Seen = { method: string; path: string; body: unknown };
const rollout: RolloutWire = {
  version: "0.4.2", controlPlaneCommittedAt: 1_791_000_000_000, soakMinutes: 30, halted: true, haltedBy: "pc",
  haltReason: "a check failed after the swap", haltedAt: 1_791_000_000_500,
};

let dir: string;
let server: Server;
let seen: Seen[] = [];
let heads: Record<string, unknown>[] = [];
let answer: unknown = {};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-rollout-"));
  seen = [];
  heads = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", path: req.url ?? "", body: raw === "" ? null : JSON.parse(raw) });
      heads.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>(resolve => server.listen(join(dir, "f.sock"), resolve));
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("the fleet client's rollout routes", () => {
  it("its alert kinds are exactly the protocol's", () => {
    expect([...ALERT_KINDS].sort()).toEqual([...PROTOCOL_KINDS].sort());
  });

  it("rollout() reads GET /v1/rollout and checks its shape", async () => {
    answer = { controlPlane: { version: "0.4.2", commit: null }, rollout };
    const c = new FleetClient(join(dir, "f.sock"));
    expect(await c.rollout()).toEqual({ controlPlane: { version: "0.4.2", commit: null }, rollout, aboveControlPlane: [] });
    expect(seen).toEqual([{ method: "GET", path: "/v1/rollout", body: null }]);
    const above = { ...rollout, version: "0.5.0", halted: true, haltedBy: "cp", haltReason: "fleet health failed", haltedAt: 1 };
    answer = { controlPlane: { version: "0.4.2", commit: null }, rollout, aboveControlPlane: [above] };
    expect((await c.rollout()).aboveControlPlane).toEqual([above]);
    answer = { controlPlane: { version: "0.4.2", commit: null }, rollout, aboveControlPlane: [{ ...above, version: "0.5.0+x" }] };
    await expect(c.rollout()).rejects.toBeInstanceOf(FleetMismatch);
    answer = { controlPlane: { version: "0.4.2", commit: null }, rollout: null };
    expect((await c.rollout()).rollout).toBeNull();
    answer = { controlPlane: { version: "0.4.2", commit: null }, rollout: { ...rollout, version: "0.4" } };
    await expect(c.rollout()).rejects.toBeInstanceOf(FleetMismatch);
  });

  it("the three writes each hit their route with their body, and return the Rollout", async () => {
    answer = { ok: true, rollout };
    const c = new FleetClient(join(dir, "f.sock"));
    expect(await c.rolloutCommitted("0.4.2")).toEqual(rollout);
    expect(await c.haltRollout("0.4.2", "pc", "a check failed after the swap")).toEqual(rollout);
    expect(await c.resumeRollout("0.4.2")).toEqual(rollout);
    answer = { ok: true, rollout: { ...rollout, soakMinutes: 45 } };
    expect(await c.rolloutCommitted("0.4.2", 45)).toEqual({ ...rollout, soakMinutes: 45 });
    expect(seen).toEqual([
      { method: "POST", path: "/v1/rollout/committed", body: { version: "0.4.2" } },
      { method: "POST", path: "/v1/rollout/halt", body: { version: "0.4.2", machine: "pc", reason: "a check failed after the swap" } },
      { method: "POST", path: "/v1/rollout/resume", body: { version: "0.4.2" } },
      { method: "POST", path: "/v1/rollout/committed", body: { version: "0.4.2", soakMinutes: 45 } },
    ]);
  });

  // The principal's proof rides the two writes the fleet takes only with it (updates §5.4): update.apply and resume.
  it("update.apply and resumeRollout carry x-morndo-principal when the caller gives one, and nothing when it doesn't", async () => {
    answer = { ok: true, result: { accepted: true }, invVersion: 1, store: "pc", storeSeq: 1 };
    const c = new FleetClient(join(dir, "f.sock"));
    await c.op({ node: "pc" }, "update.apply", { version: "0.4.2" }, { key: "hub:u-1", principal: "the-hubs-proof" });
    answer = { ok: true, rollout };
    await c.resumeRollout("0.4.2", { principal: "the-hubs-proof" });
    expect(heads.slice(-2).map(h => h["x-morndo-principal"])).toEqual(["the-hubs-proof", "the-hubs-proof"]);
    await c.resumeRollout("0.4.2");
    expect(heads.at(-1)).not.toHaveProperty("x-morndo-principal");
  });

  it("nodes() keeps each node's commit, protocol versions and its updater's last report (§7)", async () => {
    answer = [
      { name: "pc", status: "online", health: null, agent: "0.4.2", commit: "1f".repeat(20), proto: [1, 2], update: { state: "staged", version: "0.4.2", target: "0.5.0" } },
      { name: "mac", status: "offline", health: null, agent: null, commit: null, proto: null, update: null },
    ];
    const c = new FleetClient(join(dir, "f.sock"));
    expect(await c.nodes()).toEqual(answer);
    // a fleet from before the updates design says none of it: null everywhere, still a node list
    answer = [{ name: "pc", status: "online", health: null, agent: "0.4.2" }];
    expect(await c.nodes()).toEqual([{ name: "pc", status: "online", health: null, agent: "0.4.2", commit: null, proto: null, update: null }]);
    // a report this client cannot read reads as none, never as a guess
    answer = [{ name: "pc", status: "online", health: null, agent: null, commit: null, proto: null, update: { state: "quantum", version: "0.4.2" } }];
    expect((await c.nodes())[0]!.update).toBeNull();
  });
});
