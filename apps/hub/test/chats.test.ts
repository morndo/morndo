// The phone's chat list, digest and presence on the hub (ADR-0011; H1, H4, H5): the read models, the per-device last
// activity, and the frames on the feed socket. Synthetic data.
import type { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "@morndo/domain";
import { ServerFeedFrames, decode } from "@morndo/protocol";
import { PREVIEW_CHARS, chats, digest } from "../src/application/chats.ts";
import { PresenceService } from "../src/application/presence-service.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import { frameText } from "./http-crash-fixture.ts";

const msg = (id: string, at: number, o: Partial<Message> = {}): Message => ({ id, at, author: { kind: "agent", name: "w" }, kind: "text", text: `m ${id}`, ...o });
const sources = (history: Record<string, Message[]>, reads: Record<string, number> = {}, muted: string[] = []) => ({
  workers: () => Object.keys(history).map((id, i) => ({ id, name: ["builder", "manager", "reviewer"][i] ?? id })),
  history: (id: string) => history[id] ?? [],
  reads: () => reads,
  muted: () => muted,
});

describe("chats (H1)", () => {
  it("per worker: the preview, the latest words, what matters after the mark, the last time", () => {
    const rows = chats(sources({
      "%1": [msg("a", 1, { text: "Looking." }), msg("t", 2, { kind: "activity", tools: ["Bash"] }), msg("b", 3, { text: "Done." }), msg("y", 4, { author: { kind: "principal", name: "You" }, text: "thanks" })],
      "%2": [],
    }, { builder: 1 }));
    expect(rows[0]).toMatchObject({ worker: "%1", name: "builder", unread: 1, lastAt: 4 });
    expect(rows[0]?.last?.id).toBe("y");
    expect(rows[0]?.answer?.id).toBe("b");
    expect(rows[0]?.repliedAt).toBe(4);
    expect(rows[1]).toMatchObject({ name: "manager", last: null, answer: null, unread: 0, lastAt: null, repliedAt: null });
  });
  it("repliedAt is his own latest message when a later message is the preview", () => {
    const rows = chats(sources({ "%1": [msg("y", 2, { author: { kind: "principal", name: "You" }, text: "yes" }), msg("f", 5, { text: "still working" })] }));
    expect(rows[0]?.last?.id).toBe("f");
    expect(rows[0]?.repliedAt).toBe(2);
  });
  it("cuts a long answer for the row, and the frame decodes in the app as it is", () => {
    const rows = chats(sources({ "%1": [msg("a", 1, { text: "x".repeat(5000) })] }));
    expect(rows[0]?.answer?.text).toHaveLength(PREVIEW_CHARS);
    const d = decode(ServerFeedFrames, JSON.stringify({ t: "chats", chats: rows }));
    expect(d.kind === "ok" && d.frame.t === "chats" ? d.frame.chats : null).toEqual(rows);
  });
});

describe("digest (H5)", () => {
  it("what each unmuted conversation brought since he left, whatever its read mark", () => {
    const all = digest(sources({ "%1": [msg("a", 100), msg("b", 900)], "%2": [msg("m", 950)], "%3": [msg("r", 50)] }, { builder: 2000 }, ["manager"]), 500);
    expect(all.map(c => [c.name, c.count, c.mark])).toEqual([["builder", 1, 500]]);
  });
});

describe("presence (H4)", () => {
  const store = () => { const s: Record<string, unknown> = {}; return { s, setting: <T>(k: string) => (s[k] ?? null) as T | null, saveSetting: (k: string, v: unknown) => { s[k] = structuredClone(v); } }; };
  it("his last activity on any other device: now while one attends, else the latest kept; never this device's own", () => {
    let now = 1000;
    const st = store();
    const p = new PresenceService(st, () => now);
    expect(p.elsewhere("phone")).toBeNull();
    p.attending("c1", "desk", true);
    now = 5000;
    expect(p.elsewhere("phone")).toBe(5000);                  // the desk still attends
    expect(p.elsewhere("desk")).toBeNull();                   // its own activity isn't "elsewhere"
    p.attending("c1", "desk", false);                         // two minutes without input: active until now
    now = 9000;
    expect(p.elsewhere("phone")).toBe(5000);
    p.attending("c2", "phone", true);
    p.left("c2");                                             // the socket closed: active until then
    expect(new PresenceService(st, () => now).elsewhere("desk")).toBe(9000);   // kept across a restart
  });
  it("a report goes stale after 2 minutes without renewal; a 'not attending' that never attended marks nothing", () => {
    let now = 0;
    const p = new PresenceService(store(), () => now);
    p.attending("c1", "desk", true);
    now = 3 * 60_000;
    expect(p.elsewhere("phone")).toBe(0);
    p.attending("c9", "tablet", false);
    expect(p.elsewhere("phone")).toBe(0);
  });
  it("a reconnect of the same layout drops that layout's earlier socket; the other layout still counts", () => {
    let now = 1000;
    const p = new PresenceService(store(), () => now);
    p.hello("old-phone", "ep", "phone");
    p.attending("old-phone", "ep", true);
    p.hello("desk", "ep", "desk");
    p.attending("desk", "ep", true);
    now = 4000;
    p.hello("new-phone", "ep", "phone");
    expect(p.elsewhere("ep", "new-phone")).toBe(4000);
    const only = new PresenceService(store(), () => now);
    only.hello("old", "ep", "phone");
    only.attending("old", "ep", true);
    only.hello("new", "ep", "phone");
    expect(only.elsewhere("ep", "new")).toBeNull();
  });
  it("another layout on the same endpoint counts; this connection's own report does not", () => {
    let now = 1000;
    const p = new PresenceService(store(), () => now);
    p.attending("phone-layout", "ep", true);
    p.attending("desk-layout", "ep", true);
    now = 4000;
    expect(p.elsewhere("ep", "phone-layout")).toBe(4000);
    expect(p.elsewhere("ep")).toBeNull();
  });
});

let hub: InProcessHub | null = null;
afterEach(async () => { await hub?.close(); hub = null; });
const next = (ws: WebSocket, t: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
  const on = (d: unknown) => { const m = JSON.parse(frameText(d as Buffer)) as Record<string, unknown>; if (m.t === t) { ws.off("message", on); resolve(m); } };
  ws.on("message", on);
  setTimeout(() => reject(new Error(`no ${t} frame`)), 3000);
});

describe("the feed socket (ADR-0011)", () => {
  it("a hello says when he was last active elsewhere; one device's activity is the other's 'elsewhere'", async () => {
    hub = await startInProcessHub();
    const a = await hub.socket("/api/feed", await hub.cookie()), b = await hub.socket("/api/feed", await hub.cookie());
    const first = next(a, "presence");
    a.send(JSON.stringify({ t: "hello" }));
    expect(await first).toEqual({ t: "presence", elsewhere: null });
    b.send(JSON.stringify({ t: "visible", v: true }));
    await new Promise(r => setTimeout(r, 100));
    const asked = next(a, "presence");
    a.send(JSON.stringify({ t: "presence" }));
    expect(typeof (await asked).elsewhere).toBe("number");
    const own = next(b, "presence");
    b.send(JSON.stringify({ t: "presence" }));
    expect(await own).toEqual({ t: "presence", elsewhere: null });   // a has never been active
  });
  it("answers chats and a digest (no workers in this hub), and closes on a malformed digest frame", async () => {
    hub = await startInProcessHub();
    const a = await hub.socket("/api/feed", await hub.cookie());
    const c = next(a, "chats");
    a.send(JSON.stringify({ t: "chats" }));
    expect(await c).toEqual({ t: "chats", chats: [] });
    const d = next(a, "digest");
    a.send(JSON.stringify({ t: "digest", since: 123 }));
    expect(await d).toEqual({ t: "digest", since: 123, conversations: [] });
    const closed = new Promise<number>(resolve => a.on("close", code => resolve(code)));
    a.send(JSON.stringify({ t: "digest", since: "yesterday" }));
    expect(await closed).toBe(1003);
  });
});
