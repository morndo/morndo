import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ServiceHealth } from "@morndo/protocol";
import { SCHEMA_VERSION } from "../src/adapters/migrations.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { client } from "./helpers/socket-client.ts";
import { tempDir } from "./helpers/temp.ts";

const W = "pc.3fa2c1d0.4";

describe("a hold on the fleet", () => {
  it("refuses a send with 503 and executed no, and still answers health, caps, and a revocation", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "hold.json"), JSON.stringify({
      services: ["fleet"], reason: "drain", version: "0.0.0", since: new Date().toISOString(),
    }));
    const fleet = await startTestFleet({ dir });
    const agent = await fleet.online("pc");
    const api = client(fleet.config.socketPath);
    const health = await api.get("/v1/health");
    expect(health?.status).toBe(200);
    expect(ServiceHealth.safeParse(health?.body).success).toBe(true);
    expect(health?.body).toMatchObject({ version: "0.0.0", schema: SCHEMA_VERSION, ready: true });
    expect((await api.get("/v1/caps"))?.status).toBe(200);
    const sent = await api.raw("/v1/op", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: W, op: "pane.send",
        args: { workerId: W, text: "words", expect: { server: "3fa2c1d0", window: "api" } },
        key: "hub:hold",
      }),
    });
    expect(sent.status).toBe(503);
    expect(sent.headers["retry-after"]).toBe("1");
    expect(JSON.parse(sent.body.toString("utf8"))).toMatchObject({
      ok: false, error: { code: "updating", executed: "no" }, store: null, storeSeq: null,
    });
    expect(agent.reqs).toEqual([]);
    expect((await api.post(`/v1/nodes/pc/revoke`))?.status).toBe(200);
  });
});
