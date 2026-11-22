import { describe, expect, it } from "vitest";
import { commandErrors, validate } from "../src/index.ts";

describe("command errors", () => {
  it("names an unknown command type", () => {
    expect(commandErrors({ type: "nope" })).toEqual(['unknown command type "nope"']);
    expect(commandErrors({})).toEqual(['unknown command type ""']);
  });

  it("reports only the variant that matches the type", () => {
    const approve = commandErrors({ type: "decision.approve" }).join("\n");
    expect(approve).toMatch(/decisionId/);
    expect(approve).not.toMatch(/threadId|pinId|skill/);

    const relabel = commandErrors({ type: "message.relabel", messageId: "m1" }).join("\n");
    expect(relabel).toMatch(/label/);
    expect(relabel).not.toMatch(/decisionId|threadId/);

    expect(commandErrors({ type: "decision.approve", decisionId: "d1" })).toEqual([]);
  });
});

it("bounds every free-text field used by the shared composer and equivalent commands", () => {
  const extra = "a".repeat(201);
  const inputs = [
    { type: "lane.act", laneId: "red-main", act: extra },
    { type: "prefs.set", deviceId: extra },
    { type: "access.set", topicId: "web", personId: "nora-reed", access: { kind: "stages", stages: [extra] } },
    { type: "recent.visit", target: { kind: "topic", id: extra } },
    { type: "message.send", threadId: "topic:web", stage: extra, text: "Hello" },
    { type: "since.edit", threadId: "topic:web", lines: ["a".repeat(4001)] },
    { type: "since.edit", threadId: "topic:web", lines: Array(13).fill("Note") },
  ];
  for (const input of inputs) expect(validate("Command", input).ok, input.type).toBe(false);
});
