// The hub, the fleet service and the node agent redact the same line the same way (RU1): each had its own copy of the
// rules and they had drifted (an agent line kept "alice@github" and the tail of a text after an escaped quote). Synthetic
// values only.
import { describe, expect, it } from "vitest";
import { redact as agent } from "../../node-agent/src/log.ts";
import { redact as fleet } from "../../fleet/src/adapters/log.ts";
import { redact as hub } from "../src/adapters/log.ts";

const HOME = "/nonexistent-home";
const LINES: [string, string][] = [
  ["login alice@github failed", "login [email] failed"],
  [`{"key":"hub:abc"}`, `{"key":"[redacted]"}`],
  [`{"fleetKey":"MCowBQYDK2VwAyEAxyz="}`, `{"fleetKey":"[redacted]"}`],
  [`{"text":"say \\"hi\\" then secret-rest"}`, `{"text":"[redacted]"}`],
  [`{"token":"tok123"}`, `{"token":"[redacted]"}`],
  ["cookie __Host-morndo=abc123", "cookie __Host-morndo=[redacted]"],
  ["open /pair#t=SECRET", "open /pair#t=[redacted]"],
  ["morndo-join:2:abcDEF", "morndo-join:2:[redacted]"],
  ["-----BEGIN PUBLIC KEY-----\nMCow\n-----END PUBLIC KEY-----", "[pem redacted]"],
];
describe("the three services' redaction", () => {
  for (const [input, expected] of LINES) {
    it(`reads ${JSON.stringify(input).slice(0, 48)} alike`, () => {
      expect(hub(input, HOME)).toBe(expected);
      expect(fleet(input, HOME)).toBe(expected);
      expect(agent(input, HOME)).toBe(expected);
    });
  }
});
