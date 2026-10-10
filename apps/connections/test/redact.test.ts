import { describe, expect, it } from "vitest";
import { streamRedactor } from "../src/adapters/redact.ts";

const KEY = "sk-ant-synthetic-test-key-0001";

describe("stream redaction", () => {
  it("replaces a secret split at every position", () => {
    const text = `before ${KEY} after`;
    for (let cut = 0; cut <= text.length; cut += 1) {
      const redactor = streamRedactor([KEY]);
      const out = redactor.push(text.slice(0, cut)) + redactor.push(text.slice(cut)) + redactor.flush();
      expect(out, `cut ${cut}`).toBe("before [redacted] after");
      expect(out).not.toContain(KEY);
    }
  });

  it("passes text through when there is no secret", () => {
    const redactor = streamRedactor([""]);
    expect(redactor.push("cafe") + redactor.flush()).toBe("cafe");
  });
});
