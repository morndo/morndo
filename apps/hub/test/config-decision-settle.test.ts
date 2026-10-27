// MORNDO_DECISION_SETTLE_MS (config.ts): the tests-only override of N2's decision settle, for the e2e offices.
import { describe, expect, it } from "vitest";
import { DECISION_SETTLE_MS } from "@morndo/domain";
import { loadConfig } from "../src/config.ts";

describe("MORNDO_DECISION_SETTLE_MS", () => {
  it("unset or empty: the domain's minute", () => {
    expect(loadConfig({}).decisionSettleMs).toBe(DECISION_SETTLE_MS);
    expect(loadConfig({ MORNDO_DECISION_SETTLE_MS: "" }).decisionSettleMs).toBe(60_000);
  });
  it("digits only are that many milliseconds; 0 turns the settle off", () => {
    expect(loadConfig({ MORNDO_DECISION_SETTLE_MS: "0" }).decisionSettleMs).toBe(0);
    expect(loadConfig({ MORNDO_DECISION_SETTLE_MS: "2500" }).decisionSettleMs).toBe(2500);
  });
  it("anything else is the default, never a shorter settle", () => {
    for (const v of ["-5", "1.5", "abc", " 10"]) expect(loadConfig({ MORNDO_DECISION_SETTLE_MS: v }).decisionSettleMs, v).toBe(60_000);
  });
});
