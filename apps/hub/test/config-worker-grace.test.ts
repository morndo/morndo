// MORNDO_WORKER_ASK_GRACE_MS (config.ts graceOf): the tests-only override of N2's worker-ask grace, for the e2e
// offices. A string of digits only — so "0" is accepted, and the grace is off — is that many milliseconds; anything
// else (unset, empty, negative, decimals, text) is the default, WORKER_ASK_GRACE_MS, so a stray value in the
// environment never changes a real office's grace.
import { describe, expect, it } from "vitest";
import { WORKER_ASK_GRACE_MS } from "@morndo/domain";
import { loadConfig } from "../src/config.ts";

describe("MORNDO_WORKER_ASK_GRACE_MS", () => {
  it("unset or empty: the default, WORKER_ASK_GRACE_MS (600000)", () => {
    expect(loadConfig({}).workerAskGraceMs).toBe(WORKER_ASK_GRACE_MS);
    expect(loadConfig({ MORNDO_WORKER_ASK_GRACE_MS: "" }).workerAskGraceMs).toBe(600000);
  });
  it("digits only: that many milliseconds, so the e2e offices can turn the grace off", () => {
    expect(loadConfig({ MORNDO_WORKER_ASK_GRACE_MS: "0" }).workerAskGraceMs).toBe(0);
    expect(loadConfig({ MORNDO_WORKER_ASK_GRACE_MS: "3000" }).workerAskGraceMs).toBe(3000);
  });
  it("negative, decimal or text: the default, never guessed at", () => {
    for (const v of ["-5", "1.5", "abc"]) expect(loadConfig({ MORNDO_WORKER_ASK_GRACE_MS: v }).workerAskGraceMs, v).toBe(600000);
  });
});
