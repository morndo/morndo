// Catch-up on the hub (ADR-0009; C4–C7): what is new per Conversation since its Read mark, muted ones left out unless
// asked for, the frames on the feed socket, and "last caught up" told to every device. Synthetic data.
import type { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "@morndo/domain";
import { ServerFeedFrames, decode } from "@morndo/protocol";
import { catchUp, type CatchUpSources } from "../src/application/catchup.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import { frameText } from "./http-crash-fixture.ts";

const msg = (id: string, at: number, o: Partial<Message> = {}): Message => ({ id, at, author: { kind: "agent", name: "w" }, kind: "text", text: `m ${id}`, ...o });
function sources(o: Partial<CatchUpSources> = {}): CatchUpSources {
  const history: Record<string, Message[]> = {
    "%1": [msg("b1", 100), msg("b2", 200, { text: "STATUS: DONE. Built." })],
    "%2": [msg("r1", 100)],
    "%3": [msg("m1", 300)],
    "%4": [],
  };
  return {
    workers: () => [{ id: "%1", name: "builder" }, { id: "%2", name: "reviewer" }, { id: "%3", name: "manager" }, { id: "%4", name: "idle" }],
    history: id => history[id] ?? [],
    reads: () => ({ builder: 100, reviewer: 100 }),
    muted: () => ["manager"],
    ...o,
  };
}

describe("catchUp (C5)", () => {
  it("every unmuted conversation with something after its mark, with the counts and the claim", () => {
    const all = catchUp(sources());
    expect(all.map(c => c.name)).toEqual(["builder"]);              // reviewer read to the end, manager muted, idle empty
    expect(all[0]).toMatchObject({ worker: "%1", name: "builder", mark: 100, count: 1, lastAt: 200, claim: "says_done" });
    expect(all[0]?.messages.map(m => m.id)).toEqual(["b2"]);
  });
  it("asked for by name: that one, even muted or with nothing new", () => {
    expect(catchUp(sources(), "%3").map(c => [c.name, c.count])).toEqual([["manager", 1]]);
    expect(catchUp(sources(), "%2").map(c => [c.name, c.count])).toEqual([["reviewer", 0]]);
    expect(catchUp(sources(), "%9")).toEqual([]);
  });
  it("keeps the newest messages only, and counts all of them", () => {
    const many = Array.from({ length: 50 }, (_, i) => msg(`x${i}`, 1000 + i));
    const [c] = catchUp(sources({ history: () => many, workers: () => [{ id: "%1", name: "builder" }] }), undefined, 30);
    expect(c?.messages).toHaveLength(30);
    expect(c?.messages[0]?.id).toBe("x20");
    expect(c?.count).toBe(50);
  });
  it("what it gives decodes in the app as it is (the wire contract)", () => {
    const d = decode(ServerFeedFrames, JSON.stringify({ t: "catchup", conversations: catchUp(sources()) }));
    expect(d.kind).toBe("ok");
    expect(d.kind === "ok" && d.frame.t === "catchup" ? d.frame.conversations : null).toEqual(catchUp(sources()));
  });
});

let hub: InProcessHub | null = null;
afterEach(async () => { await hub?.close(); hub = null; });
function frames(ws: WebSocket) {
  const seen: Record<string, unknown>[] = [];
  const waiters: { t: string; resolve: (m: Record<string, unknown>) => void }[] = [];
  ws.on("message", d => {
    const m = JSON.parse(frameText(d)) as Record<string, unknown>;
    seen.push(m);
    const i = waiters.findIndex(w => w.t === m.t);
    if (i !== -1) { waiters[i]?.resolve(m); waiters.splice(i, 1); }
  });
  return {
    seen,
    next: (t: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
      waiters.push({ t, resolve });
      setTimeout(() => reject(new Error(`no ${t} frame`)), 3000);
    }),
  };
}

describe("the feed socket (C7)", () => {
  it("a hello says when he last caught up; the end of a run is told to every device and moves no read mark", async () => {
    hub = await startInProcessHub();
    const cookie = await hub.cookie();
    const a = await hub.socket("/api/feed", cookie), b = await hub.socket("/api/feed", cookie);
    const fa = frames(a), fb = frames(b);
    const first = fa.next("caught_up");
    a.send(JSON.stringify({ t: "hello" }));
    expect(await first).toEqual({ t: "caught_up", at: null });
    const told = fb.next("caught_up");
    const at = Date.now() - 1000;
    a.send(JSON.stringify({ t: "caught_up", at }));
    expect(await told).toEqual({ t: "caught_up", at });
    expect(hub.store.readMarks()).toEqual({});
    const answer = fa.next("catchup");
    a.send(JSON.stringify({ t: "catchup" }));
    expect(await answer).toEqual({ t: "catchup", conversations: [] });   // no workers in this hub
    const one = fa.next("catchup");
    a.send(JSON.stringify({ t: "catchup", worker: "%1" }));
    expect(await one).toEqual({ t: "catchup", only: "%1", conversations: [] });
  });
  it("a malformed catch-up frame closes the socket (1003), as any other", async () => {
    hub = await startInProcessHub();
    const a = await hub.socket("/api/feed", await hub.cookie());
    const closed = new Promise<number>(resolve => a.on("close", code => resolve(code)));
    a.send(JSON.stringify({ t: "catchup", worker: "not a pane" }));
    expect(await closed).toBe(1003);
  });
});

describe("two panes with one name (review of PR #7, finding 4)", () => {
  it("the catch-up describes the pane with the latest message, as the card does", () => {
    const all = catchUp(sources({
      workers: () => [{ id: "%1", name: "builder" }, { id: "%2", name: "builder" }],
      history: id => (id === "%1" ? [msg("a", 1200)] : [msg("b", 1300)]),
      reads: () => ({ builder: 1000 }), muted: () => [],
    }));
    expect(all.map(x => [x.worker, x.lastAt])).toEqual([["%2", 1300]]);
  });
});

// The product lane's cycle, 2026-10-04: nothing can set "checked" (the hub reads no verdicts), so no such state reaches
// the app: a claim other than "says done" reads as none.
describe("no 'checked' claim", () => {
  it("a catch-up frame claiming 'checked' decodes as no claim", () => {
    const [c] = catchUp(sources());
    const d = decode(ServerFeedFrames, JSON.stringify({ t: "catchup", conversations: [{ ...c, claim: "checked" }] }));
    expect(d.kind === "ok" && d.frame.t === "catchup" ? d.frame.conversations[0]?.claim : "undecoded").toBeNull();
  });
});
