// A message, or a lane's first prompt, over the old maxSendText bound goes only to a node whose hello said it takes one
// (CAP_LONG_TEXT): an older agent would refuse it bad_args after 8,000, so the fleet refuses it first, unknown_op, and
// nothing is sent.
import { describe, expect, it, vi } from "vitest";
import { CAP_LONG_TEXT, LIMITS, type Pane } from "@morndo/protocol";
import { startTestFleet, type TestFleet } from "./helpers/fleet.ts";
import type { FakeAgent } from "./helpers/fake-agent.ts";
import { nodeQueue } from "./helpers/node-queue.ts";
import { client } from "./helpers/socket-client.ts";

const W = (node: string, n: number) => `${node}.3fa2c1d0.${n}`;
const pane = (node: string, n: number, window: string): Pane => ({ workerId: W(node, n), window, cwd: "/work", status: "idle", pid: 100 + n });
const post = (fleet: TestFleet, body: unknown) => client(fleet.config.socketPath).raw("/v1/deliveries", {
  method: "POST", headers: { "content-type": "application/json", "x-morndo-client": "kira" }, body: JSON.stringify(body),
}).then(r => ({ status: r.status, body: JSON.parse(r.body.toString()) as Record<string, unknown> }));
const sent = (a: FakeAgent) => a.reqs.filter(r => r.op === "lane.deliver").map(r => r.args);
const typed = (a: FakeAgent) => a.reqs.filter(r => r.op === "pane.send").map(r => r.args);
const started = (a: FakeAgent) => a.reqs.filter(r => r.op === "lane.start").map(r => r.args as { prompt?: string });

async function nodeWith(fleet: TestFleet, node: string, window: string, caps?: string[]): Promise<FakeAgent> {
  const a = await fleet.online(node, caps ? { caps } : {});
  nodeQueue(a);
  a.inventory([pane(node, 0, window)]);
  await vi.waitFor(() => expect(fleet.lanes.get(window)?.node).toBe(node));
  return a;
}

describe("long messages", () => {
  it("a node whose hello says nothing of long messages gets none over maxSendText: unknown_op, executed no, nothing sent", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", "api");                                   // as an older agent: caps hold ops only
    const api = client(fleet.config.socketPath);
    for (const [i, text] of ["x".repeat(LIMITS.maxSendText + 1), "ü".repeat(LIMITS.maxMessageText)].entries()) {
      expect((await post(fleet, { id: `kira:${i}`, lane: "api", text })).body, `${text.length} characters`)
        .toMatchObject({ ok: false, error: { code: "unknown_op", executed: "no", message: expect.stringContaining("at most 8000 characters") } });
      expect(await api.post("/v1/op", { node: "pc", op: "pane.send", args: { workerId: W("pc", 0), text, expect: { server: "3fa2c1d0", window: "api" } }, key: `hub:${i}` }))
        .toMatchObject({ status: 200, body: { ok: false, error: { code: "unknown_op", executed: "no" } } });
    }
    expect(pc.reqs).toEqual([]);
  });

  it("the old bound goes to any node; the new one, whole, to a node that said CAP_LONG_TEXT", async () => {
    const fleet = await startTestFleet();
    const old = await nodeWith(fleet, "old", "api");
    const now = await nodeWith(fleet, "now", "work", ["inventory.get", CAP_LONG_TEXT]);
    const api = client(fleet.config.socketPath);
    const atBound = "x".repeat(LIMITS.maxSendText);
    expect((await post(fleet, { id: "kira:old", lane: "api", text: atBound })).body).toMatchObject({ ok: true, delivery: { node: "old" } });
    expect(sent(old)).toEqual([{ id: "kira:old", target: { lane: "api", sticky: false }, text: atBound }]);
    const whole = 'ü€"\n'.repeat(25_000);                                            // exactly maxMessageText, with what a paste must survive
    expect(whole).toHaveLength(LIMITS.maxMessageText);
    expect((await post(fleet, { id: "kira:new", lane: "work", text: whole })).body).toMatchObject({ ok: true, delivery: { node: "now" } });
    expect(sent(now)).toEqual([{ id: "kira:new", target: { lane: "work", sticky: false }, text: whole }]);
    expect(await api.post("/v1/op", { node: "now", op: "pane.send", args: { workerId: W("now", 0), text: whole, expect: { server: "3fa2c1d0", window: "work" } }, key: "hub:new" }))
      .toMatchObject({ status: 200, body: { ok: true } });
    expect(typed(now)).toEqual([{ workerId: W("now", 0), text: whole, expect: { server: "3fa2c1d0", window: "work" } }]);
  });

  it("a 20,000-character first prompt reaches a long-text node intact", async () => {
    const fleet = await startTestFleet();
    const now = await nodeWith(fleet, "now", "work", ["inventory.get", CAP_LONG_TEXT]);
    const api = client(fleet.config.socketPath);
    const prompt = 'ü€"\n'.repeat(4999) + 'ü€"x';                                     // exactly 20,000 characters, multi-line, no trailing newline
    expect(prompt).toHaveLength(20_000);
    const r = await api.post("/v1/op", { node: "now", op: "lane.start", args: { name: "build", cwd: "/work/build", prompt }, key: "lanes:start-1" });
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect(started(now)).toEqual([{ name: "build", cwd: "/work/build", prompt }]);
  });

  it("an old node refuses a long first prompt cleanly, and the refused start reserved nothing", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", "api");                                    // as an older agent: caps hold ops only
    const api = client(fleet.config.socketPath);
    const long = 'ü€"\n'.repeat(4999) + 'ü€"x';
    const refused = await api.post("/v1/op", { node: "pc", op: "lane.start", args: { name: "build", cwd: "/work/build", prompt: long }, key: "lanes:start-1" });
    expect(refused).toMatchObject({ status: 200, body: { ok: false, error: { code: "unknown_op", executed: "no", message: expect.stringContaining("at most 8000 characters") } } });
    expect(pc.reqs).toEqual([]);                                                      // nothing was sent, so no lane began
    // The refusal (executed "no") released the name's reservation: the same name starts with a prompt the old node takes.
    const atBound = "x".repeat(LIMITS.maxSendText);
    const again = await api.post("/v1/op", { node: "pc", op: "lane.start", args: { name: "build", cwd: "/work/build", prompt: atBound }, key: "lanes:start-2" });
    expect(again).toMatchObject({ status: 200, body: { ok: true } });
    expect(started(pc)).toEqual([{ name: "build", cwd: "/work/build", prompt: atBound }]);
  });

  it("a first prompt of exactly maxMessageText reaches a long-text node, and one more is refused as bad_args before anything is sent", async () => {
    const fleet = await startTestFleet();
    const now = await nodeWith(fleet, "now", "work", ["inventory.get", CAP_LONG_TEXT]);
    const api = client(fleet.config.socketPath);
    const over = await api.post("/v1/op", { node: "now", op: "lane.start", args: { name: "build", cwd: "/work/build", prompt: "x".repeat(LIMITS.maxMessageText + 1) }, key: "lanes:start-1" });
    expect(over).toMatchObject({ status: 200, body: { ok: false, error: { code: "bad_args", executed: "no" } } });   // the router's own arg check
    expect(now.reqs).toEqual([]);
    const whole = 'ü€"\n'.repeat(25_000);                                             // exactly maxMessageText, with what a paste must survive
    expect(whole).toHaveLength(LIMITS.maxMessageText);
    const r = await api.post("/v1/op", { node: "now", op: "lane.start", args: { name: "build", cwd: "/work/build", prompt: whole }, key: "lanes:start-2" });
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect(started(now)).toEqual([{ name: "build", cwd: "/work/build", prompt: whole }]);
  });
});
