// The desktop with a fleet (spec §16.1): the real hub in fleet mode offers the desktop MORNDO_VNC names, as the legacy
// hub does, so the PC holding both roles keeps its Desktop tab. /api/me's `desktop` is what the app shows the tab by,
// and the /api/desktop socket asks the same target (http.ts). No VNC server is needed to offer one.
import { afterEach, describe, expect, it } from "vitest";
import { startFleet, startHub, stopAll } from "../fleet-harness.ts";

afterEach(stopAll);

describe("the desktop with a fleet", () => {
  it("is offered when MORNDO_VNC names one, and not when it doesn't", async () => {
    const fleet = await startFleet();
    const me = async (vnc?: string) => {
      const hub = await startHub(fleet, vnc === undefined ? {} : { vnc });
      const r = await fetch(`${hub.base}/api/me`, { headers: { cookie: `__Host-morndo=${hub.cookie}` } });
      expect(r.status).toBe(200);
      return ((await r.json()) as { desktop: boolean }).desktop;
    };
    expect(await me("127.0.0.1:5901")).toBe(true);
    expect(await me()).toBe(false);
  });
});
