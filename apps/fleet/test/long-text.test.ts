// A message over the old maxSendText bound goes only to a node whose hello said it takes one (CAP_LONG_TEXT): an older
// agent would refuse it bad_args after 8,000, so the fleet refuses it first, unknown_op, and nothing is sent.
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
});
