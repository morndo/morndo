// Stopping the hub doesn't wait for a browser's open but silent connection (a preconnect sends nothing until it is
// used): before, server.close() waited for Node's 60 s header timeout, so a restart of the service hung a minute.
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { startInProcessHub } from "./inprocess-hub.ts";

describe("stopping the hub", () => {
  it("closes at once even with a connection that has sent nothing yet", async () => {
    const hub = await startInProcessHub();
    const port = Number(new URL(hub.base).port);
    const silent = connect(port, "127.0.0.1");
    await new Promise<void>(r => silent.once("connect", () => r()));
    const started = Date.now();
    await hub.close();
    expect(Date.now() - started).toBeLessThan(3000);
    silent.destroy();
  }, 20_000);
});
