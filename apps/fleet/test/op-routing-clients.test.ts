// The ops fleet clients use through POST /v1/op (spec §5, §8): pane.capture by lane gets the lane's worker and waits its
// turn with the other bulk ops (up to 256 KiB, one chunk); lane.stop's default deadline leaves its "exit" mode the 30 s
// it may wait for the window to close.
import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { startTestFleet } from "./helpers/fleet.ts";
import { client } from "./helpers/socket-client.ts";

describe("ops for fleet clients", () => {
  it("pane.capture by lane gets the lane's worker ID, and goes one at a time with the bulk ops", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    pc.inventory([{ workerId: "pc.3fa2c1d0.4", window: "api", cwd: "/w", status: "idle", pid: 1 }]);
    await vi.waitFor(() => expect(fleet.lanes.get("api")).not.toBeNull());
    let release: () => void = () => {};
    pc.answer = req => {
      if (req.op === "transcript.read") { const id = req.id; release = () => pc.send({ v: 1, t: "res", id, invVersion: 1, store: pc.store, ok: true, result: { bytes: "", eof: true } }); return "never"; }
      if (req.op === "pane.capture") return { ok: true, result: { text: "screen", truncated: false } };
      return { ok: true, result: {} };
    };
    const api = client(fleet.config.socketPath);
    const read = api.post("/v1/op", { node: "pc", op: "transcript.read", args: { sessionId: "s1", offset: 0, max: 1024 } });
    await vi.waitFor(() => expect(pc.reqs.map(r => r.op)).toEqual(["transcript.read"]));
    const capture = api.post("/v1/op", { lane: "api", op: "pane.capture", args: { lines: 200, attributes: true } });
    await new Promise(r => setTimeout(r, 100));
    expect(pc.reqs.map(r => r.op)).toEqual(["transcript.read"]);                      // negative control: not bulk, sent at once
    release();
    expect((await capture)?.body).toMatchObject({ ok: true, result: { text: "screen", truncated: false } });
    expect(pc.reqs.at(-1)?.args).toEqual({ workerId: "pc.3fa2c1d0.4", lines: 200, attributes: true });
    await read;
  });

  it("lane.stop's default deadline is the 30 s its exit may wait plus 15 s; a client's own timeoutMs still wins", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    const api = client(fleet.config.socketPath);
    await api.post("/v1/op", { node: "pc", op: "lane.stop", args: { name: "api" }, key: "lanes:stop-1" });
    await api.post("/v1/op", { node: "pc", op: "lane.stop", args: { name: "api" }, key: "lanes:stop-2", timeoutMs: 5000 });
    expect(pc.reqs.map(r => r.timeoutMs)).toEqual([LIMITS.laneStopWaitMs + 15_000, 5000]);
  });
});
