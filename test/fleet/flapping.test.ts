// Flapping (spec §9 "Flapping", §5.2 "Instances", §7 "Two agent instances with one key"). A second agent process with
// the same key stands next to the first, as on a cloned machine: config and key copied, its own relay port. It runs for
// FLEET_FLAP_MS: 75 s by default, which covers the agent's whole backoff ladder up to its 60 s cap. CI's fleet job sets
// the spec's 5 minutes.
// Exactly one instance stays connected: the node never leaves "online". The twin's hello makes the fleet ping the live
// instance (the instance check, 3 s, Task 11); it answers, so the twin is refused with 4409. The twin keeps
// `status: conflict` and tries again every 5 minutes (Task 7), so the CI soak (5 minutes) may see one retry; the fleet
// raises one instance_conflict alert per refused instance for as long as the live connection lasts, so retries add none.
// Ops on the connected instance never fail.
// Real processes throughout; no hook.
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_MAIN, cleanEnv, fakeLane, joinAgent, paneOf, sleep, startFleet, statuses, stopAll, tmuxServer } from "../fleet-harness.ts";

afterEach(stopAll);
const FLAP_MS = Number(process.env.FLEET_FLAP_MS ?? 75_000);

describe("two instances with one key", () => {
  it(`for ${FLAP_MS / 1000} s: one connected, one alert, no failed op`, async () => {
    const fleet = await startFleet();
    const tmux = tmuxServer();
    const first = await joinAgent(fleet, "n1", { tmux });
    await fakeLane(tmux, { window: "box" });
    await first.run();
    await first.waitOnline();
    const id = (await paneOf(fleet.client, "n1", "box")).workerId;
    const flips = await statuses(fleet, "n1");                              // the replay of "online" is not a flip
    const twin = await first.clone();
    await twin.run();
    const failures: string[] = [];
    let ops = 0;
    const end = performance.now() + FLAP_MS;
    while (performance.now() < end) {
      const r = await fleet.client.op({ node: "n1" }, "pane.captureMany", { workerIds: [id] });
      ops++;
      if (!r.ok) failures.push(r.error.code);
      await sleep(2000);
    }
    const conflicts = (await fleet.client.alerts()).filter(a => a.kind === "instance_conflict" && a.node === "n1");
    expect(conflicts).toHaveLength(1);
    // The status CLI only reads the twin's status file: nothing in this process needs to answer it.
    const twinStatus = spawnSync(process.execPath, ["--no-warnings", AGENT_MAIN, "status"], { env: cleanEnv(twin.home), encoding: "utf8" }).stdout;
    expect(twinStatus).toMatch(/conflict: another agent with this node's key is connected \(4409\)/);
    expect(flips.filter(s => s !== "online")).toEqual([]);                    // never stale or offline: only "online" may follow
    expect(failures).toEqual([]);
    expect(ops).toBeGreaterThanOrEqual(Math.floor(FLAP_MS / 2500));
    expect((await fleet.client.nodes()).find(n => n.name === "n1")?.status).toBe("online");
  }, FLAP_MS + 60_000);
});
