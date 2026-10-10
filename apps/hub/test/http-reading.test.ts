// Read marks and mute travel between the principal's devices through the hub (ADR-0008 phase D; O7, O8): a mark from
// one feed is told to every feed, a new feed gets them all after its hello, and an older page is answered (O9).
import type { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import { frameText } from "./http-crash-fixture.ts";

let hub: InProcessHub | null = null;
afterEach(async () => { await hub?.close(); hub = null; });

// Collects every frame of a socket; next(t) waits for the next frame of that type.
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

describe("reading on the hub", () => {
  it("a read mark from one device is told to every device, and the next hello carries it", async () => {
    hub = await startInProcessHub();
    const cookie = await hub.cookie();
    const a = await hub.socket("/api/feed", cookie), b = await hub.socket("/api/feed", cookie);
    const fa = frames(a), fb = frames(b);
    const readingA = fa.next("reading");
    a.send(JSON.stringify({ t: "hello" }));
    expect(await readingA).toEqual({ t: "reading", reads: {}, muted: [] });
    const told = fb.next("read");
    a.send(JSON.stringify({ t: "read", conversation: "builder", at: 1000 }));
    expect(await told).toEqual({ t: "read", conversation: "builder", at: 1000 });
    const mute = fb.next("mute");
    a.send(JSON.stringify({ t: "mute", conversation: "reviewer", muted: true }));
    expect(await mute).toEqual({ t: "mute", conversation: "reviewer", muted: true });
    const c = await hub.socket("/api/feed", cookie);
    const fc = frames(c);
    const readingC = fc.next("reading");
    c.send(JSON.stringify({ t: "hello" }));
    expect(await readingC).toEqual({ t: "reading", reads: { builder: 1000 }, muted: ["reviewer"] });
  });
  it("a read mark the database can't take closes that socket, and the hub goes on (whole-branch review L5)", async () => {
    hub = await startInProcessHub();
    const cookie = await hub.cookie();
    const a = await hub.socket("/api/feed", cookie);
    hub.store.saveReadMark = () => { throw new Error("SQLITE_BUSY: database is locked"); };
    const closed = new Promise<number>(resolve => a.on("close", code => resolve(code)));
    a.send(JSON.stringify({ t: "read", conversation: "builder", at: 1000 }));
    expect(await closed).toBe(1011);
    expect((await fetch(`${hub.base}/api/me`, { headers: { cookie: `__Host-morndo=${cookie}` } })).status).toBe(200);
  });
  it("an older mark changes nothing and tells nobody", async () => {
    hub = await startInProcessHub();
    const cookie = await hub.cookie();
    const a = await hub.socket("/api/feed", cookie);
    const fa = frames(a);
    a.send(JSON.stringify({ t: "read", conversation: "builder", at: 2000 }));
    await fa.next("read");
    a.send(JSON.stringify({ t: "read", conversation: "builder", at: 1000 }));
    await new Promise(r => setTimeout(r, 300));
    expect(fa.seen.filter(m => m.t === "read")).toHaveLength(1);
  });
  it("an older page is answered (here, with no transcript: missing, not the beginning)", async () => {
    hub = await startInProcessHub();
    const a = await hub.socket("/api/feed", await hub.cookie());
    const fa = frames(a);
    const older = fa.next("older");
    a.send(JSON.stringify({ t: "older", worker: "%1", before: "m1" }));
    expect(await older).toEqual({ t: "older", worker: "%1", before: "m1", messages: [], done: false, missing: true });
  });
});
