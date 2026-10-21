// Routing an op (spec 5.3, 5.6, 7): by worker ID, node or lane; node_offline (executed: no) for a node that isn't
// online; key, timeout and args (the expectation among them) passed through; a lane in conflict is lane_conflict for
// every route by its name, while a worker ID is still routed; lane.start of a name registered anywhere, or being
// started, is name_taken; a dropped connection mapped to uncertain for side effects and node_offline for reads; late
// results from the same instance accepted, results for another instance's requests dropped (spec 9, contract: "a fake
// agent answering the wrong id or an old connEpoch is ignored"); every side-effecting op audited.
import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { startTestFleet, type TestFleet } from "./helpers/fleet.ts";
import { validResult, type FakeAgent } from "./helpers/fake-agent.ts";

const W = "pc.3fa2c1d0.4";
async function withLane(fleet: TestFleet, node: string, name: string, workerId = W): Promise<FakeAgent> {
  const a = await fleet.online(node);
  a.inventory([{ workerId, window: name, cwd: "/work" }]);
  await vi.waitFor(() => expect(fleet.lanes.get(name)?.workerId).toBe(workerId));
  return a;
}
const lastReq = (a: FakeAgent) => a.reqs.at(-1);

describe("routing", () => {
  it("by worker ID, by node and by lane; a lane fills in its worker and the expectation", async () => {
    const fleet = await startTestFleet();
    const a = await withLane(fleet, "pc", "fix: a/b ü.2");
    expect(await fleet.router.op({ workerId: W }, "pane.frame", { workerId: W })).toMatchObject({ ok: true });
    expect(await fleet.router.op({ node: "pc" }, "inventory.get", {})).toMatchObject({ ok: true });
    expect(await fleet.router.op({ lane: "fix: a/b ü.2" }, "pane.send", { text: "hi" }, { key: "kira:1" })).toMatchObject({ ok: true });
    expect(lastReq(a)).toMatchObject({ op: "pane.send", key: "kira:1", args: { workerId: W, text: "hi", expect: { server: "3fa2c1d0", window: "fix: a/b ü.2" } } });
    expect(await fleet.router.op({ lane: "fix: a/b ü.2" }, "transcript.size", { sessionId: "s1" })).toMatchObject({ ok: true });
    expect(lastReq(a)?.args).toEqual({ sessionId: "s1" });                         // only pane ops get a worker
  });

  it("passes key, timeout and the expectation in args through unchanged", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    const expectation = { server: "3fa2c1d0", window: "api", sessionId: "abc" };
    await fleet.router.op({ workerId: W }, "pane.send", { workerId: W, text: "x", expect: expectation }, { key: "hub:e:r", timeoutMs: 7000 });
    expect(lastReq(a)).toEqual({ v: 1, t: "req", id: "1.1", op: "pane.send", args: { workerId: W, text: "x", expect: expectation }, timeoutMs: 7000, key: "hub:e:r" });
    await fleet.router.op({ workerId: W }, "pane.keys", { workerId: W, data: "q", expect: expectation });
    expect(lastReq(a)).toMatchObject({ op: "pane.keys", timeoutMs: 15_000 });
    expect(lastReq(a)).not.toHaveProperty("key");
    await fleet.router.op({ node: "pc" }, "inventory.get", {}, { timeoutMs: 999_999 });
    expect(lastReq(a)?.timeoutMs).toBe(120_000);                                    // clamped
  });

  it("refuses what can't be routed safely, before sending anything", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    const e = { server: "3fa2c1d0", window: "api" };
    const cases = [
      fleet.router.op({ workerId: "%3" }, "pane.frame", {}),
      fleet.router.op({ node: "PC!" }, "inventory.get", {}),
      fleet.router.op({ workerId: W }, "pane.send", { workerId: W, text: "x", expect: e }),                  // no key
      fleet.router.op({ workerId: W }, "pane.keys", { workerId: W, data: "x", expect: e }, { key: "hub:k" }), // a key on keys
      fleet.router.op({ workerId: W }, "pane.frame", { workerId: "pc.3fa2c1d0.5" }),                         // another worker
      fleet.router.op({ node: "pc" }, "inventory.get", { expect: e }),                                       // takes none
      fleet.router.op({ workerId: W }, "pane.frame", { workerId: W, expect: e }),
    ];
    for (const r of await Promise.all(cases)) expect(r).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    expect(a.reqs).toEqual([]);
  });

  it("checks each op's args with the shared OP_ARGS before routing: bad_args, not executed, store null, nothing sent (final review M7)", async () => {
    const fleet = await startTestFleet();
    const a = await withLane(fleet, "pc", "api");
    const e = { server: "3fa2c1d0", window: "api" };
    const cases: [Parameters<typeof fleet.router.op>, string][] = [
      [[{ workerId: W }, "pane.send", { workerId: W, text: "x".repeat(LIMITS.maxMessageText + 1), expect: e }, { key: "hub:1" }], "text over 100000"],
      [[{ workerId: W }, "pane.send", { workerId: W, text: "x" }, { key: "hub:2" }], "no expectation"],
      [[{ workerId: W }, "pane.keys", { workerId: W, data: "", expect: e }], "no keystrokes"],
      [[{ node: "pc" }, "pane.frame", { workerId: "%3" }], "not a worker ID"],
      [[{ lane: "api" }, "pane.send", { text: "x", expect: { server: "XYZ", window: "api" } }, { key: "hub:3" }], "a bad expectation"],
      [[{ node: "pc" }, "lane.start", { name: "n", cwd: "relative/dir" }, { key: "lanes:1" }], "a relative cwd"],
      [[{ node: "pc" }, "lane.start", { name: "n", cwd: "/w", account: "--dangerously-skip-permissions" }, { key: "lanes:2" }], "a flag as account"],
      [[{ node: "pc" }, "file.get", { path: "/etc/hosts", offset: 0, max: 262_145 }], "a chunk over 256 KiB"],
      [[{ node: "pc" }, "file.stat", { path: "/a", ref: "r1" }], "both a path and a ref"],
      [[{ node: "pc" }, "inventory.get", { extra: 1 }], "inventory.get takes nothing"],
      [[{ node: "pc" }, "worktree.add", { repo: "/r", name: "-b", base: "main" }, { key: "lanes:3" }], "a branch that is an option"],
    ];
    for (const [args, why] of cases) {
      expect(await fleet.router.op(...args), why).toEqual({ ok: false, error: { code: "bad_args", executed: "no", message: expect.any(String) }, store: null, storeSeq: null });
    }
    expect(a.reqs).toEqual([]);
    expect(fleet.lanes.get("n")).toBeNull();
    // A field OP_ARGS doesn't know never reaches the node; what fits goes as checked (negative control: it is sent).
    expect(await fleet.router.op({ node: "pc" }, "lane.start", { name: "n2", cwd: "/w", flags: ["--model", "x"] }, { key: "lanes:4" })).toMatchObject({ ok: true });
    expect(lastReq(a)?.args).toEqual({ name: "n2", cwd: "/w" });
  });

  it("an unknown lane is no_pane; a lane in conflict is lane_conflict, and neither node is sent anything", async () => {
    const fleet = await startTestFleet();
    const pc = await withLane(fleet, "pc", "api", "pc.3fa2c1d0.1");
    const mac = await withLane(fleet, "mac", "solo", "mac.3fa2c1d0.2");
    mac.inventory([{ workerId: "mac.3fa2c1d0.2", window: "api", cwd: "/w" }]);
    await vi.waitFor(() => expect(fleet.lanes.get("api")?.conflict).toBe(true));
    pc.reqs.length = 0;
    expect(await fleet.router.op({ lane: "nope" }, "pane.frame", {})).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
    expect(await fleet.router.op({ lane: "api" }, "pane.send", { text: "x" }, { key: "kira:1" })).toMatchObject({ ok: false, error: { code: "lane_conflict", executed: "no" }, store: null });
    expect(await fleet.router.op({ lane: "api" }, "pane.keys", { data: "q" })).toMatchObject({ ok: false, error: { code: "lane_conflict" } });
    expect([...pc.reqs, ...mac.reqs]).toEqual([]);
    expect(await fleet.router.op({ node: "mac" }, "lane.start", { name: "api", cwd: "/w" }, { key: "lanes:1" }))
      .toMatchObject({ ok: false, error: { code: "name_taken", executed: "no" } });                       // starting one: taken
    // By worker ID the caller picked one pane: it is routed, conflict or not (the node checks the expectation).
    const e = { server: "3fa2c1d0", window: "api" };
    expect(await fleet.router.op({ workerId: "mac.3fa2c1d0.2" }, "pane.send", { workerId: "mac.3fa2c1d0.2", text: "x", expect: e }, { key: "hub:1" })).toMatchObject({ ok: true, store: mac.store });
    expect(await fleet.router.op({ workerId: "pc.3fa2c1d0.1" }, "pane.frame", { workerId: "pc.3fa2c1d0.1" })).toMatchObject({ ok: true });
    expect([pc.reqs.map(r => r.op), mac.reqs.map(r => r.op)]).toEqual([["pane.frame"], ["pane.send"]]);
  });

  it("lane.start reserves its name until the node answers and reports it: a second start of it is name_taken, never sent", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    const mac = await fleet.online("mac");
    let release = () => {};
    pc.answer = req => {
      if (req.op !== "lane.start") return { ok: true, result: validResult(req.op, "pc") };
      release = () => pc.send({ v: 1, t: "res", id: req.id, invVersion: 2, store: pc.store, ok: true, result: { workerId: "pc.3fa2c1d0.9" } });
      return "never";
    };
    const first = fleet.router.op({ node: "pc" }, "lane.start", { name: "new-lane", cwd: "/w" }, { key: "lanes:1" });
    await vi.waitFor(() => expect(pc.reqs.filter(r => r.op === "lane.start")).toHaveLength(1));
    expect(await fleet.router.op({ node: "mac" }, "lane.start", { name: "new-lane", cwd: "/w" }, { key: "lanes:2" }))
      .toMatchObject({ ok: false, error: { code: "name_taken", executed: "no" }, store: null });          // negative control: without the reservation, sent to mac
    expect(mac.reqs).toEqual([]);
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(await fleet.router.op({ node: "mac" }, "lane.start", { name: "new-lane", cwd: "/w" }, { key: "lanes:3" }))
      .toMatchObject({ ok: false, error: { code: "name_taken" } });                                        // answered, not reported yet
    pc.inventory([{ workerId: "pc.3fa2c1d0.9", window: "new-lane", cwd: "/w" }]);
    await vi.waitFor(() => expect(fleet.lanes.get("new-lane")?.node).toBe("pc"));
    // A start the node refused before doing anything frees its name at once.
    pc.answer = () => ({ ok: false, error: { code: "bad_args", executed: "no", message: "no such directory" } });
    expect(await fleet.router.op({ node: "pc" }, "lane.start", { name: "other", cwd: "/nope" }, { key: "lanes:4" })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    expect(await fleet.router.op({ node: "mac" }, "lane.start", { name: "other", cwd: "/w" }, { key: "lanes:5" })).toMatchObject({ ok: true });
    expect(mac.reqs.map(r => (r.args as { name: string }).name)).toEqual(["other"]);
  });

  it("audits every side-effecting op with its target, key namespace, outcome and client, never its text; reads not at all", async () => {
    const fleet = await startTestFleet();
    await fleet.online("pc");
    const e = { server: "3fa2c1d0", window: "api" };
    await fleet.router.op({ workerId: W }, "pane.send", { workerId: W, text: "the secret words", expect: e }, { key: "hub:e1:r1", client: "hub" });
    await fleet.router.op({ workerId: W }, "pane.keys", { workerId: W, data: "rm -rf", expect: e });
    await fleet.router.op({ lane: "nope" }, "pane.send", { text: "x" }, { key: "kira:1", client: "kira" });
    await fleet.router.op({ node: "pc" }, "inventory.get", {}, { client: "hub" });                        // a read: not audited
    expect(fleet.audit.of("op.pane.send").map(r => [r.actor, r.node, r.detail])).toEqual([
      ["client", "pc", { target: { workerId: W }, keyNs: "hub", outcome: "ok", client: "hub" }],
      ["client", null, { target: { lane: "nope" }, keyNs: "kira", outcome: "no_pane", client: "kira" }],
    ]);
    expect(fleet.audit.of("op.pane.keys").map(r => r.detail)).toEqual([{ target: { workerId: W }, keyNs: null, outcome: "ok", client: "unknown" }]);
    expect(fleet.audit.of("op.inventory.get")).toEqual([]);
    expect(JSON.stringify(fleet.audit.recent())).not.toMatch(/secret words|rm -rf/);
  });

  it("lane.start refuses a name already registered anywhere in the fleet (name_taken), before sending anything", async () => {
    const fleet = await startTestFleet();
    await withLane(fleet, "pc", "api");
    const mac = await fleet.online("mac");
    expect(await fleet.router.op({ node: "mac" }, "lane.start", { name: "api", cwd: "/work" }, { key: "lanes:1" }))
      .toMatchObject({ ok: false, error: { code: "name_taken", executed: "no" } });
    expect(mac.reqs).toEqual([]);
    expect(await fleet.router.op({ node: "mac" }, "lane.start", { name: "api-2", cwd: "/work" }, { key: "lanes:2" })).toMatchObject({ ok: true });
  });

  it("node_offline (executed: no) for a node that is not online, and for the lanes it keeps while offline", async () => {
    const fleet = await startTestFleet();
    const a = await withLane(fleet, "pc", "api");
    await a.close();
    await vi.waitFor(() => expect(fleet.connections.status("pc")).toBe("offline"));
    expect(fleet.lanes.get("api")).toEqual({ name: "api", node: "pc", workerId: W, conflict: false });   // kept, offline
    expect(await fleet.router.op({ lane: "api" }, "pane.send", { text: "x" }, { key: "kira:1" })).toMatchObject({ ok: false, error: { code: "node_offline", executed: "no" } });
    expect(await fleet.router.op({ node: "never-joined" }, "inventory.get", {})).toMatchObject({ ok: false, error: { code: "node_offline" } });
  });
});

describe("a connection that drops during a request", () => {
  it("a read fails at once with node_offline; a side effect waits for its deadline, then is uncertain", async () => {
    const fleet = await startTestFleet({ resultSlackMs: 50 });
    const a = await fleet.online("pc");
    a.answer = () => "never";
    const read = fleet.router.op({ node: "pc" }, "transcript.size", { sessionId: "s" }, { timeoutMs: 30_000 });
    const send = fleet.router.op({ workerId: W }, "pane.send", { workerId: W, text: "x", expect: { server: "3fa2c1d0", window: "api" } }, { key: "hub:k1", timeoutMs: 300 });
    await vi.waitFor(() => expect(a.reqs).toHaveLength(2));
    const started = performance.now();
    a.terminate();
    expect(await read).toMatchObject({ ok: false, error: { code: "node_offline", executed: "no" } });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(await send).toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe" } });
  });

  it("a late result from the same instance on its new connection is accepted", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.answer = () => "never";
    const send = fleet.router.op({ workerId: W }, "pane.send", { workerId: W, text: "x", expect: { server: "3fa2c1d0", window: "api" } }, { key: "hub:k1", timeoutMs: 10_000 });
    await vi.waitFor(() => expect(a.reqs).toHaveLength(1));
    const id = a.reqs[0]?.id ?? "";
    a.terminate();                                                                  // dropped after the paste
    await vi.waitFor(() => expect(fleet.connections.status("pc")).toBe("offline"));
    expect((await a.connect()).ok).toBe(true);                                       // the same process reconnects
    a.send({ v: 1, t: "res", id, invVersion: 9, store: a.store, ok: true, result: { problem: null, typedAt: 5 } });
    expect(await send).toEqual({ ok: true, result: { problem: null, typedAt: 5 }, invVersion: 9, store: a.store, storeSeq: null });
  });

  it("a result for another instance's request (an old connEpoch) is dropped, and the connection stays", async () => {
    const fleet = await startTestFleet();
    const old = await fleet.online("pc");
    old.answer = () => "never";
    const send = fleet.router.op({ workerId: W }, "pane.send", { workerId: W, text: "x", expect: { server: "3fa2c1d0", window: "api" } }, { key: "hub:k1", timeoutMs: 10_000 });
    await vi.waitFor(() => expect(old.reqs).toHaveLength(1));
    const id = old.reqs[0]?.id ?? "";
    expect(id).toBe("1.1");
    old.terminate();
    await vi.waitFor(() => expect(fleet.connections.status("pc")).toBe("offline"));
    const restarted = fleet.agent({ node: "pc", key: old.key });                    // a new agent process: a new instance
    expect(await restarted.connect()).toMatchObject({ ok: true, welcome: { connEpoch: 2 } });
    expect(await send).toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe" }, store: old.streamId });   // at once
    restarted.send({ v: 1, t: "res", id, invVersion: 1, store: restarted.store, ok: true, result: { problem: null, typedAt: 1 } });
    expect(await fleet.router.op({ node: "pc" }, "inventory.get", {})).toMatchObject({ ok: true });      // still serving
    expect(restarted.open).toBe(true);
  });

  it("a result with an id nobody waits for is ignored; the right one still lands", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.answer = req => {
      a.send({ v: 1, t: "res", id: `999.${req.id}`, invVersion: 1, store: a.store, ok: true, result: { panes: [], invVersion: 999 } });
      return { ok: true, result: { panes: [], invVersion: 7 } };
    };
    expect(await fleet.router.op({ node: "pc" }, "inventory.get", {})).toEqual({ ok: true, result: { panes: [], invVersion: 7 }, invVersion: 1, store: a.store, storeSeq: null });
    expect(a.open).toBe(true);
  });
});
