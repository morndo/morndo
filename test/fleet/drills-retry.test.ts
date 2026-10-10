// Retry drills (spec §9 "Retry and duplicates"; §7 "Connection lost during pane.send", "Retry after a refusal before
// the paste"), end to end: the hub in fleet mode → the real fleet → a real agent, all child processes
// (test/fleet-harness.ts), with lanes that record every submit (test/fixtures/fake-claude-pane.ts).
// Real: processes, sockets, the agent's reconnect, its done keys in its own database, the hub's send records.
// Placed by a hook: the drop. The agent's test hook `dropAfterStarted` (MORNDO_NODE_TEST_HOOKS) terminates its fleet
// socket right after it commits an op's `started` row, and lets the paste run on. The agent then reconnects with its
// own backoff. A cut from outside can't reliably land between `started` and the paste.
// Negative controls (spec §9: "(b) and (c) without keys type twice"): the same drills with the agent's done keys off
// (`noDoneKeys`) must type twice. That shows it is the keys, not luck, that keep the drills to once.
// (b′) is (b) with the agent's database lost between the drop and the repeat: the node's new store has no key, so its
// `unknown` must not count (spec §3.1, §7). Its control keeps the store id across the loss (`fixedStreamId`), and the
// repeat types again: it is the store check, not luck, that keeps it in doubt.
// (b″) and (c″) put an older copy of agent.db back over the file in place (cp, its inode kept), the common restore: the
// file's identity and the store id survive it. There the agent's own rotation is held off (`fixedStreamId`, the store
// kept), so it is the hub's store-sequence comparison that keeps the repeat in doubt (final review I2); nothing keyed
// goes to the node between the restore and the repeat, which would bring a restored count level with what the hub saw.
// (b‴) is the same restore with the agent as shipped, and keyed sends to that node before the repeat, enough to take its
// count past the one the hub kept: the welcome says the fleet has seen more of that store (storeSeqSeen, kept in
// fleet.db), so the agent starts a new store before it runs anything, and the repeat reads `unknown` from another store.
// (b⁗) restarts the fleet while the copy is put back: the value is in fleet.db. (d) is the counterpart: a normal agent
// restart with its database intact keeps its store. Their controls are in scripts/negative-controls.ts.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestHooks } from "../../apps/node-agent/src/test-hooks.ts";
import { expectOf, fakeLane, joinAgent, paneOf, sleep, startFleet, startHub, statuses, stopAll, tmuxServer, until, type Lane } from "../fleet-harness.ts";

afterEach(stopAll);

const TAP = "[tap ny-1] ship (Ship it)";
const once = (xs: string[], x: string) => xs.filter(t => t === x).length;

// One node with two lanes, and the hub in fleet mode with a needs-you list holding one open tap decision.
async function office(hooks: TestHooks = {}) {
  const fleet = await startFleet();
  const tmux = tmuxServer();
  const agent = await joinAgent(fleet, "n1", { tmux });
  const box = await fakeLane(tmux, { window: "box", prose: "box on n1" });
  // The manager's pane has no session file. If it had one, the hub would read the tap back from its conversation and
  // count the ask as answered there (E8), and the retry would never be typed. These drills are about typing.
  const manager = await fakeLane(tmux, { window: "manager", prose: "manager on n1" });
  await agent.run(hooks);
  await agent.waitOnline();
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const hub = await startHub(fleet, { ledger: { needsYou: [{ id: "ny-1", kind: "tap", question: "Ship the drill build?",
    options: [{ key: "ship", label: "Ship it" }, { key: "hold", label: "Hold" }], deadline: tomorrow, ts: new Date().toISOString() }] } });
  const feed = await hub.feed();
  await until("box and manager on the hub", () => feed.names.has("box") && feed.names.has("manager"), 15_000);
  // Subscribed, its replay of n1's current status discarded, before anything is sent: the drop's flips are all seen.
  const flips = await statuses(fleet, "n1");
  const [boxPane, managerPane] = await Promise.all([paneOf(fleet.client, "n1", "box"), paneOf(fleet.client, "n1", "manager")]);
  return { fleet, agent, tmux, box, manager, hub, flips, id: boxPane.workerId, managerId: managerPane.workerId };
}
type Office = Awaited<ReturnType<typeof office>>;
// The drop shows in the fleet as offline, then online again once the agent has reconnected. `flips` holds only what
// happened after office() subscribed, so "online" at the end is the reconnect, never the subscription's replay.
const backAfterDrop = (flips: string[]) => until("n1 dropped and back", () => flips.includes("offline") && flips.at(-1) === "online", 20_000);
// Once the hub itself sends to n1 again: a fresh send to the manager pane is typed (a 409 node_offline before that typed
// nothing, so trying again is safe). After it, a repeat in doubt is judged by what the node says, not by its absence.
const hubReaches = (o: Office) =>
  until("the hub sending to n1 again", async () => (await o.hub.send(o.managerId, `probe ${randomUUID()}`)).status === 200, 15_000);
// n1's store and store sequence as its agent answers op.status now (read-only: it starts nothing, so it moves nothing on).
const storeOf = async (o: Office) => {
  const r = await o.fleet.client.op({ node: "n1" }, "op.status", { key: "hub:look" });
  if (!r.ok) throw new Error(`op.status on n1: ${r.error.code}`);
  return { store: r.store, storeSeq: r.storeSeq };
};

describe("retry drills through the hub, the fleet and an agent", () => {
  it("(b) a drop after the paste, then a repeat: op.status says done, the hub says duplicate, typed once", async () => {
    const rid = randomUUID();
    const o = await office({ dropAfterStarted: rid });
    const text = "drill b: drop after the paste";
    const first = await o.hub.send(o.id, text, rid);
    // The node's answer was "maybe" (the connection dropped after `started`): the hub keeps its started row and answers
    // 409 uncertain, so the app says "may have been sent" and offers Check again (final review I1; before, a 500 the app
    // showed as "Not sent"). A repeat still in doubt is 409 uncertain too.
    expect(first).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await until("the paste in box", () => o.box.submitted().includes(text));
    await backAfterDrop(o.flips);
    expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 200, body: { error: "duplicate", ok: true } });
    await sleep(1000);
    expect(once(o.box.submitted(), text)).toBe(1);
  });

  it("(b) negative control: without done keys, the repeat types it a second time", async () => {
    const rid = randomUUID();
    const o = await office({ dropAfterStarted: rid, noDoneKeys: true });
    const text = "drill b: no keys";
    const first = await o.hub.send(o.id, text, rid);
    expect(first).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await until("the paste in box", () => o.box.submitted().includes(text));
    await backAfterDrop(o.flips);
    expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 200, body: { ok: true } });
    await until("the second paste", () => once(o.box.submitted(), text) === 2);
  });

  it("(b′) a drop after the paste, then the agent's database is lost: the repeat stays in doubt (409 uncertain), typed once", async () => {
    const rid = randomUUID();
    const o = await office({ dropAfterStarted: rid });
    const text = "drill b': the node's store is new";
    expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await until("the paste in box", () => o.box.submitted().includes(text));
    await backAfterDrop(o.flips);
    await o.agent.resetDatabase();                          // a new database, so a new store that knows no key
    await hubReaches(o);                                    // so the 409 below is the store's doing, not an offline node
    for (let i = 0; i < 2; i++) {                           // the repeat, and a Check again after it
      expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 409, body: { error: "uncertain" } });
    }
    await sleep(1000);
    expect(once(o.box.submitted(), text)).toBe(1);
  });

  it("(b′) negative control: the database lost but its store id kept (fixedStreamId), the repeat types a second time", async () => {
    const rid = randomUUID();
    const store = randomUUID();
    const o = await office({ dropAfterStarted: rid, fixedStreamId: store });
    const text = "drill b': the store id kept";
    expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await until("the paste in box", () => o.box.submitted().includes(text));
    await backAfterDrop(o.flips);
    await o.agent.resetDatabase({ fixedStreamId: store });
    await hubReaches(o);
    expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 200, body: { ok: true } });
    await until("the second paste", () => once(o.box.submitted(), text) === 2);
  });

  it("(b″) a drop after the paste, then an older copy of agent.db put back in place (cp, the same store): the repeat stays in doubt, typed once", async () => {
    const rid = randomUUID();
    const hooks = { dropAfterStarted: rid, fixedStreamId: randomUUID() };   // the store kept: the hub's comparison alone
    const o = await office(hooks);
    const copy = await o.agent.copyDatabase(hooks);          // the backup
    await hubReaches(o);                                    // a send after the backup: the database moves on past it
    const flips = await statuses(o.fleet, "n1");
    const text = "drill b'': an older copy put back";
    expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await until("the paste in box", () => o.box.submitted().includes(text));
    await backAfterDrop(flips);
    const before = await storeOf(o);
    await o.agent.putBackDatabase(copy, hooks);              // the restore, in place
    const after = await storeOf(o);                          // the node answers again, and nothing keyed went to it
    expect(after.store).toBe(before.store);                  // the same store: the file's identity and ackSeq can't tell
    expect(after.storeSeq).not.toBeNull();
    expect(after.storeSeq ?? 0).toBeLessThan(before.storeSeq ?? 0);   // its sequence went back with it
    for (let i = 0; i < 2; i++) {                           // the repeat, and a Check again after it
      expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 409, body: { error: "uncertain" } });
    }
    await sleep(1000);
    expect(once(o.box.submitted(), text)).toBe(1);
  });

  // A drop after the paste, and the copy put back in place: shared by (b‴) and (b⁗).
  async function restoredAfterDrop(text: string, whileStopped?: (o: Office) => Promise<void>) {
    const rid = randomUUID();
    const hooks = { dropAfterStarted: rid };
    const o = await office(hooks);
    const copy = await o.agent.copyDatabase(hooks);
    await hubReaches(o);                                    // a send after the backup: the database moves on past it
    const flips = await statuses(o.fleet, "n1");
    expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await until("the paste in box", () => o.box.submitted().includes(text));
    await backAfterDrop(flips);
    const before = await storeOf(o);
    await o.agent.putBackDatabase(copy, hooks, whileStopped && (() => whileStopped(o)));
    return { o, rid, before };
  }
  // Keyed sends to n1 (the manager's pane), each typed: the node's count moves on by one each.
  const keyedSends = async (o: Office, n: number) => {
    await hubReaches(o);
    for (let i = 1; i < n; i++) expect((await o.hub.send(o.managerId, `probe ${randomUUID()}`)).status).toBe(200);
  };

  it("(b‴) an older copy put back in place, then keyed sends past the count the hub kept: the agent started a new store at connect, the repeat stays in doubt, typed once", async () => {
    const text = "drill b''': restored, then busy";
    const { o, rid, before } = await restoredAfterDrop(text);
    const after = await storeOf(o);
    await keyedSends(o, 4);
    const busy = await storeOf(o);
    expect(busy.storeSeq ?? 0).toBeGreaterThan(before.storeSeq ?? 0);   // its count is past anything the hub kept
    for (let i = 0; i < 2; i++) {                           // the repeat, and a Check again after it
      expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 409, body: { error: "uncertain" } });
    }
    await sleep(1000);
    expect(once(o.box.submitted(), text)).toBe(1);
    // Why: turned down at welcome, a new store before any op ran, kept since.
    expect(after.store).not.toBe(before.store);
    expect(busy.store).toBe(after.store);
    expect(readFileSync(join(o.agent.home, "agent.log"), "utf8").match(/Starting a new store/g)).toHaveLength(1);
  });

  it("(b⁗) the same with the fleet restarted while the copy is put back: what it had seen of the store is in fleet.db", async () => {
    const text = "drill b'''': restored across a fleet restart";
    const { o, rid, before } = await restoredAfterDrop(text, x => x.fleet.restart());
    const after = await storeOf(o);
    await keyedSends(o, 4);
    expect((await storeOf(o)).storeSeq ?? 0).toBeGreaterThan(before.storeSeq ?? 0);
    for (let i = 0; i < 2; i++) expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await sleep(1000);
    expect(once(o.box.submitted(), text)).toBe(1);
    expect(after.store).not.toBe(before.store);
  });

  // (e) A power loss on the node (fleet core §16.4). The agent's database no longer syncs each commit, so a power loss
  // may take back its last ones. Modelled as the copy taken before them put back in place, a send's synced `started`
  // taken back too (more than a power loss can do: a disk that lost what it said it wrote), with
  // the tmux server gone with the machine and the lane started again on a new one. A client retrying a send whose key
  // was taken back finds no pane (the old server's stamp); the send the hub holds in doubt stays uncertain; the store
  // turns over (the fleet had seen a higher store sequence); the new lane receives nothing.
  async function powerLoss(hooks: TestHooks) {
    const rid = randomUUID();
    const o = await office({ ...hooks, dropAfterStarted: rid });
    const copy = await o.agent.copyDatabase({ ...hooks, dropAfterStarted: rid });   // what the disk held; the commits after it, unsynced
    const box = await paneOf(o.fleet.client, "n1", "box");
    const key = `hub:pl-${randomUUID()}`;
    const send = { workerId: box.workerId, text: "drill e: answered", expect: expectOf(box) };
    expect(await o.fleet.client.op({ node: "n1" }, "pane.send", send, { key })).toMatchObject({ ok: true });
    const flips = await statuses(o.fleet, "n1");
    expect(await o.hub.send(o.id, "drill e: in doubt", rid)).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await until("the paste in box", () => o.box.submitted().includes("drill e: in doubt"));
    await backAfterDrop(flips);
    const before = await storeOf(o);
    let fresh: Lane | null = null;
    await o.agent.putBackDatabase(copy, { ...hooks, dropAfterStarted: rid }, async () => {
      o.tmux.kill();                                                                  // the machine went down: tmux with it
      fresh = await fakeLane(o.tmux, { window: "box", prose: "box after the power loss" });
    });
    const retried = await o.fleet.client.op({ node: "n1" }, "pane.send", send, { key });
    return { o, rid, before, retried, fresh: fresh as Lane | null };
  }

  it("(e) a power loss: the database back to before its last commits, tmux gone with it; the retry finds no pane, the doubt stays, the new lane receives nothing", async () => {
    const { o, rid, before, retried, fresh } = await powerLoss({});
    expect(retried).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
    expect((await storeOf(o)).store).not.toBe(before.store);
    expect(await o.hub.send(o.id, "drill e: in doubt", rid)).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await sleep(1000);
    expect(fresh?.submitted()).toEqual([]);
  });

  it("(e) negative control: without the expectation check (noExpect), the retried send types into the new lane", async () => {
    const { retried, fresh } = await powerLoss({ noExpect: true });
    expect(retried.ok).toBe(true);
    await until("the text in the new box", () => fresh?.submitted().includes("drill e: answered") ?? false);
  });

  // (f) A power loss with an answer to the manager in flight (the adversarial review of §16.4, reproduced): the tap
  // reached the manager's pane, and the agent died before anything else left it. The hub sends answers to whichever pane
  // is the manager now, by name, so after the machine comes back its retry goes to the new manager pane, where no
  // expectation check can tell; and with the answer lost, the store sequence the hub kept doesn't reach the `started`.
  // What keeps it to once is that `started` itself survives: the one commit synced to the disk (done-keys.ts `synced`).
  // Modelled: `started` kept (the agent killed, its database as it was), or taken back (the copy from before it put
  // back, the negative control: what a power loss could do to a `started` that wasn't synced).
  async function answerInFlight(startedLost: boolean) {
    const hooks = { dropAfterStarted: "answer:ny-1:" };
    const o = await office(hooks);
    const copy = await o.agent.copyDatabase(hooks);
    const rid = randomUUID();
    const first = o.hub.answer("ny-1", "ship", rid);
    await until("the tap in the manager", () => o.manager.submitted().includes(TAP), 10_000, 5);
    await o.agent.stop("SIGKILL");                                                  // the machine dies
    let fresh: Lane | null = null;
    const comeBack = async () => {                                                  // tmux went down with it; the lanes start again
      o.tmux.kill();
      fresh = await fakeLane(o.tmux, { window: "manager", prose: "manager after the power loss" });
      await fakeLane(o.tmux, { window: "box", prose: "box after the power loss" });
    };
    if (startedLost) await o.agent.putBackDatabase(copy, {}, comeBack);
    else { await o.agent.waitOffline(); await comeBack(); await o.agent.run({}); await o.agent.waitOnline(); }
    expect(await first).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await until("the new manager pane in the fleet", async () => (await paneOf(o.fleet.client, "n1", "manager")).workerId !== o.managerId, 15_000);
    await sleep(1500);                                                              // the hub's poll has the new manager
    const retry = await o.hub.answer("ny-1", "ship", rid);                         // the app's Check again
    await sleep(1500);
    return { retry, fresh: fresh as Lane | null };
  }

  it("(f) a power loss with an answer to the manager in flight: its started survives, the retry stays uncertain, the new manager receives nothing", async () => {
    const { retry, fresh } = await answerInFlight(false);
    expect(retry).toMatchObject({ status: 409, body: { error: "uncertain" } });
    expect(fresh?.submitted()).toEqual([]);
  });

  it("(f) negative control: with its started taken back, the retry types the answer into the new manager", async () => {
    const { fresh } = await answerInFlight(true);
    expect(fresh?.submitted()).toContain(TAP);
  });

  it("(d) a normal agent restart with its database intact keeps its store: no false rotation", async () => {
    const o = await office();
    await keyedSends(o, 2);                                 // the fleet has seen this store's count
    const before = await storeOf(o);
    await o.agent.stop();
    await o.agent.waitOffline();
    await o.agent.run();
    await o.agent.waitOnline();
    const after = await storeOf(o);
    expect(after).toEqual(before);
    expect(readFileSync(join(o.agent.home, "agent.log"), "utf8")).not.toMatch(/Starting a new store/);
  });

  it("(a) draft_present, then a retry with the same request: typed once, the draft never sent", async () => {
    const o = await office();
    const rid = randomUUID();
    const text = "drill a: after the draft";
    o.box.draft("half a thought");
    await until("the draft on screen", () => o.box.screen().includes("half a thought"));
    expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 409, body: { error: "draft_present" } });
    o.box.clear();
    await until("the draft cleared", () => !o.box.screen().includes("half a thought"));
    expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 200, body: { ok: true } });
    await until("the text in box", () => o.box.submitted().includes(text));
    await sleep(500);
    expect(once(o.box.submitted(), text)).toBe(1);
    expect(o.box.submitted()).not.toContain("half a thought");
  });

  it("(c) an escalation answer retried after a drop: typed once, one Decision recorded", async () => {
    const o = await office({ dropAfterStarted: "answer:ny-1:" });
    // The node's answer was "maybe": in doubt, so 409 uncertain (final review I1; before, a throw and a 500).
    expect(await o.hub.answer("ny-1", "ship")).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await until("the tap in the manager's pane", () => o.manager.submitted().includes(TAP));
    await backAfterDrop(o.flips);
    expect(await o.hub.answer("ny-1", "ship")).toMatchObject({ status: 200, body: { ok: true } });
    await sleep(1000);
    expect(once(o.manager.submitted(), TAP)).toBe(1);
    expect(o.hub.audit().split("\n").filter(l => l.includes("EscalationAnswered") && l.includes("ny-1"))).toHaveLength(1);
  });

  it("(c) negative control: without done keys, the retried answer types a second time", async () => {
    const o = await office({ dropAfterStarted: "answer:ny-1:", noDoneKeys: true });
    expect(await o.hub.answer("ny-1", "ship")).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await until("the tap in the manager's pane", () => o.manager.submitted().includes(TAP));
    await backAfterDrop(o.flips);
    expect((await o.hub.answer("ny-1", "ship")).status).toBe(200);
    await until("the second tap", () => once(o.manager.submitted(), TAP) === 2);
  });

  // (c′) is (b′) for an answer (final review C1): the hub keeps the answer in doubt with the store it went to, so the
  // new store's `unknown` doesn't count. Its control keeps the store id across the loss, and the repeat types again.
  it("(c′) an answer dropped after the paste, then the agent's database is lost: the repeat stays in doubt (409 uncertain), typed once", async () => {
    const o = await office({ dropAfterStarted: "answer:ny-1:" });
    expect(await o.hub.answer("ny-1", "ship")).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await until("the tap in the manager's pane", () => o.manager.submitted().includes(TAP));
    await backAfterDrop(o.flips);
    await o.agent.resetDatabase();                          // a new database, so a new store that knows no key
    await hubReaches(o);                                    // so the 409 below is the store's doing, not an offline node
    const rid = randomUUID();
    for (const requestId of [rid, rid, randomUUID()]) {     // a repeat, its Check again, and a new tap of the same choice
      expect(await o.hub.answer("ny-1", "ship", requestId)).toMatchObject({ status: 409, body: { error: "uncertain" } });
    }
    await sleep(1000);
    expect(once(o.manager.submitted(), TAP)).toBe(1);
    expect(o.hub.audit().split("\n").filter(l => l.includes("EscalationAnswered") && l.includes("ny-1"))).toHaveLength(0);
  });

  it("(c″) an answer dropped after the paste, then an older copy of agent.db put back in place (cp, the same store): uncertain, typed once", async () => {
    const hooks = { dropAfterStarted: "answer:ny-1:", fixedStreamId: randomUUID() };   // the store kept: the hub's comparison alone
    const o = await office(hooks);
    const copy = await o.agent.copyDatabase(hooks);
    await hubReaches(o);
    const flips = await statuses(o.fleet, "n1");
    const rid = randomUUID();
    expect(await o.hub.answer("ny-1", "ship", rid)).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await until("the tap in the manager's pane", () => o.manager.submitted().includes(TAP));
    await backAfterDrop(flips);
    const before = await storeOf(o);
    await o.agent.putBackDatabase(copy, hooks);
    const after = await storeOf(o);
    expect(after.store).toBe(before.store);
    expect(after.storeSeq ?? 0).toBeLessThan(before.storeSeq ?? 0);
    for (const requestId of [rid, rid, randomUUID()]) {     // a repeat, its Check again, and a new tap of the same choice
      expect(await o.hub.answer("ny-1", "ship", requestId)).toMatchObject({ status: 409, body: { error: "uncertain" } });
    }
    await sleep(1000);
    expect(once(o.manager.submitted(), TAP)).toBe(1);
    expect(o.hub.audit().split("\n").filter(l => l.includes("EscalationAnswered") && l.includes("ny-1"))).toHaveLength(0);
  });

  it("(c′) negative control: the database lost but its store id kept (fixedStreamId), the repeated answer types a second time", async () => {
    const store = randomUUID();
    const o = await office({ dropAfterStarted: "answer:ny-1:", fixedStreamId: store });
    expect(await o.hub.answer("ny-1", "ship")).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await until("the tap in the manager's pane", () => o.manager.submitted().includes(TAP));
    await backAfterDrop(o.flips);
    await o.agent.resetDatabase({ fixedStreamId: store });
    await hubReaches(o);
    expect(await o.hub.answer("ny-1", "ship")).toMatchObject({ status: 200, body: { ok: true } });
    await until("the second tap", () => once(o.manager.submitted(), TAP) === 2);
  });
});
