// When signin.start may have reached the node but the hub sees a failure, it best-effort cancels that id (ADR-0039).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Endpoint, EndpointId, Session, SessionId } from "@morndo/domain";
import { FleetClient } from "@morndo/fleet-client";
import { loadOrCreateIdentity } from "../src/adapters/identity.ts";
import { signinFleet } from "../src/adapters/fleet-adapters.ts";
import { principalSigner } from "../src/adapters/principal-signer.ts";
import { SignInService } from "../src/application/signin-service.ts";
import { localNode, memoryBackend, startFakeFleet, type FakeFleet } from "./helpers/fake-fleet.ts";

const NOW = 1_800_000_000_000;
const session = (verifiedAt: number): Session => ({
  id: "s" as SessionId, endpointId: "e" as EndpointId, startedAt: NOW, lastSeenAt: NOW, verifiedAt, endedAt: null, endReason: null,
});
const who = { session: session(NOW - 60_000), endpoint: { id: "e" as EndpointId } as Endpoint };

describe("sign-in start failures that may have run on the node", () => {
  let fleet: FakeFleet;
  let dir: string;
  afterEach(async () => { await fleet?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("sends a best-effort signin.cancel for the same id and does not keep a hub copy", async () => {
    dir = mkdtempSync(join(tmpdir(), "signin-orphan-"));
    fleet = await startFakeFleet({ nodes: [localNode("n1", "tmux", memoryBackend({}))] });
    const cancels: { id: string }[] = [];
    fleet.intercept("signin.start", async () => ({
      ok: false, error: { code: "uncertain", executed: "maybe", message: "may have started" },
    }));
    fleet.intercept("signin.cancel", async (call, next) => {
      cancels.push(call.args as { id: string });
      return next();
    });
    const identity = loadOrCreateIdentity(dir);
    const service = new SignInService({
      fleet: signinFleet(new FleetClient(fleet.socketPath), principalSigner(identity)),
      now: () => NOW,
      audit: () => {},
      newId: () => "si-orphan1",
    });
    expect(await service.start(who, { node: "n1", runtime: "claude", account: "a1", create: false })).toEqual({ ok: false, problem: "uncertain" });
    await new Promise(r => setTimeout(r, 50));
    expect(cancels).toEqual([{ id: "si-orphan1" }]);
    expect(await service.view("si-orphan1")).toEqual({ ok: false, problem: "not_found" });
  });
});
