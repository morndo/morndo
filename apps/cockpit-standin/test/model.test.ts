import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validate, type Command } from "@morndo/cockpit-api";

describe("generated cockpit types", () => {
  it("keeps the stand-in from redeclaring the contract", () => {
    const model = readFileSync("apps/cockpit-standin/src/model.ts", "utf8");
    const search = readFileSync("apps/cockpit-standin/src/search.ts", "utf8");
    expect(model).not.toMatch(/export (interface|type) (Actor|Command|Lane|Message|Topic|Decision)\b/);
    expect(search).not.toMatch(/export interface (SearchResult|Answer)\b/);
    const command: Command = { type: "lane.move", laneId: "webinar", topicId: "partnerships" };
    expect(validate("Command", command).ok).toBe(true);
  });
});
