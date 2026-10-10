// The hub's job grant (ADR-0017 §6). The token is checked the way a board call is. The answer is the lane and the
// token's hash. A worker token for another lane, and the manager token for a lane that is not the manager's, are refused.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

let hub: InProcessHub;
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const post = (token: string, lane: string, body: unknown) => fetch(`${hub.base}/api/agent/jobs/grant`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-morndo-lane": lane },
  body: JSON.stringify(body),
});

beforeEach(async () => { hub = await startInProcessHub(); });
afterEach(async () => { await hub.close(); });

describe("job grant", () => {
  it("returns the hash for the lane the token is acting as, and refuses another lane", async () => {
    const worker = hub.agents.issue("lanes", "worker").secret;
    const manager = hub.agents.issue("manager", "manager").secret;
    const ok = await post(worker, "builder", { lane: "builder", id: "job-1", jobClass: "default", notify: "lane:builder", cwdHash: "ab".repeat(32) });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { ok: boolean; lane: string; hash: string; command?: string };
    expect(body).toEqual({ ok: true, lane: "builder", hash: hash(worker) });
    expect(JSON.stringify(body)).not.toContain(worker);
    expect((await post(worker, "builder", { lane: "other", id: "job-1" })).status).toBe(403);
    expect((await post(manager, "manager", { lane: "builder", id: "job-1" })).status).toBe(403);
    expect((await post(worker, "builder", { lane: "builder", command: ["echo"] })).status).toBe(400);
    hub.agents.revoke(hub.agents.list().find(token => token.role === "worker")?.id ?? "");
    expect((await post(worker, "builder", { lane: "builder" })).status).toBe(401);
  });
});