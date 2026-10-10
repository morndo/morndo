// A side-effecting op's audit row that fleet.db can't take (full, or busy past better-sqlite3's 5 s timeout) is logged,
// and the client still gets the op's own outcome (B6 V21). Before, the write threw after the node had answered and the
// client got 500 "internal error": the hub read that as maybe-sent with no store, so even a definite refusal (nothing
// typed) stayed "uncertain" for good. fleet.db is made full for real: max_page_count at its page count, the last pages
// filled.
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/adapters/log.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { client } from "./helpers/socket-client.ts";

const PANE = "pc.3fa2c1d0.1";

describe("an audit row fleet.db can't take", () => {
  it("leaves a definite refusal definite: 200 with draft_present and the store, and the row that failed is logged", async () => {
    const lines: string[] = [];
    const fleet = await startTestFleet({ log: createLogger({ level: "debug", sink: l => { lines.push(l); } }) });
    const pc = await fleet.online("pc");
    pc.answer = () => ({ ok: false, error: { code: "draft_present", executed: "no", message: "the input box holds a draft" } });
    fleet.db.pragma(`max_page_count = ${fleet.db.pragma("page_count", { simple: true }) as number}`);
    const fill = fleet.db.prepare("INSERT INTO audit (at, actor, action, node, detail) VALUES (0, 'test', 'fill', NULL, '{}')");
    expect(() => { for (;;) fill.run(); }).toThrow(/full/);
    const r = await client(fleet.config.socketPath).raw("/v1/op", {
      method: "POST", headers: { "content-type": "application/json", "x-morndo-client": "hub" },
      body: JSON.stringify({ workerId: PANE, op: "pane.send", args: { workerId: PANE, text: "hi", expect: { server: "3fa2c1d0", window: "api" } }, key: "hub:audit-full", timeoutMs: 5000 }),
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body.toString())).toMatchObject({ ok: false, error: { code: "draft_present", executed: "no" }, store: pc.streamId });
    expect(lines.some(l => l.includes("op.pane.send") && l.includes("could not be recorded"))).toBe(true);
  });
});
