// The hub pings every socket it serves and terminates the ones that stop answering (ADR-0008, phase B): today only
// the feed was pinged, so a dead terminal or desktop socket lived on. ws answers pings by itself unless told not to
// (autoPong: false), which here stands in for a peer that went away without closing.
import { afterEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

let hub: InProcessHub | null = null;
afterEach(async () => { await hub?.close(); hub = null; });
const closedWithin = (ws: import("ws").WebSocket, ms: number) =>
  new Promise<number | null>(resolve => { const t = setTimeout(() => resolve(null), ms); ws.on("close", code => { clearTimeout(t); resolve(code); }); });

describe("the hub's heartbeat", () => {
  it("terminates a terminal socket that stops answering pings", async () => {
    hub = await startInProcessHub({ heartbeatMs: 150 });
    const ws = await hub.socket("/api/terminal?pane=%251", await hub.cookie(), { autoPong: false });
    expect(await closedWithin(ws, 3000)).toBe(1006);                    // terminated, no close frame
  });
  it("keeps a terminal socket that answers", async () => {
    hub = await startInProcessHub({ heartbeatMs: 150 });
    const ws = await hub.socket("/api/terminal?pane=%251", await hub.cookie());
    expect(await closedWithin(ws, 1000)).toBeNull();
    ws.close();
  });
  it("keeps a remote socket whose pongs are late but which keeps sending (review L5: pongs queue behind desktop frames)", async () => {
    hub = await startInProcessHub({ heartbeatMs: 150 });
    const ws = await hub.socket("/api/terminal?pane=%251", await hub.cookie(), { autoPong: false });
    const chatter = setInterval(() => ws.send(JSON.stringify({ t: "still-here" })), 50);   // ignored as unknown, but heard
    try { expect(await closedWithin(ws, 1000)).toBeNull(); }
    finally { clearInterval(chatter); ws.close(); }
  });
  it("terminates a feed socket that stops answering pings (as before, now at the same interval)", async () => {
    hub = await startInProcessHub({ heartbeatMs: 150 });
    const ws = await hub.socket("/api/feed", await hub.cookie(), { autoPong: false });
    expect(await closedWithin(ws, 3000)).toBe(1006);
  });
});
