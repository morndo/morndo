// The agent's backstop redactor must not leak the remainder of a JSON string value that contains an escaped quote.
import { describe, expect, it } from "vitest";
import { redact } from "../src/log.ts";

describe("redact() on JSON field values with escaped quotes", () => {
  it("redacts the whole value even when it contains \\\"", () => {
    const out = redact('{"text":"say \\"hi\\" then the secret: hunter2"}', "/home/u");
    expect(out).not.toContain("hunter2");
    expect(out).toBe('{"text":"[redacted]"}');
  });
  it("redacts a nested body value with escapes", () => {
    const out = redact('{"body":"{\\"prompt\\":\\"my password is hunter2\\"}"}', "/home/u");
    expect(out).not.toContain("hunter2");
  });
});
