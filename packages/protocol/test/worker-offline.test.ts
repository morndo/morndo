// A worker whose machine doesn't answer (fleet core §7: its workers stay listed, shown offline). A roster entry and a
// worker appearing carry `offline`; a hub from before it doesn't say, which reads as online. WorkerOfflineChanged says
// when it changes; an older app skips it as a type it doesn't know and keeps its place in the sequence (O1).
// Synthetic frames only.
import { describe, expect, it } from "vitest";
import { ServerFeedFrames, decode, decodeEvent } from "../src/index.ts";

const entry = { id: "pc.3fa2c1d0.12", name: "alpha", location: "alpha", node: "pc", title: null, lastMessageAt: null, needsYou: false, waitingOn: null, state: "quiet", changedAt: 0 };
const event = (body: unknown) => ({ epoch: "e1", seq: 1, at: 1, body });

describe("offline on the roster", () => {
  it("keeps each entry's offline; an entry from a hub that doesn't say is online", () => {
    const d = decode(ServerFeedFrames, JSON.stringify({ t: "snapshot", epoch: "e1", seq: 0, workers: [{ ...entry, offline: true }, { ...entry, id: "%1" }] }));
    expect(d.kind === "ok" && d.frame.t === "snapshot" ? d.frame.workers.map(w => [w.id, w.offline]) : null).toEqual([["pc.3fa2c1d0.12", true], ["%1", false]]);
  });
  it("a worker appearing says whether it is offline; one from a hub that doesn't say is online", () => {
    const worker = { id: "box.0a0a0a0a.3", name: "beta", location: "beta", node: "box" };
    const offline = (extra: object) => {
      const d = decodeEvent(event({ type: "WorkerAppeared", worker, state: "quiet", changedAt: 1, ...extra }));
      return d.kind === "event" && d.event.body.type === "WorkerAppeared" ? d.event.body.offline : null;
    };
    expect(offline({ offline: true })).toBe(true);
    expect(offline({})).toBe(false);
  });
});

describe("WorkerOfflineChanged", () => {
  it("decodes both ways", () => {
    for (const offline of [true, false]) {
      const body = { type: "WorkerOfflineChanged", workerId: "pc.3fa2c1d0.12", offline };
      expect(decodeEvent(event(body))).toEqual({ kind: "event", event: event(body) });
    }
  });
  it("one without a boolean flag is malformed (negative control)", () => {
    expect(decodeEvent(event({ type: "WorkerOfflineChanged", workerId: "pc.3fa2c1d0.12" })).kind).toBe("malformed");
    expect(decodeEvent(event({ type: "WorkerOfflineChanged", workerId: "pc.3fa2c1d0.12", offline: "yes" })).kind).toBe("malformed");
  });
});

describe("WorkerMoved", () => {
  it("decodes with its folder; one without a folder is malformed", () => {
    const body = { type: "WorkerMoved", workerId: "pc.3fa2c1d0.12", location: "proj" };
    expect(decodeEvent(event(body))).toEqual({ kind: "event", event: event(body) });
    expect(decodeEvent(event({ type: "WorkerMoved", workerId: "pc.3fa2c1d0.12" })).kind).toBe("malformed");
  });
});
