// An op error with a code this hub doesn't know (a newer fleet's) reads as the protocol reads it: "internal", "maybe",
// and the answer keeps its store, so a send in doubt can still be settled with op.status. Before, it was thrown away as
// "not an op answer" and the send stayed uncertain for ever (RU3).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FleetClient } from "../src/adapters/fleet-client.ts";

const STORE = "11111111-1111-4111-8111-111111111111";
let dir: string;
let server: Server;
const answer = (error: unknown) => new Promise<FleetClient>(resolve => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error, store: STORE, storeSeq: 7 })); });
  });
  server.listen(join(dir, "f.sock"), () => resolve(new FleetClient(join(dir, "f.sock"))));
});
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-unknown-code-")); });
afterEach(() => { server?.close(); rmSync(dir, { recursive: true, force: true }); });

const send = (c: FleetClient) => c.op({ workerId: "n1.0123abcd.1" }, "pane.send", { workerId: "n1.0123abcd.1", text: "x", expect: { server: "0123abcd", window: "w" } }, { key: "hub:k" });

describe("an op error from the fleet", () => {
  it("with a code this hub doesn't know reads as internal and maybe, and keeps its store", async () => {
    const r = await send(await answer({ code: "new_code", executed: "no", message: "refused" }));
    expect(r).toEqual({ ok: false, error: { code: "internal", executed: "maybe", message: "refused" }, store: STORE, storeSeq: 7 });
  });
  it("with a known code keeps its code and its executed (negative control)", async () => {
    const r = await send(await answer({ code: "draft_present", executed: "no", message: "a draft" }));
    expect(r).toMatchObject({ ok: false, error: { code: "draft_present", executed: "no" } });
  });
  it("that is not an error at all is still not an op answer", async () => {
    await expect(send(await answer({ code: 5, executed: "no" }))).rejects.toThrow(/not an op answer/);
  });
});
