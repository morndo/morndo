// A graceful stop (main.ts's SIGTERM and SIGINT handlers await fleet.close()) answers the ops it is serving before it
// closes their connections (B6 S1): Connections.stop() settles a pane.send in flight as uncertain with the store the
// request went to, and that answer reaches the client, so a later op.status to that store can settle it. Closing every
// connection first left the client "socket hang up" and no store.
import { describe, expect, it } from "vitest";
import { startTestFleet } from "./helpers/fleet.ts";
import { client } from "./helpers/socket-client.ts";
import { until } from "./helpers/until.ts";

const PANE = "pc.3fa2c1d0.1";

describe("a graceful stop", () => {
  it("answers a side-effecting op in flight as uncertain with its store before it closes the client's connection", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    pc.answer = () => "never";                                          // the agent holds the send (a pane lock, say)
    const answer = client(fleet.config.socketPath).raw("/v1/op", {
      method: "POST", headers: { "content-type": "application/json", "x-morndo-client": "hub" },
      body: JSON.stringify({ workerId: PANE, op: "pane.send", args: { workerId: PANE, text: "hi", expect: { server: "3fa2c1d0", window: "api" } }, key: "hub:stop-drain", timeoutMs: 10_000 }),
    });
    await until(() => pc.reqs.some(r => r.op === "pane.send"));
    await fleet.close();
    const r = await answer;
    expect(r.status).toBe(200);
    expect(r.complete).toBe(true);
    expect(JSON.parse(r.body.toString())).toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe" }, store: pc.streamId });
  });
});
