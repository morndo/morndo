// One definition of each limit the node and the hub share with the protocol (RU6): the values come from LIMITS and CLOSE,
// not from a number typed again beside them, so the three ends can't drift apart.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { MAX_FILE_BYTES } from "../src/file-rules.ts";
import { MAX_KEYS } from "../src/terminal.ts";

const src = (...p: string[]) => readFileSync(join(import.meta.dirname, "../../..", ...p), "utf8");
describe("limits shared with the protocol", () => {
  it("have the protocol's values", () => {
    expect(MAX_FILE_BYTES).toBe(LIMITS.maxFileBytes);
    expect(MAX_KEYS).toBe(LIMITS.maxKeys);
  });
  it("are read from the protocol, not typed again", () => {
    expect(src("packages/node-ops/src/file-rules.ts")).toMatch(/MAX_FILE_BYTES = LIMITS\.maxFileBytes/);
    expect(src("packages/node-ops/src/terminal.ts")).toMatch(/MAX_KEYS = LIMITS\.maxKeys/);
    expect(src("apps/hub/src/application/steering-service.ts")).toMatch(/MAX_TEXT = LIMITS\.maxSendText/);
    expect(src("apps/fleet/src/application/connections.ts")).not.toMatch(/\.close\(4\d{3}/);
  });
});
