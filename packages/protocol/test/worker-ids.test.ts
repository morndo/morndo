// Worker ids on the feed (spec §4; ADR-0012): the fleet's `<node>.<server>.<pane>` and a legacy hub's `%N` are both taken
// in every frame that names a worker, whichever hub the app talks to (one build serves both, and each hub answers an id
// it doesn't hold as no pane). Anything else is malformed. A roster entry carries its node; one from a hub that doesn't
// say has node "". Menu escalation ids for the same %N on two nodes, or on two tmux servers of one node, never collide.
import { describe, expect, it } from "vitest";
import { ClientFeedFrames, ServerFeedFrames, decode, decodeEvent, menuEscalationId } from "../src/index.ts";

const GOOD = ["pc.3fa2c1d0.12", "a.00000000.0", `${"n".repeat(32)}.ffffffff.999999999`, "%0", "%12", "%999999999"];
const BAD = ["pc.3fa2c1d0", "PC.3fa2c1d0.1", "pc.3FA2C1D0.1", "pc.3fa2c1d.1", "pc.3fa2c1d0.1.2", "pc_3fa2c1d0_1",
  `${"n".repeat(33)}.3fa2c1d0.1`, "pc.3fa2c1d0.1234567890", "pc.3fa2c1d0.-1", " pc.3fa2c1d0.1", "%", "%1a", "%1234567890",
  "../../etc", "main:0", ""];
const kind = (d: { kind: string }) => d.kind;
const clientFrames = (id: string) => [{ t: "watch", worker: id }, { t: "details", worker: id }, { t: "older", worker: id, before: "a1:0" }, { t: "catchup", worker: id }];
const message = { id: "m1", at: 1, author: { kind: "agent", name: "builder" }, kind: "text", text: "Starting." };
const serverFrames = (id: string) => [
  { t: "screen", worker: id, text: "$ ", at: 1 },
  { t: "history", worker: id, messages: [message], session: null },
  { t: "messages", worker: id, messages: [message] },
  { t: "details", worker: id, session: null },
  { t: "older", worker: id, before: "a1:0", messages: [], done: true },
];

describe("worker ids in the app's frames", () => {
  it("takes both forms in watch, details, older and catchup", () => {
    for (const id of GOOD) for (const f of clientFrames(id)) expect(kind(decode(ClientFeedFrames, JSON.stringify(f))), `${f.t} ${id}`).toBe("ok");
  });
  it("calls anything else malformed (negative control)", () => {
    for (const id of BAD) for (const f of clientFrames(id)) expect(kind(decode(ClientFeedFrames, JSON.stringify(f))), `${f.t} ${JSON.stringify(id)}`).toBe("malformed");
  });
});

describe("worker ids in the hub's frames", () => {
  it("takes both forms in screen, history, messages, details and older", () => {
    for (const id of GOOD) for (const f of serverFrames(id)) expect(kind(decode(ServerFeedFrames, JSON.stringify(f))), `${f.t} ${id}`).toBe("ok");
  });
  it("calls a frame for anything else malformed", () => {
    for (const id of BAD) for (const f of serverFrames(id)) expect(kind(decode(ServerFeedFrames, JSON.stringify(f))), `${f.t} ${JSON.stringify(id)}`).toBe("malformed");
  });
});

describe("the roster's node", () => {
  const entry = { id: "pc.3fa2c1d0.12", name: "alpha", location: "alpha", node: "pc", title: null, lastMessageAt: null, needsYou: false, waitingOn: null, state: "quiet", changedAt: 0 };
  it("keeps each worker's node; an entry from a hub that doesn't say has node \"\"", () => {
    const d = decode(ServerFeedFrames, JSON.stringify({ t: "snapshot", epoch: "e1", seq: 0, workers: [entry, { ...entry, id: "%1", node: undefined }] }));
    expect(d.kind === "ok" && d.frame.t === "snapshot" ? d.frame.workers.map(w => [w.id, w.node]) : null).toEqual([["pc.3fa2c1d0.12", "pc"], ["%1", ""]]);
  });
  it("a worker appearing carries its node", () => {
    const e = decodeEvent({ epoch: "e1", seq: 1, at: 1, body: { type: "WorkerAppeared", worker: { id: "box.0a0a0a0a.3", name: "beta", location: "beta", node: "box" }, state: "quiet", changedAt: 1 } });
    expect(e.kind === "event" && e.event.body.type === "WorkerAppeared" ? e.event.body.worker.node : null).toBe("box");
  });
});

describe("menu escalation ids", () => {
  it("never collide for the same %N on two nodes or two tmux servers, and fit the hub's answer route", () => {
    const ids = ["pc.3fa2c1d0.1", "box.3fa2c1d0.1", "pc.0a0a0a0a.1", "pc.3fa2c1d0.11", "%1"].map(menuEscalationId);
    expect(ids).toEqual(["menu-pc_3fa2c1d0_1", "menu-box_3fa2c1d0_1", "menu-pc_0a0a0a0a_1", "menu-pc_3fa2c1d0_11", "menu-1"]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,80}$/);           // http.ts: /api/escalations/<id>/answer
  });
});
