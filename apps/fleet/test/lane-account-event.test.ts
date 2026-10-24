// A lane started with an account (S3, plan 4.5 item 4): the account it will work under, told as a usage tap once the
// start's outcome is ok — a start without an account, a refused one and a failed one say nothing. The hub resolves an
// account from these records (usage-account.ts); here only that the fleet tells them.
import { describe, expect, it, vi } from "vitest";
import { startTestFleet } from "./helpers/fleet.ts";
import { client } from "./helpers/socket-client.ts";

describe("a lane's account, told as a usage tap", () => {
  it("a lane.start with an account publishes one lane_account tap; without one, refused or failed, nothing", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    const api = client(fleet.config.socketPath);
    const events = await api.events();
    const taps = () => events.received.filter(e => e.t === "usage");

    const r = await api.post("/v1/op", { node: "pc", op: "lane.start", args: { name: "w1", cwd: "/w", account: "seat-a" }, key: "lanes:start-1" });
    expect(r?.body).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(taps()).toHaveLength(1));
    expect(taps()[0]).toEqual({ t: "usage", node: "pc", body: { kind: "lane_account", lane: "w1", account: "seat-a", at: expect.any(Number) } });

    await api.post("/v1/op", { node: "pc", op: "lane.start", args: { name: "w2", cwd: "/w" }, key: "lanes:start-2" });   // no account named
    await vi.waitFor(() => expect(pc.reqs.filter(q => q.op === "lane.start")).toHaveLength(2));
    expect(taps()).toHaveLength(1);

    pc.answer = () => ({ ok: false, error: { code: "denied", executed: "no", message: "no" } });
    await api.post("/v1/op", { node: "pc", op: "lane.start", args: { name: "w3", cwd: "/w", account: "seat-a" }, key: "lanes:start-3" });
    await vi.waitFor(() => expect(pc.reqs.filter(q => q.op === "lane.start")).toHaveLength(3));
    expect(taps()).toHaveLength(1);                                                      // negative control: a refused start says nothing
    events.close();
  });
});
