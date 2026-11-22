import { expect, it } from "vitest";
import { parseFeedFrame, parseResponse, validate } from "../src/index.ts";

it("keeps the hub strict and maps new event and enum values for installed readers", () => {
  const at = "2026-11-16T08:45:00+01:00";
  const frame = { seq: 4, at, type: "future.updated", payload: "new" };
  expect(validate("FeedEvent", frame).ok).toBe(false);
  expect(validate("Event", { type: "Unknown" }).ok).toBe(false);
  expect(validate("DecisionState", "unknown").ok).toBe(false);
  expect(parseFeedFrame(frame)).toEqual({ ok: true, value: { seq: 4, at, type: "unknown" } });
  expect(parseFeedFrame({ ...frame, seq: "4" }).ok).toBe(false);
  expect(parseFeedFrame({ seq: 4, at, type: "decision.changed" }).ok).toBe(false);
  const decision = { seq: 4, at, type: "decision.changed", decisionId: "d1", state: "paused", details: true };
  expect(parseFeedFrame(decision)).toEqual({ ok: true, value: { ...decision, state: "unknown" } });
  expect(parseResponse("DecisionState", 6).ok).toBe(false);
  expect(parseResponse("DecisionState", "paused")).toEqual({ ok: true, value: "unknown" });
  expect(parseFeedFrame({ type: "feed.reset" })).toEqual({ ok: true, value: { type: "feed.reset" } });
});
