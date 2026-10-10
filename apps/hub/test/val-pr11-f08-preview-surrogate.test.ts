// Validation of review finding #8 (range b9328b196..d90a1443e, PR #11): the chat row's preview is cut with
// text.slice(0, PREVIEW_CHARS), which counts UTF-16 code units, so an emoji lying across the cut is halved and the
// row's text ends in a lone surrogate (shown as U+FFFD, and not valid UTF-16 any more). Synthetic data.
import { describe, expect, it } from "vitest";
import type { Message } from "@morndo/domain";
import { PREVIEW_CHARS, chats } from "../src/application/chats.ts";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const msg = (text: string): Message => ({ id: "a", at: 1, author: { kind: "agent", name: "w" }, kind: "text", text });
const sources = (text: string) => ({ workers: () => [{ id: "%1", name: "builder" }], history: () => [msg(text)], reads: () => ({}), muted: () => [] });

describe("finding #8: the preview cut and characters outside the BMP", () => {
  it("control: a cut between two plain characters leaves well-formed text", () => {
    const row = chats(sources("x".repeat(PREVIEW_CHARS + 50)))[0];
    expect(LONE_SURROGATE.test(row?.answer?.text ?? "")).toBe(false);
  });
  it("an emoji across the cut is not halved: the row's last and answer text stay well-formed", () => {
    const row = chats(sources(`${"x".repeat(PREVIEW_CHARS - 1)}\u{1F600} and the rest of a long answer`))[0];
    expect((row?.answer?.text ?? "").length).toBeLessThanOrEqual(PREVIEW_CHARS);
    expect(LONE_SURROGATE.test(row?.answer?.text ?? "")).toBe(false);
    expect(LONE_SURROGATE.test(row?.last?.text ?? "")).toBe(false);
  });
});
