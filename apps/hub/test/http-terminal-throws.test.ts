// A throw inside the terminal socket's handlers (ADR-0008, A5): the terminal adapter failing on keys or on a frame must
// not become an unhandled rejection, which ends a Node 24 process. The hub runs in a child process
// (http-crash-fixture.ts), so a crash fails the assertion instead of the test worker.
import { afterEach, describe, expect, it } from "vitest";
import { frameText, identityStatus, openCollecting, openSocket, startHub, type Hub } from "./http-crash-fixture.ts";

let hub: Hub | null = null;
afterEach(async () => { await hub?.stop(); hub = null; });
const settle = (ms: number) => new Promise(r => setTimeout(r, ms));
// The terminal frames among a socket's messages, each as its text.
const framesOf = (messages: string[]) => messages.map(m => JSON.parse(m) as { t: string; lines?: string[] })
  .filter(m => m.t === "frame").map(m => (m.lines ?? []).join("\n"));

describe("the terminal adapter throws", () => {
  it("on keys under control: the connection is told or closed, and the hub still answers", async () => {
    hub = await startHub("keys-throw");
    const ws = await openSocket(hub, "/api/terminal?pane=%251&control=1", true);
    const seen: string[] = [];
    ws.on("message", d => seen.push(frameText(d)));
    ws.send(JSON.stringify({ t: "keys", data: "ls\r" }));
    await settle(800);
    expect(hub.exitCode(), hub.output()).toBeNull();
    expect(await identityStatus(hub), hub.output()).toBe(200);
    expect(seen.some(m => m.includes("keys_refused")) || ws.readyState !== ws.OPEN).toBe(true);
  }, 20_000);
  it("key presses reach the pane in the order typed, even when one is slow to land", async () => {
    hub = await startHub("keys-slow-first");
    const ws = await openSocket(hub, "/api/terminal?pane=%251&control=1", true);
    for (const k of ["e", "c", "h", "o"]) ws.send(JSON.stringify({ t: "keys", data: k }));
    await settle(1200);
    expect(hub.output().match(/KEYS \w/g), hub.output()).toEqual(["KEYS e", "KEYS c", "KEYS h", "KEYS o"]);   // not "c h o e"
  }, 20_000);
  it("keys whose node may have typed them (its answer lost): the app is told keys_uncertain, never keys_refused", async () => {
    hub = await startHub("keys-uncertain");
    const ws = await openSocket(hub, "/api/terminal?pane=%251&control=1", true);
    const seen: string[] = [];
    ws.on("message", d => seen.push(frameText(d)));
    ws.send(JSON.stringify({ t: "keys", data: "y" }));
    await settle(800);
    expect(seen.filter(m => m.includes("keys_"))).toEqual([JSON.stringify({ t: "error", error: "keys_uncertain" })]);
  }, 20_000);

  // Final review M5: a frame its node can't give now ("unavailable": a timeout, the node offline, the fleet unreachable)
  // keeps the view open, asked again on the next tick; only a pane that is gone closes it (4404).
  it("a frame that is unavailable for a while: the view stays open and shows the next frame; a pane gone closes it", async () => {
    hub = await startHub("frame-unavailable");
    const { ws, messages } = await openCollecting(hub, "/api/terminal?pane=%251");
    const closed = new Promise<number>(resolve => ws.on("close", code => resolve(code)));
    // Five unavailable answers in a row back off to 160, 320, 640, 1280 and 2000 ms between asks: about 4.4 s.
    expect(await Promise.race([closed, settle(10_000).then(() => -1)])).toBe(4404);
    expect(framesOf(messages)).toEqual(["$ ", "$ back"]);             // the frame after the unavailable ones arrived
    expect(hub.exitCode(), hub.output()).toBeNull();
  }, 20_000);

  // The follow-up to M5: while its node is offline, an open view asks less and less often (from 160 ms, doubling, at most
  // every 2 s), not every 80 ms; the first frame that comes back puts it back to every 80 ms.
  it("a node offline for a while: asked less often, doubling up to 2 s, and every 80 ms again once a frame comes back", async () => {
    hub = await startHub("frame-offline");
    const { ws, messages } = await openCollecting(hub, "/api/terminal?pane=%251");
    const closed = new Promise<number>(resolve => ws.on("close", code => resolve(code)));
    expect(await Promise.race([closed, settle(12_000).then(() => -1)])).toBe(4404);
    // Each ask as the fixture logs it: its time since the first, and what it answered (first, offline, back, gone).
    const log = [...hub.output().matchAll(/FRAME (\d+) (\w+)/g)].map(m => ({ t: Number(m[1]), phase: m[2] ?? "" }));
    const asked = log.map(a => a.t);
    const offline = log.filter(a => a.phase === "offline").map(a => a.t);
    const gaps = offline.slice(1).map((t, i) => t - (offline[i] ?? 0));
    // At 80 ms it would ask about 30 times in those 2.5 s; backing off, at most 6.
    expect(offline.length, `asked at ${asked.join(", ")}`).toBeLessThanOrEqual(6);
    expect(gaps.length, `asked at ${asked.join(", ")}`).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i], `asked at ${asked.join(", ")}`).toBeGreaterThan((gaps[i - 1] ?? 0) * 1.3);   // doubling
    const all = asked.slice(1).map((t, i) => t - (asked[i] ?? 0));
    expect(Math.max(...all), `asked at ${asked.join(", ")}`).toBeLessThan(2000 + 400);              // never more than 2 s apart
    // Back: the asks the node answered with a frame again, however late the backed-off ask that found it came. After
    // the first of them, every 80 ms again (a few ticks' slack on a busy machine).
    const back = log.filter(a => a.phase === "back").map(a => a.t);
    const backGaps = back.slice(1).map((t, i) => t - (back[i] ?? 0));
    expect(backGaps.length, `asked at ${asked.join(", ")}`).toBeGreaterThanOrEqual(3);
    expect(Math.max(...backGaps.slice(0, 3)), `asked at ${asked.join(", ")}`).toBeLessThan(400);
    expect(framesOf(messages)).toEqual(["$ ", "$ back"]);
    expect(hub.exitCode(), hub.output()).toBeNull();
  }, 30_000);

  it("on a frame: the connection closes, and the hub still answers", async () => {
    hub = await startHub("frame-throw");
    const ws = await openSocket(hub, "/api/terminal?pane=%251", true);
    const closed = new Promise<number>(resolve => ws.on("close", code => resolve(code)));
    expect(await Promise.race([closed, settle(3000).then(() => -1)])).toBe(1011);
    expect(hub.exitCode(), hub.output()).toBeNull();
    expect(await identityStatus(hub), hub.output()).toBe(200);
  }, 20_000);
});
