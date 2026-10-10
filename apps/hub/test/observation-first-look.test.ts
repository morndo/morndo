// Whether a poll was a complete look (review L4; docs/domain.md N2): main.ts takes the notification baseline from the
// first complete look only. Fleet mode, against the fake fleet: a look the fleet didn't answer, or one whose node round
// outlasted nodeWaitMs, is not complete; the next poll, with the late round applied, is.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FleetClient } from "../src/adapters/fleet-client.ts";
import { fleetPorts } from "../src/adapters/fleet-adapters.ts";
import { ObservationService } from "../src/application/observation-service.ts";
import { localNode, memoryBackend, startFakeFleet, type FakeFleet } from "./helpers/fake-fleet.ts";

const MENU = "work…\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel\n\n";
let dir: string;
let fleet: FakeFleet | null = null;
let stop = () => {};
afterEach(async () => { stop(); await fleet?.close(); fleet = null; rmSync(dir, { recursive: true, force: true }); });

async function setup(o: { fleetUp: boolean }) {
  dir = mkdtempSync(join(tmpdir(), "morndo-first-look-"));
  const sock = join(dir, "fleet.sock");
  const node = () => localNode("pc", "aaaaaaaa", memoryBackend({ "%1": { name: "builder", cwd: "/w/b", screen: MENU } }));
  if (o.fleetUp) fleet = await startFakeFleet({ nodes: [node()], socketPath: sock });
  const ports = fleetPorts(new FleetClient(sock), { files: null, stagingDir: join(dir, "staging") });
  await ports.start();
  stop = () => ports.stop();
  const obs = new ObservationService(ports.tmux, 15_000, Date.now, { sessions: ports.sessions, transcripts: ports.transcripts, nodeStates: ports.nodeStates, nodeWaitMs: 300 });
  return { obs, sock, node };
}

it("a look the fleet didn't answer is not complete; once it answers, the look is", async () => {
  const { obs, sock, node } = await setup({ fleetUp: false });
  expect(await obs.poll()).toEqual({ complete: false });
  fleet = await startFakeFleet({ nodes: [node()], socketPath: sock });
  expect(await obs.poll()).toEqual({ complete: true });
  expect(obs.screen("pc.aaaaaaaa.1")).toBe(MENU);
});

it("a look whose node round outlasted nodeWaitMs is not complete; the next one, with that round applied, is", async () => {
  const { obs } = await setup({ fleetUp: true });
  fleet?.intercept("pane.captureMany", async (_call, next) => { await new Promise(r => setTimeout(r, 600)); return next(); });
  expect(await obs.poll()).toEqual({ complete: false });
  expect(obs.screen("pc.aaaaaaaa.1")).toBeUndefined();
  fleet?.intercept("pane.captureMany", null);
  await new Promise(r => setTimeout(r, 700));
  expect(await obs.poll()).toEqual({ complete: true });
  expect(obs.screen("pc.aaaaaaaa.1")).toBe(MENU);
});
