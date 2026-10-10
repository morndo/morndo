// Frames the WebSocket layer rejects (over maxPayload, invalid UTF-8, an unknown opcode) end that one connection; the
// hub keeps serving (F4). The hub runs in a child process (http-crash-fixture.ts), so a crash fails the assertion.
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { identityStatus, nextOutcome, openSocket, startHub, type Hub } from "./http-crash-fixture.ts";

let hub: Hub | null = null;
afterEach(async () => { await hub?.stop(); hub = null; });

describe("a frame the WebSocket layer rejects", () => {
  it("a live-feed message over 16 KiB closes that socket, and the hub still answers", async () => {
    hub = await startHub();
    const ws = await openSocket(hub, "/api/feed");
    const outcome = nextOutcome(ws);
    ws.send(JSON.stringify({ t: "hello", pad: "x".repeat(17 * 1024) }));
    expect(await outcome).toMatch(/^close /);
    expect(await identityStatus(hub), hub.output()).toBe(200);
  }, 15_000);
  it("a live-feed text frame with invalid UTF-8 closes that socket, and the hub still answers", async () => {
    hub = await startHub();
    const ws = await openSocket(hub, "/api/feed");
    const outcome = nextOutcome(ws);
    ws.send(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), { binary: false });
    expect(await outcome).toMatch(/^close /);
    expect(await identityStatus(hub), hub.output()).toBe(200);
  }, 15_000);
  it("a live-feed frame with a reserved opcode closes that socket, and the hub still answers", async () => {
    hub = await startHub();
    const ws = await openSocket(hub, "/api/feed");
    const outcome = nextOutcome(ws);
    // FIN + opcode 0x3 (reserved, RFC 6455 5.2), masked, empty payload: written below the client library, which can't send it.
    (ws as unknown as { _socket: Socket })._socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]));
    expect(await outcome).toMatch(/^close /);
    expect(await identityStatus(hub), hub.output()).toBe(200);
  }, 15_000);
  it("pasting over 1 MiB into a controlled terminal closes that socket, and the hub still answers", async () => {
    hub = await startHub();
    const ws = await openSocket(hub, "/api/terminal?pane=%251&control=1", true);
    const outcome = new Promise<string>(resolve => ws.on("close", code => resolve(`close ${code}`)));
    ws.send(JSON.stringify({ t: "keys", data: "a".repeat(1 << 20) }));     // what TerminalView sends for one xterm paste
    expect(await outcome).toMatch(/^close /);
    expect(await identityStatus(hub), hub.output()).toBe(200);
  }, 15_000);
});
