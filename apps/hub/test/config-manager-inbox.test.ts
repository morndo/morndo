// MORNDO_MANAGER_INBOX: a directory turns the manager's inbox on (ADR-0010); unset, empty, "0" or "off" leaves it off
// (the hub types directly), never a directory called "0" (the design report names MORNDO_MANAGER_INBOX=0 as the switch).
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const base = { MORNDO_ORIGIN: "https://hub.example.test:8443", MORNDO_HOME: "/tmp/morndo-config-test" };
describe("MORNDO_MANAGER_INBOX", () => {
  it("a directory: on", () => {
    expect(loadConfig({ ...base, MORNDO_MANAGER_INBOX: "/srv/inbox" }).managerInbox).toBe("/srv/inbox");
  });
  it.each([undefined, "", "0", "off", "OFF"])("%s: off", v => {
    expect(loadConfig({ ...base, ...(v === undefined ? {} : { MORNDO_MANAGER_INBOX: v }) }).managerInbox).toBeNull();
  });
});
