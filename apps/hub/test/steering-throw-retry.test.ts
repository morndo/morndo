// A send whose typing threw may or may not have reached the pane: tmux can fail after the paste as well as before. So a
// retry with the same request id is told "uncertain", never "duplicate" (review of the R3 fix, R4: the web client counts
// "duplicate" as delivered) and never typed again (ADR-0008 phase C review H2: exactly once). SteeringService with a
// fake Tmux whose first send() throws; no real tmux. Both configurations (spec §9): in fleet mode the pane sits behind
// the fake fleet, whose node keeps the key started (it may have run), so the retry asks it and stays uncertain.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import type { Tmux } from "../src/application/ports.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { HUB_MODES, portsFor, steeringFor, type ModePorts } from "./helpers/hub-mode.ts";

let dir: string;
let store: Store;
const now = Date.UTC(2026, 9, 1, 8);
const auth: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: now - 1000, lastSeenAt: now, verifiedAt: now - 1000, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
};

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "morndo-steer-throw-")); store = new Store(dir); });
afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

// A pane whose first send() throws (as `tmux exited 1` does) when `throwFirst`, and whose other sends succeed.
function pane(throwFirst: boolean) {
  const typed: string[] = [];
  const tmux: Tmux = {
    listWorkers: async () => [{ id: "%1", name: "alpha", location: "w", node: "local", offline: false }],
    capture: async () => "❯ ", captureMany: async ids => new Map(ids.map(id => [id, "❯ "])),
    async send(_id, text) {
      typed.push(text);
      if (throwFirst && typed.length === 1) throw new Error("tmux exited 1");
      return { problem: null, typedAt: now };
    },
  };
  return { tmux, typed };
}

describe.each(HUB_MODES)("a send whose typing threw, %s hub", mode => {
  let ports: ModePorts | null = null;
  afterEach(async () => { await ports?.close(); ports = null; });
  const service = async (p: ReturnType<typeof pane>) => {
    ports = await portsFor(mode, { tmux: p.tmux });
    return { s: steeringFor(ports, { store, now: () => now }), W: ports.id("%1") };
  };
  it("is answered 'uncertain' on the retry with the same request id: never 'duplicate', never typed twice", async () => {
    const p = pane(true);
    const { s, W } = await service(p);
    // Legacy: the throw is passed on (a 500). Fleet: the node answered "maybe" (SendInDoubt), which the hub answers
    // "uncertain" at once (409, "may have been sent"; final review I1).
    if (mode === "legacy") await expect(s.send(auth, W, "ship it", `req-throw-${mode}`)).rejects.toThrow("tmux exited 1");
    else expect(await s.send(auth, W, "ship it", `req-throw-${mode}`)).toEqual({ ok: false, problem: "uncertain" });
    const retry = await s.send(auth, W, "ship it", `req-throw-${mode}`);
    expect(retry).toEqual({ ok: false, problem: "uncertain" });
    expect(p.typed.length).toBe(1);
  });

  it("control: a delivered send's retry is still 'duplicate', typed once", async () => {
    const p = pane(false);
    const { s, W } = await service(p);
    expect(await s.send(auth, W, "ship it", `req-ok-${mode}`)).toEqual({ ok: true, at: now });
    expect(await s.send(auth, W, "ship it", `req-ok-${mode}`)).toEqual({ ok: false, problem: "duplicate", at: now });
    expect(p.typed.length).toBe(1);
  });
});
