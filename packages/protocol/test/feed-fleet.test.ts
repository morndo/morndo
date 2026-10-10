// The feed's `fleet` frame (fleet core §7): whether the hub can reach the fleet service. A hub from before the fleet
// never sends it, and the app reads that as available (apps/web feed.svelte.ts). Synthetic frames only.
import { describe, expect, it } from "vitest";
import { ServerFeedFrames, decode } from "../src/index.ts";

describe("the fleet frame", () => {
  it("decodes both ways", () => {
    for (const available of [true, false]) {
      expect(decode(ServerFeedFrames, JSON.stringify({ t: "fleet", available }))).toEqual({ kind: "ok", frame: { t: "fleet", available } });
    }
  });
  it("one without a boolean is malformed (negative control)", () => {
    expect(decode(ServerFeedFrames, JSON.stringify({ t: "fleet" })).kind).toBe("malformed");
    expect(decode(ServerFeedFrames, JSON.stringify({ t: "fleet", available: "no" })).kind).toBe("malformed");
  });
});
