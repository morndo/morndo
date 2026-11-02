// Sign-in sheet copy for hub and node problems (ADR-0039).
import { describe, expect, it } from "vitest";
import { problemWords } from "../src/lib/signin/words.ts";

describe("problemWords", () => {
  it("already_signed_in tells why a second sign-in is not started", () => {
    expect(problemWords("already_signed_in", "failed")).toBe(
      "Cursor is already signed in on this node. Signing in again would sign it out if it isn't finished, so it isn't started.",
    );
  });
  it("node_lost tells the node restarted", () => {
    expect(problemWords("node_lost", "failed")).toBe("The node lost this sign-in (it restarted). Try again.");
  });
  it("node_offline tells the node cannot be reached", () => {
    expect(problemWords("node_offline", "failed")).toBe("The node can't be reached right now.");
  });
});
