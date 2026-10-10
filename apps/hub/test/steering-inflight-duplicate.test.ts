// A repeated send (same session and request id) gets the first send's real outcome, never "duplicate" before that
// outcome is known (code review R3). The web client retries a send whose answer it never got with the same request id
// and counts "duplicate" as delivered, so the hub may only say "duplicate" once the text really was typed in. While
// the first send is still typing, a repeat waits for it: delivered → "duplicate" (the HTTP layer answers 200 ok), refused
// → that same refusal. The text is typed once either way. SteeringService with a fake Tmux whose send() finishes when
// the test says so; no real tmux. Both configurations (spec §9): in fleet mode the pane sits behind the fake fleet.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import type { SendProblem } from "@morndo/node-ops";
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

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "morndo-steer-inflight-")); store = new Store(dir); });
afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

// A pane whose first send() finishes with `first` when the test calls finish(); any later send() succeeds at once
// (so a repeat that typed again would come back ok instead of the first send's refusal).
function slowPane(first: SendProblem | null) {
  const typed: string[] = [];
  let finish = () => {};
  const done = new Promise<void>(r => (finish = r));
  let started = () => {};
  const typing = new Promise<void>(r => (started = r));
  const tmux: Tmux = {
    listWorkers: async () => [{ id: "%1", name: "alpha", location: "w", node: "local", offline: false }],
    capture: async () => "❯ ", captureMany: async ids => new Map(ids.map(id => [id, "❯ "])),
    async send(_id, text) {
      typed.push(text);
      if (typed.length > 1) return { problem: null, typedAt: now };
      started();
      await done;
      return { problem: first, typedAt: now };
    },
  };
  return { tmux, typed, typing, finish: () => finish() };
}

// Has the promise settled within a few turns of the event loop?
async function settledSoon(p: Promise<unknown>) {
  let settled = false;
  void p.then(() => (settled = true), () => (settled = true));
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 10));
  return settled;
}

const sends = () => store.audit(50).filter(e => e.type === "CommandSent").length;

describe.each(HUB_MODES)("a repeated request id while the first send is still typing, %s hub", mode => {
  let ports: ModePorts | null = null;
  afterEach(async () => { await ports?.close(); ports = null; });
  const service = async (pane: ReturnType<typeof slowPane>) => {
    ports = await portsFor(mode, { tmux: pane.tmux });
    return { s: steeringFor(ports, { store, now: () => now }), W: ports.id("%1") };
  };
  it("the first send is refused (menu_open): the repeat gets that refusal too, never duplicate/ok", async () => {
    const pane = slowPane("menu_open");
    const { s, W } = await service(pane);
    const before = sends();
    const first = s.send(auth, W, "ship the alpha release", `rq-a-${mode}`);
    await pane.typing;                                            // the first send is in the pane now
    const repeat = s.send(auth, W, "ship the alpha release", `rq-a-${mode}`);
    pane.finish();
    expect({ first: await first, repeat: await repeat }).toEqual({
      first: { ok: false, problem: "menu_open" },
      repeat: { ok: false, problem: "menu_open" },
    });
    expect(pane.typed).toHaveLength(1);                           // the repeat did not type it again
    expect(sends() - before).toBe(0);
  });

  it("the first send is delivered: the repeat is told duplicate only once that is known, and the text is typed once", async () => {
    const pane = slowPane(null);
    const { s, W } = await service(pane);
    const before = sends();
    const first = s.send(auth, W, "ship the alpha release", `rq-b-${mode}`);
    await pane.typing;
    const repeat = s.send(auth, W, "ship the alpha release", `rq-b-${mode}`);
    expect(await settledSoon(repeat), "the repeat answered before the first send's outcome was known").toBe(false);
    pane.finish();
    expect({ first: await first, repeat: await repeat }).toEqual({
      first: { ok: true, at: now },
      repeat: { ok: false, problem: "duplicate", at: now },               // http.ts answers this 200 {"error":"duplicate","ok":true}
    });
    expect(pane.typed).toHaveLength(1);
    expect(sends() - before).toBe(1);
  });

  it("control: a repeat after the first send was delivered is told duplicate, as today", async () => {
    const pane = slowPane(null);
    const { s, W } = await service(pane);
    const first = s.send(auth, W, "ship the alpha release", `rq-c-${mode}`);
    await pane.typing;
    pane.finish();
    expect(await first).toMatchObject({ ok: true });
    expect(await s.send(auth, W, "ship the alpha release", `rq-c-${mode}`)).toMatchObject({ ok: false, problem: "duplicate" });
    expect(pane.typed).toHaveLength(1);
  });
});
