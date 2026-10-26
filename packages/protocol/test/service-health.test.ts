// The node's status.json as an updater reads it (service-health.ts, design §6.3): beside the fields the agent has
// always written, its in-flight work, one item per keyed op — the thing a restart would interrupt. An older agent's
// file has none, which the updater takes as no_answer rather than as quiet, so the field is optional but its absence
// says something.
import { describe, expect, it } from "vitest";
import { NodeStatusHealth, ServiceHealth } from "../src/service-health.ts";

const status = (over: Record<string, unknown> = {}) => ({
  version: "0.5.0", ready: true, state: "online", node: "pc", instanceId: "0d1e2f3a-1111-4222-8333-444455556666",
  pid: 4242, since: 1_762_000_000_000, connEpoch: 7, lastClose: null, retryInMs: null, spoolDepth: 0, drops: 0,
  ...over,
});
const item = (id: string) => ({ kind: "pane.send", id });

describe("NodeStatusHealth", () => {
  it("carries a service's acknowledgement of the hold, as a boolean or not at all", () => {
    expect(NodeStatusHealth.safeParse(status({ held: true })).success).toBe(true);
    expect(ServiceHealth.safeParse({ version: "0.2.0", schema: 3, ready: true, held: false, inFlight: [] }).success).toBe(true);
    expect(ServiceHealth.safeParse({ version: "0.2.0", schema: 3, ready: true, held: "yes", inFlight: [] }).success).toBe(false);
  });
  it("accepts the agent's status with inFlight and one without (an older agent)", () => {
    expect(NodeStatusHealth.safeParse(status({ inFlight: [item("hub:1"), { kind: "lane.start", id: "hub:2" }] })).success).toBe(true);
    expect(NodeStatusHealth.safeParse(status()).success).toBe(true);
  });
  it("refuses 101 items (the cap the agent writes), taking 100, and an item that does not fit", () => {
    expect(NodeStatusHealth.safeParse(status({ inFlight: Array.from({ length: 100 }, (_, i) => item(`hub:${i}`)) })).success).toBe(true);
    expect(NodeStatusHealth.safeParse(status({ inFlight: Array.from({ length: 101 }, (_, i) => item(`hub:${i}`)) })).success).toBe(false);
    expect(NodeStatusHealth.safeParse(status({ inFlight: [{ kind: "", id: "hub:x" }] })).success).toBe(false);
    expect(NodeStatusHealth.safeParse(status({ inFlight: [{ kind: "pane.send", id: "hub:x", extra: 1 }] })).success).toBe(false);
  });
});
