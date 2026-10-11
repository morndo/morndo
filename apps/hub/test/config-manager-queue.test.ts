// MORNDO_MANAGER_QUEUE (fleet-clients §9.1, plan.md Config): with a fleet, the manager's answers and messages go through
// the fleet's delivery queue unless it says "off" or "0"; without a fleet there is no queue, whatever it says. It is the
// only switch: #29's MORNDO_MANAGER_INBOX is gone (ruling 81), and set, it changes nothing.
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const FLEET = { MORNDO_FLEET_SOCKET: "/home/o/.local/state/morndo-fleet/fleet.sock" };

describe("MORNDO_MANAGER_QUEUE", () => {
  it("on by default with a fleet", () => {
    expect(loadConfig(FLEET).managerQueue).toBe(true);
    expect(loadConfig({ ...FLEET, MORNDO_MANAGER_QUEUE: "" }).managerQueue).toBe(true);
    expect(loadConfig({ ...FLEET, MORNDO_MANAGER_QUEUE: "on" }).managerQueue).toBe(true);
  });
  it("off and 0 turn it off, in any case (the rollback of step 2, spec §13)", () => {
    for (const off of ["off", "0", "OFF", "Off"]) expect(loadConfig({ ...FLEET, MORNDO_MANAGER_QUEUE: off }).managerQueue, off).toBe(false);
  });
  it("the only switch: MORNDO_MANAGER_INBOX, set, changes nothing either way (ruling 81)", () => {
    expect(loadConfig({ ...FLEET, MORNDO_MANAGER_INBOX: "/home/o/kira/inbox" }).managerQueue).toBe(true);
    expect(loadConfig({ ...FLEET, MORNDO_MANAGER_INBOX: "/home/o/kira/inbox", MORNDO_MANAGER_QUEUE: "off" }).managerQueue).toBe(false);
  });
  it("without a fleet there is no queue, whatever it says (negative control)", () => {
    expect(loadConfig({}).managerQueue).toBe(false);
    expect(loadConfig({ MORNDO_MANAGER_QUEUE: "on" }).managerQueue).toBe(false);
  });
});
