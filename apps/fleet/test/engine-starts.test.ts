// lane.start by role or engine through the fleet (reliable lanes §3.3): the args reach the node as checked (a role and an
// engine together never do), the audit keeps what was named, why, and what ran, and a start the resolver filled only after
// passing over its first choice raises one engine_fallback alert.
import { describe, expect, it } from "vitest";
import { startTestFleet } from "./helpers/fleet.ts";
import { client } from "./helpers/socket-client.ts";

describe("lane starts on an engine", () => {
  it("audits the role, the engine that ran and the reason, and raises engine_fallback when the resolver passed over others", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    const skipped = [{ entry: "acme:large-2@high", reason: "acme: not signed in" }];
    pc.answer = req => req.op === "lane.start"
      ? { ok: true, result: { workerId: "pc.3fa2c1d0.7", engine: { entry: (req.args as { name: string }).name === "w1" ? "beta:small-1" : "acme:large-2@high", role: "implement", ...((req.args as { name: string }).name === "w1" ? { skipped } : {}) } } }
      : { ok: true, result: {} };
    const api = client(fleet.config.socketPath);
    const first = await api.post("/v1/op", { node: "pc", op: "lane.start", args: { name: "w1", cwd: "/w", role: "implement" }, key: "lanes:start-1" });
    expect(first?.body).toMatchObject({ ok: true, result: { engine: { entry: "beta:small-1", skipped } } });
    expect(pc.reqs.at(-1)?.args).toEqual({ name: "w1", cwd: "/w", role: "implement" });
    await api.post("/v1/op", { node: "pc", op: "lane.start", args: { name: "w2", cwd: "/w", role: "implement" }, key: "lanes:start-2" });
    const alerts = fleet.audit.of("alert.engine_fallback");
    expect(alerts.map(a => [a.node, a.detail])).toEqual([["pc", { lane: "w1", role: "implement", entry: "beta:small-1", skipped }]]);   // w2 ran its first choice
    await api.post("/v1/op", { node: "pc", op: "lane.start", args: { name: "w3", cwd: "/w", engine: "acme:large-2@high", reason: "the owner asked for acme" }, key: "lanes:start-3" });
    const audited = fleet.audit.of("op.lane.start").map(e => e.detail);
    expect(audited[0]).toMatchObject({ role: "implement", ran: "beta:small-1", outcome: "ok" });
    expect(audited[2]).toMatchObject({ engine: "acme:large-2@high", reason: "the owner asked for acme", outcome: "ok" });
  });

  it("refuses a role and an engine together, and an engine that isn't provider:model, before anything is sent", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    const api = client(fleet.config.socketPath);
    for (const args of [
      { name: "w1", cwd: "/w", role: "implement", engine: "acme:large-2" },
      { name: "w1", cwd: "/w", engine: "acme" },
      { name: "w1", cwd: "/w", engine: "-x:y" },
      { name: "w1", cwd: "/w", role: "Implement Backend" },
      { name: "w1", cwd: "/w", engine: "acme:large-2", reason: "two\nlines" },
    ]) {
      const r = await api.post("/v1/op", { node: "pc", op: "lane.start", args, key: `lanes:bad-${Math.random()}` });
      expect(r?.body, JSON.stringify(args)).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    }
    expect(pc.reqs.filter(q => q.op === "lane.start")).toEqual([]);
  });
});
