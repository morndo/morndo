// The agent's default policy turns on every op the protocol names, from the protocol's own list (RU4): an op added there
// can't be missing here, and a policy.json that lists it loads.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OP_NAMES } from "@morndo/protocol";
import { ALL_OPS, DEFAULT_POLICY, isOpName } from "../src/config.ts";

describe("the agent's ops", () => {
  it("are the protocol's, in its order", () => {
    expect([...ALL_OPS]).toEqual([...OP_NAMES]);
    expect(DEFAULT_POLICY.ops).toEqual([...OP_NAMES]);
    for (const op of OP_NAMES) expect(isOpName(op), op).toBe(true);
  });
  it("are not listed by hand in config.ts", () => {
    expect(readFileSync(join(import.meta.dirname, "../src/config.ts"), "utf8")).not.toMatch(/"inventory\.get"/);
  });
});
