// An upload whose link failed part-way is retried after the node dropped its partial (10 minutes, spec §5.3): the
// retry starts the image again instead of being refused for good. Real fleet and agent processes.
import { mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { FleetClient } from "../../apps/hub/src/adapters/fleet-client.ts";
import { fleetPorts } from "../../apps/hub/src/adapters/fleet-adapters.ts";
import { LIMITS } from "../../packages/protocol/src/fleet.ts";
import { fakeLane, joinAgent, paneOf, startFleet, stopAll, tmuxServer } from "../fleet-harness.ts";

afterAll(stopAll);

describe("a retried upload", () => {
  it("finishes after the node dropped its partial; the bytes in the inbox are the image's (a stored path is kept for a finished one)", async () => {
    const fleet = await startFleet();
    const tmux = tmuxServer();
    const agent = await joinAgent(fleet, "pc", { tmux });
    await fakeLane(tmux, { window: "box", prose: "box", claudeHome: agent.home });
    await agent.run();
    await agent.waitOnline();
    const pane = await paneOf(fleet.client, "pc", "box");
    const client = new FleetClient(fleet.config.socketPath);
    const dir = mkdtempSync(join(tmpdir(), "upload-retry-"));
    const ports = fleetPorts(client, { files: null, stagingDir: join(dir, "staging") });
    const image = randomBytes(3 * LIMITS.chunkBytes - 1000);
    const file = join(dir, "photo.png");
    writeFileSync(file, image);
    const upload = { id: "up0000000000000000000001", endpointId: "e1" as never, path: file, mime: "image/png" as const, size: image.length, at: Date.now() };
    let down = true;
    const real = client.op.bind(client);
    (client as unknown as { op: unknown }).op = (...a: unknown[]) => {
      const args = a[2] as { offset?: number } | undefined;
      return down && (args?.offset ?? 0) >= 2 * LIMITS.chunkBytes ? Promise.reject(new Error("link down")) : (real as (...x: unknown[]) => unknown)(...a);
    };
    expect(await ports.uploads.stage(upload, pane.workerId)).toEqual({ ok: false, problem: "node_offline" });
    const partial = join(agent.home, ".local/state/morndo-node/inbox/.partial", upload.id);
    const old = (Date.now() - 11 * 60_000) / 1000;
    utimesSync(partial, old, old);
    down = false;
    const retry = await ports.uploads.stage(upload, pane.workerId);
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(readFileSync(retry.path).equals(image)).toBe(true);
    expect(await ports.uploads.stage(upload, pane.workerId)).toEqual(retry);        // the finished upload answers from its stored keys
  }, 90_000);
});
