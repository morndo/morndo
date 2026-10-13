// An in-place restore (cp over the file: same inode, store kept) that spools hook events before the first welcome
// must not have those events acked away by restored(); they replay under the new rotated stream.
// Pared-down form of the validator repro; uses the agent harness exactly as agent.test.ts does.
import { execFileSync } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/config.ts";
import { startFakeFleet, type FakeFleet, type Msg } from "./fake-fleet.ts";
import { joinedConfig, runAgent } from "./agent-harness.ts";
import { isolatedTmux, tempHome, until, wait, type TestTmux } from "./helpers.ts";

let fleet: FakeFleet; let home: { home: string; cleanup: () => void }; let t: TestTmux; let config: AgentConfig;
const stops: (() => Promise<void>)[] = [];
beforeEach(async () => {
  fleet = await startFakeFleet({ welcome: { connEpoch: 1, ackSeq: 0, streamKnown: true } });
  home = tempHome(); t = isolatedTmux(); config = await joinedConfig(home.home, fleet, t.socket);
});
afterEach(async () => { for (const s of stops.splice(0)) await s(); await fleet.close(); await t.kill(); home.cleanup(); });
type Hook = { streamId: string; seq: number; body: { n?: string } };
const hooks = (from = 0): Hook[] => fleet.received.slice(from).filter(r => r.msg.t === "ev.hook").map(r => (r.msg as Msg & { event: Hook }).event);

describe("in-place restore: events queued before the welcome survive", () => {
  it("delivers new-1 and new-2 under the rotated stream", async () => {
    let cut = fleet.received.length;
    const a = await runAgent(config);
    await fleet.waitFor(m => m.t === "ev.inventory", 5000, cut);
    const store = a.agent.streamId;
    for (let i = 1; i <= 5; i++) expect((await a.post("/hook/stop", { n: `orig-${i}` })).status).toBe(200);
    expect(await until(() => hooks(cut).length === 5)).toBe(true);
    fleet.send({ t: "ack", streamId: store, seq: 5 });
    expect(await until(() => a.agent.spool.depth() === 0)).toBe(true);
    await a.agent.stop();
    const backup = join(home.home, "agent.db.copy");
    execFileSync("cp", [config.dbPath, backup]);
    const inode = statSync(config.dbPath).ino;
    fleet.script.streams = { [store]: 5 };
    cut = fleet.received.length;
    const b = await runAgent(config);
    await fleet.waitFor(m => m.t === "ev.inventory", 5000, cut);
    for (let i = 6; i <= 10; i++) expect((await b.post("/hook/stop", { n: `orig-${i}` })).status).toBe(200);
    expect(await until(() => hooks(cut).length === 5)).toBe(true);
    fleet.send({ t: "ack", streamId: store, seq: 10 });
    expect(await until(() => b.agent.spool.depth() === 0)).toBe(true);
    await b.agent.stop();
    execFileSync("cp", [backup, config.dbPath]);
    for (const f of [`${config.dbPath}-wal`, `${config.dbPath}-shm`]) rmSync(f, { force: true });
    expect(statSync(config.dbPath).ino).toBe(inode);
    fleet.script.streams = { [store]: 10 };
    fleet.script.hello = 1011;                                    // fleet turns hellos away while the restore reconnects
    const before = fleet.connections();
    cut = fleet.received.length;
    const c = await runAgent(config);
    stops.push(() => c.agent.stop());
    expect(await until(() => fleet.connections() > before)).toBe(true);
    expect(c.agent.streamId).toBe(store);
    for (const n of ["new-1", "new-2"]) expect((await c.post("/hook/stop", { n })).status).toBe(200);
    fleet.script.hello = "challenge";
    await fleet.waitFor(m => m.t === "ev.inventory", 10_000, cut);
    await wait(500);
    expect((await c.post("/hook/stop", { n: "new-3" })).status).toBe(200);
    expect(await until(() => hooks(cut).some(e => e.body.n === "new-3"))).toBe(true);
    const delivered = hooks(cut).map(e => e.body.n);
    expect(delivered).toContain("new-1");
    expect(delivered).toContain("new-2");
    expect(c.agent.streamId).not.toBe(store);
  });
});
