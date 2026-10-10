// A request target that isn't a valid URL, on an upgrade: the hub refuses it and keeps serving (F2). The hub runs in a
// child process (http-crash-fixture.ts), so a crash fails the assertion instead of the test worker.
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LOGIN, identityStatus, startHub, type Hub } from "./http-crash-fixture.ts";

let hub: Hub | null = null;
afterEach(async () => { await hub?.stop(); hub = null; });

// Sends one raw request; resolves with the response's status line, or "closed" if the connection ended without one.
const raw = (port: number, lines: string[]) => new Promise<string>(resolve => {
  let got = "";
  const s = connect(port, "127.0.0.1", () => s.write(lines.join("\r\n") + "\r\n\r\n"));
  s.on("data", d => { got += String(d); });
  s.on("error", () => {});
  s.on("close", () => resolve(got.split("\r\n")[0] || "closed"));
  s.setTimeout(5000, () => s.destroy());
});

describe("a request target that isn't a URL", () => {
  it("on a WebSocket upgrade, with no identity or session, gets a 4xx or a close, and the hub still answers", async () => {
    hub = await startHub();
    const status = await raw(hub.port, ["GET //[ HTTP/1.1", "Host: hub", "Upgrade: websocket", "Connection: Upgrade",
      "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="]);
    expect(status).toMatch(/^(HTTP\/1\.1 4\d\d |closed$)/);
    expect(await identityStatus(hub), hub.output()).toBe(200);
  }, 15_000);
  it("on a plain request gets an error response, and the hub still answers", async () => {
    hub = await startHub();
    expect(await raw(hub.port, ["GET //[ HTTP/1.1", "Host: hub", `tailscale-user-login: ${LOGIN}`, "Connection: close"])).toMatch(/^HTTP\/1\.1 [45]\d\d /);
    expect(await identityStatus(hub), hub.output()).toBe(200);
  }, 15_000);
});
