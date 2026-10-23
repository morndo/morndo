// The hub's fleet port for updates (updates design §5.4, §8.1), against the real fleet: the hub's own adapter
// (apps/hub/src/adapters/fleet-updates.ts), its signer and its identity, the real FleetClient, and a fleet that reads the
// hub's key from identity.pub as an installed one does. The hub's own tests stand on a fake fleet; the two-machine run
// (6d) found what that fake hid: update.apply went without the key the fleet requires of it, and a resume the fleet took
// came back as "a shape this hub doesn't know".
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fleetForUpdates } from "../../apps/hub/src/adapters/fleet-updates.ts";
import { loadOrCreateIdentity, writeIdentityPub } from "../../apps/hub/src/adapters/identity.ts";
import { principalSigner } from "../../apps/hub/src/adapters/principal-signer.ts";
import { productVersion } from "../../packages/service-kit/src/index.ts";
import { startFleet, stopAll, tempDir, until } from "../fleet-harness.ts";

afterEach(stopAll);

// A fleet that trusts this hub's key the way an installed one does: identity.pub in the hub's data directory.
async function fleetTrustingAHub() {
  const fleet = await startFleet();
  const identity = loadOrCreateIdentity(tempDir("morndo-hub-id-"));
  const dataDir = join(fleet.home, ".local/share/morndo");
  mkdirSync(dataDir, { recursive: true });
  writeIdentityPub(dataDir, identity.publicKeyRaw);
  return { fleet, sign: principalSigner(identity), port: fleetForUpdates(fleet.client) };
}

describe("the hub's fleet port for updates, against the real fleet", () => {
  it("update.apply carries the key the fleet requires: never 'needs a key'", async () => {
    const { sign, port } = await fleetTrustingAHub();
    const r = await port.applyUpdate("n2", "99.0.0", sign({ op: "update.apply", version: "99.0.0", node: "n2" }));
    // n2 never joined, so the fleet refuses — but for that, not for a missing key (bad_args, "needs a key")
    expect(JSON.stringify(r)).not.toContain("needs a key");
    expect(r).not.toMatchObject({ problem: "refused", code: "bad_args" });
  }, 60_000);

  it("a resume the fleet takes answers ok; one it refuses answers the fleet's own refusal", async () => {
    const { fleet, sign, port } = await fleetTrustingAHub();
    // A halted Rollout of 99.0.0, made the way the control plane's own rollback makes one: its updater's state file
    // announces the attempt (`applying`), then reports the rollback under it.
    const statePath = join(fleet.home, ".local/state/morndo-update/state.json");
    mkdirSync(join(fleet.home, ".local/state/morndo-update"), { recursive: true });
    const write = (o: Record<string, unknown>) =>
      writeFileSync(statePath, JSON.stringify({ version: productVersion(), target: "99.0.0", attempt: "Q1w2E3r4T5y6U7i8O9p0Aa", ...o }));
    write({ state: "applying", at: 1 });
    await new Promise(r => setTimeout(r, 1500));          // read once a second
    write({ state: "rolled_back", failedCheck: "fleet health", reason: "fleet health", at: 2 });
    await until("the halted Rollout of 99.0.0", async () =>
      (await fleet.client.rollout()).aboveControlPlane.some(r => r.version === "99.0.0" && r.halted), 10_000);

    expect(await port.resumeRollout("99.0.0", sign({ op: "rollout.resume", version: "99.0.0" }))).toEqual({ ok: true });
    // aboveControlPlane lists the halted Rollouts above the control plane: resumed, 99.0.0 leaves it
    expect((await fleet.client.rollout()).aboveControlPlane.find(r => r.version === "99.0.0")).toBeUndefined();
    // Now not halted: the fleet refuses a second resume, and the port says so in the fleet's own words.
    const again = await port.resumeRollout("99.0.0", sign({ op: "rollout.resume", version: "99.0.0" }));
    expect(again).toMatchObject({ ok: false, problem: "refused" });
  }, 60_000);
});
