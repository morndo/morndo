import { describe, expect, it } from "vitest";
import { commandErrors } from "../src/index.ts";

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
