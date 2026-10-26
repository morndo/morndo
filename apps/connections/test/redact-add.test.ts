import { describe, expect, it } from "vitest";
import { streamRedactor } from "../src/adapters/redact.ts";

const KEPT = "short-key";
const ADDED = "sk-ant-synthetic-added-key-0009";

describe("a needle added after the stream has started", () => {
  it("redacts a key added between chunks, including one split across the next two, and keeps an earlier needle", () => {
    const redactor = streamRedactor([KEPT]);
    const head = redactor.push(`a ${KEPT} b `);
    redactor.add([ADDED]);
    const cut = 12;
    const out = head + redactor.push(ADDED.slice(0, cut)) + redactor.push(`${ADDED.slice(cut)} ${KEPT}`) + redactor.flush();
    expect(out).toBe("a [redacted] b [redacted] [redacted]");
    expect(out).not.toContain(KEPT);
    expect(out).not.toContain(ADDED);
  });
});
