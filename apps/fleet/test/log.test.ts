// The fleet's logger redacts every line (Global Constraints: never log typed text, hook bodies, keys or codes), with
// error stacks and causes included.
import { describe, expect, it } from "vitest";
import { createLogger, redact } from "../src/adapters/log.ts";

describe("the fleet logger", () => {
  it("redacts join strings, key files, secret fields, tailnet names and addresses, and the home directory", () => {
    const line = [
      "join morndo-join:1:eyJ1cmwiOiJ3c3M6Ly9mbGVldC9hZ2VudCJ9 failed",
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----",
      `{"code":"q3J0-abc","sig":"AAAA","publicKey":"MCowBQ","body":"secret words","text":"typed"}`,
      "from pc.tail1234.ts.net at 100.101.102.103 and fd7a:115c:a1e0::1, mail me@example.test",
      "/home/owner/.local/share/morndo-fleet/fleet.db",
    ].join("\n");
    const out = redact(line, "/home/owner");
    expect(out).toContain("morndo-join:1:[redacted]");
    expect(out).toContain("[pem redacted]");
    expect(out).toContain(`{"code":"[redacted]","sig":"[redacted]","publicKey":"[redacted]","body":"[redacted]","text":"[redacted]"}`);
    expect(out).toContain("[tailnet-host]");
    expect(out).not.toMatch(/100\.101\.102\.103|fd7a:115c|me@example|q3J0|MC4CAQ|secret words|typed"/);
    expect(out).toContain("~/.local/share/morndo-fleet/fleet.db");
  });

  it("logs levels at or above its own, through one sink, error causes included and redacted", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "info", home: "/home/owner", sink: line => lines.push(line) });
    log.debug("not shown");
    log.warn("join failed", new Error("bad code morndo-join:1:abcdef", { cause: new Error("at /home/owner/x") }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[fleet\] warn: join failed\nError: bad code morndo-join:1:\[redacted\]/);
    expect(lines[0]).toContain("Caused by: Error: at ~/x");
  });
});
