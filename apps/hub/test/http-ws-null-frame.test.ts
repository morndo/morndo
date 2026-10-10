// The text frame `null` is valid JSON but not a message object: the hub ignores or refuses it and keeps serving (F5).
// The hub runs in a child process (http-crash-fixture.ts), so a crash fails the assertion instead of the test worker.
import { afterEach, describe, expect, it } from "vitest";
import { identityStatus, nextOutcome, openSocket, startHub, type Hub } from "./http-crash-fixture.ts";

let hub: Hub | null = null;
afterEach(async () => { await hub?.stop(); hub = null; });

describe("a WebSocket message that is JSON null", () => {
  it("on the live feed: the hub still answers", async () => {
    hub = await startHub();
    const ws = await openSocket(hub, "/api/feed");
    const outcome = nextOutcome(ws);
    ws.send("null");
    ws.send(JSON.stringify({ t: "hello" }));                              // answered with a snapshot if the socket lives on
    expect(await outcome, hub.output()).toMatch(/^(message \{"t":"snapshot"|close (1003|1008|4\d{3}))/);
    expect(await identityStatus(hub), hub.output()).toBe(200);
  }, 15_000);
  it("on a watch-only terminal socket: the hub still answers", async () => {
    hub = await startHub();
    const ws = await openSocket(hub, "/api/terminal?pane=%251", true);
    const closed = new Promise<number>(resolve => ws.on("close", code => resolve(code)));
    ws.send("null");
    ws.send(JSON.stringify({ t: "keys", data: "x" }));                    // refused with 4403 if the socket lives on
    const code = await closed;
    expect([1003, 1008, 4403], hub.output()).toContain(code);
    expect(await identityStatus(hub), hub.output()).toBe(200);
  }, 15_000);
});
