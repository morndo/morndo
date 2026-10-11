// The manager's answers through the fleet's delivery queue (fleet-clients §9.1; ADR-0010's domain rules; E13): the
// delivery id is the answer's key, so the switch never types one twice; queued, it counts as given (E8) and the card
// says why it waits; delivered, it is recorded once at its time; uncertain, it stays given and is never opened again;
// given up, the ask opens again and the same answer can go again. A hub restart keeps following it; a manager mid-
// restart is no refusal (its sticky name waits); an answer whose ask closed or was asked again is withdrawn. Off, the
// answer is typed directly under the same key, and what was still queued is cancelled first. Over the fake fleet on a
// real Unix socket; a synthetic list and conversation.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId, type Message } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { fleetDeliveries } from "../src/adapters/fleet-deliveries.ts";
import { EscalationService, type Watch } from "../src/application/escalation-service.ts";
import { ManagerQueue } from "../src/application/manager-queue.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import type { Deliveries } from "../src/application/ports.ts";
import { localNode, memoryBackend, until, type MemoryBackend } from "./helpers/fake-fleet.ts";
import { fleetRig, type FleetRig } from "./helpers/hub-mode.ts";

const T0 = Date.UTC(2026, 9, 8, 9);
const MANAGER = "pc.aaaaaaaa.0";
const KEY = "answer:ny-7:m1:option:ship";
const ID = `hub:${KEY}`;
let dir: string;
let store: Store;
let ledgerPath: string;
let backend: MemoryBackend;
let rig: FleetRig;
let clock: number;
let manager: Message[];
let running: { queue: ManagerQueue; svc: EscalationService }[] = [];

const auth: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: T0, lastSeenAt: T0, verifiedAt: T0 + 1e9, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: T0, revokedAt: null },
};
const buttons = (id: string, at: number): Message => ({ id, at, author: { kind: "agent", name: "manager" }, kind: "text", text: "Ready to ship.\n\n[buttons ny-7] ship=Ship it | hold=Hold for a day" });
const tap = (id: string, at: number): Message => ({ id, at, author: { kind: "principal", name: "You" }, kind: "text", text: "[tap ny-7] ship (Ship it)" });
const watch: Watch = {
  workers: () => (backend.panes["%0"] ? [{ id: MANAGER, name: "manager" }] : []),
  history: id => (id === MANAGER ? manager : []),
  openQuestions: () => [],
  screen: () => undefined,
};

beforeEach(async () => {
  clock = T0;
  dir = mkdtempSync(join(tmpdir(), "morndo-escalation-queue-"));
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-7", kind: "tap", question: "Ship the demo release tonight?",
    options: [{ key: "ship", label: "Ship it" }, { key: "hold", label: "Hold for a day" }] }], needsYouClosed: [] }));
  manager = [buttons("m1", T0 - 60_000)];
  backend = memoryBackend({ "%0": { name: "manager", cwd: "/w/manager", screen: "❯ ", sessionId: "s-manager" } });
  rig = await fleetRig([localNode("pc", "aaaaaaaa", backend)]);
});
afterEach(async () => {
  for (const r of running.splice(0)) { r.queue.stop(); r.svc.stop(); }
  await rig.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// A hub start, as main.ts builds one with a fleet: the queue (on, unless the switch is off), then the escalations on it.
async function start(o: { on?: boolean; deliveries?: Deliveries } = {}) {
  const queue = new ManagerQueue({ store, deliveries: o.deliveries ?? fleetDeliveries(rig.client), lane: "manager", on: o.on ?? true, now: () => clock, pollMs: 60_000 });
  const svc = new EscalationService({
    watch, ledger: ledgerReader(ledgerPath, () => clock), store, managerName: "manager", now: () => clock,
    send: (pane, text, key) => rig.ports.tmux.send(pane, text, key), queue,
  });
  await queue.start();
  svc.poll();
  running.push({ queue, svc });
  return svc;
}
const item = (svc: EscalationService, id = "ny-7") => svc.board().items.find(i => i.id === id);
const answers = () => store.audit(50).filter(a => a.type === "EscalationAnswered").map(a => a.body);
const ship = (svc: EscalationService, request = "r1") => svc.answer(auth, "ny-7", { kind: "option", key: "ship" }, request);

describe("an answer to the manager through the queue (spec §9.1)", () => {
  it("is queued under its answer key, counts as given (E8), and waits with its reason; nothing is typed by the hub", async () => {
    const svc = await start();
    expect(await ship(svc)).toMatchObject({ ok: true, item: { status: "answered", decision: { choice: { key: "ship" }, delivery: { state: "queued", at: null } } } });
    expect(rig.fleet.deliveryCalls).toEqual([{ id: ID, lane: "manager", workerId: null, text: "[tap ny-7] ship (Ship it)" }]);
    expect(backend.typed).toEqual([]);
    expect(answers()).toEqual([]);                                             // recorded only once delivered (E13)
    rig.fleet.moveDelivery(ID, { waiting: { reason: "menu_open", since: T0 } });
    await until(() => item(svc)?.waiting === "menu_open");
    rig.fleet.moveDelivery(ID, { state: "typed", typedAt: T0 + 5 });
    await until(() => item(svc)?.waiting === "typed");
    expect(await svc.answer(auth, "ny-7", { kind: "option", key: "hold" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
    expect(await ship(svc)).toMatchObject({ ok: true });                       // the same request again: what became of it
    expect(rig.fleet.deliveryCalls).toHaveLength(1);
  });

  it("delivered: recorded once, at the time it reached the manager (E13)", async () => {
    const svc = await start();
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "delivered", deliveredAt: T0 + 9000 });
    await until(() => answers().length === 1);
    expect(answers()[0]).toMatchObject({ escalationId: "ny-7", choice: { kind: "option", key: "ship", label: "Ship it" }, endpointId: "ep1", sessionId: "s1", at: T0 + 9000 });
    expect(item(svc)).toMatchObject({ status: "answered", decision: { delivery: { state: "delivered", at: T0 + 9000 } } });
    expect(item(svc)?.waiting).toBeUndefined();
    await running[0]?.queue.poll();
    expect(answers()).toHaveLength(1);
  });

  it("words are recorded by their length and digest, never the words", async () => {
    const svc = await start();
    expect(await svc.answer(auth, "ny-7", { kind: "words", text: "Ship it after the smoke test" }, "r1")).toMatchObject({ ok: true });
    const id = rig.fleet.deliveryCalls[0]?.id ?? "";
    expect(rig.fleet.deliveryCalls[0]?.text).toBe("About ny-7: Ship it after the smoke test");
    rig.fleet.moveDelivery(id, { state: "delivered", deliveredAt: T0 + 9000 });
    await until(() => answers().length === 1);
    expect(answers()[0]).toMatchObject({ choice: { kind: "words" }, length: 28, digest: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(JSON.stringify(store.audit(50))).not.toContain("smoke test");
  });

  it("uncertain: 'may have been delivered', still answered, never opened again, and not recorded", async () => {
    const svc = await start();
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "uncertain", note: "typed, never seen taken" });
    await until(() => item(svc)?.decision?.delivery?.state === "uncertain");
    svc.poll();
    expect(item(svc)).toMatchObject({ status: "answered" });
    expect(answers()).toEqual([]);
    expect(await svc.answer(auth, "ny-7", { kind: "option", key: "hold" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
  });

  it("given up: the ask is open again, nothing recorded; the same answer goes again under a new id", async () => {
    const svc = await start();
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "given_up", why: "expired" });
    await until(() => item(svc)?.status === "open");
    expect(item(svc)?.decision).toBeNull();
    expect(answers()).toEqual([]);
    expect(await ship(svc, "r2")).toMatchObject({ ok: true });
    expect(rig.fleet.deliveryCalls.map(c => c.id)).toEqual([ID, `${ID}~2`]);
  });

  it("in doubt (the fleet took it and never answered): uncertain, another answer refused meanwhile; its repeat takes it once", async () => {
    const svc = await start();
    rig.fleet.loseDeliveryAnswers(1);
    rig.fleet.quietDeliveries(true);
    expect(await ship(svc)).toMatchObject({ ok: false, problem: "uncertain", item: { status: "open" } });
    rig.fleet.quietDeliveries(false);
    expect(await svc.answer(auth, "ny-7", { kind: "option", key: "hold" }, "r2")).toMatchObject({ ok: false, problem: "answer_in_doubt" });
    expect(await ship(svc)).toMatchObject({ ok: true, item: { status: "answered", decision: { delivery: { state: "queued" } } } });
    expect(rig.fleet.deliveries.size).toBe(1);
  });

  // Review B1-1: a put that went in doubt left no Decision. The queue's later word is that answer, so Hold is not queued.
  const wentInDoubt = async () => {
    const svc = await start();
    rig.fleet.loseDeliveryAnswers(1);
    rig.fleet.quietDeliveries(true);
    expect(await ship(svc)).toMatchObject({ ok: false, problem: "uncertain", item: { status: "open", decision: null } });
    rig.fleet.quietDeliveries(false);
    return svc;
  };
  it("an answer whose put went in doubt is the Decision once the queue reports it delivered, so Hold is not queued", async () => {
    const svc = await wentInDoubt();
    rig.fleet.moveDelivery(ID, { state: "delivered", deliveredAt: T0 + 9000 });
    await until(() => item(svc)?.decision?.delivery?.state === "delivered");
    expect(item(svc)).toMatchObject({ status: "answered", decision: { choice: { key: "ship" } } });
    expect(answers()[0]).toMatchObject({ escalationId: "ny-7", choice: { key: "ship" }, at: T0 + 9000 });
    expect(await svc.answer(auth, "ny-7", { kind: "option", key: "hold" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
    expect(rig.fleet.deliveryCalls).toHaveLength(1);
  });
  it("an answer whose put went in doubt counts as given once the queue reports it typed or held, so Hold is not queued", async () => {
    const svc = await wentInDoubt();
    rig.fleet.moveDelivery(ID, { state: "typed", typedAt: T0 + 5 });
    await until(() => item(svc)?.status === "answered");
    expect(item(svc)).toMatchObject({ decision: { choice: { key: "ship" }, delivery: { state: "queued" } }, waiting: "typed" });
    expect(answers()).toEqual([]);
    expect(await svc.answer(auth, "ny-7", { kind: "option", key: "hold" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
    expect(rig.fleet.deliveryCalls).toHaveLength(1);
    rig.fleet.moveDelivery(ID, { state: "held" });
    await until(() => item(svc)?.waiting === "held");
    expect(item(svc)?.status).toBe("answered");
  });

  it("a hub restart keeps following it: delivered while the hub was down, recorded once at start", async () => {
    const before = await start();
    await ship(before);
    running[0]?.queue.stop();
    rig.fleet.moveDelivery(ID, { state: "delivered", deliveredAt: T0 + 9000 });
    const after = await start();
    await until(() => answers().length === 1);
    expect(item(after)).toMatchObject({ status: "answered", decision: { delivery: { state: "delivered", at: T0 + 9000 } } });
  });

  it("a manager mid-restart is no refusal: its sticky name waits on its node", async () => {
    const svc = await start();
    await rig.client.lanes();                                                  // the fleet saw the manager's window
    delete backend.panes["%0"];
    svc.poll();
    expect(await svc.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: true });
    expect(rig.fleet.deliveryCalls[0]).toMatchObject({ lane: "manager" });
  });

  it("asked again while queued: its delivery is withdrawn, and the new ask is open", async () => {
    const svc = await start();
    await ship(svc);
    clock = T0 + 60_000;
    manager = [buttons("m1", T0 - 60_000), buttons("m2", T0 + 30_000)];
    svc.poll();
    await until(() => rig.fleet.cancels.includes(ID));
    await until(() => rig.fleet.deliveries.get(ID)?.delivery.state === "given_up");
    expect(item(svc)).toMatchObject({ status: "open", askedAgain: true });
  });

  it("restated in place while queued (same id and time, new wording): the queued answer is withdrawn", async () => {
    const svc = await start();
    await ship(svc);
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-7", kind: "tap", question: "Ship tomorrow morning instead?",
      options: [{ key: "ship", label: "Ship it" }, { key: "hold", label: "Hold for a day" }] }], needsYouClosed: [] }));
    svc.poll();
    await until(() => rig.fleet.cancels.includes(ID));
    await until(() => rig.fleet.deliveries.get(ID)?.delivery.state === "given_up");
    expect(item(svc)).toMatchObject({ status: "open", decision: null });
  });

  it("an answer to one ask is not the Decision of the ask restated while that answer was being queued", async () => {
    const real = fleetDeliveries(rig.client);
    let release = (): void => {};
    let wait: Promise<void> | null = null;
    const deliveries: Deliveries = { ...real, deliver: async d => { const out = await real.deliver(d); if (wait) await wait; return out; } };
    const svc = await start({ deliveries });
    wait = new Promise<void>(r => { release = r; });
    const pending = ship(svc);
    await until(() => rig.fleet.deliveryCalls.length >= 1);
    clock = T0 + 60_000;
    manager = [buttons("m1", T0 - 60_000), buttons("m2", T0 + 30_000)];
    svc.poll();
    release();
    expect(await pending).toMatchObject({ ok: false, problem: "changed" });
    await until(() => rig.fleet.cancels.includes(ID));
    expect(item(svc)).toMatchObject({ status: "open", decision: null });
  });

  it("an older answer delivered while a newer one is still being queued is recorded", async () => {
    const real = fleetDeliveries(rig.client);
    let release = (): void => {};
    let wait: Promise<void> | null = null;
    const deliveries: Deliveries = { ...real, deliver: async d => { const out = await real.deliver(d); if (wait) await wait; return out; } };
    const svc = await start({ deliveries });
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "typed", typedAt: T0 + 5 });
    await until(() => item(svc)?.waiting === "typed");
    clock = T0 + 60_000;
    manager = [buttons("m1", T0 - 60_000), buttons("m2", T0 + 30_000)];
    svc.poll();
    wait = new Promise<void>(r => { release = r; });
    const pending = svc.answer(auth, "ny-7", { kind: "option", key: "hold" }, "r2");
    await until(() => rig.fleet.deliveryCalls.length >= 2);
    rig.fleet.moveDelivery(ID, { state: "delivered", deliveredAt: T0 + 40_000 });
    await until(() => store.managerDelivery(ID)?.state === "delivered");
    release();
    expect(await pending).toMatchObject({ ok: true });
    expect(answers().map(a => (a as { choice: { key?: string } }).choice.key)).toEqual(["ship"]);
  });

  it("asked again after it was typed: delivered, it answers the ask it was given for; its echo never answers the new one (ADR-0010 H1)", async () => {
    const svc = await start();
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "typed", typedAt: T0 + 5 });
    await until(() => item(svc)?.waiting === "typed");
    clock = T0 + 60_000;
    manager = [buttons("m1", T0 - 60_000), buttons("m2", T0 + 30_000), tap("e1", T0 + 40_000)];   // the typed line's echo
    svc.poll();
    rig.fleet.moveDelivery(ID, { state: "delivered", deliveredAt: T0 + 40_000 });
    await until(() => answers().length === 1);
    expect(answers()[0]).toMatchObject({ escalationId: "ny-7", at: T0 + 40_000 });
    svc.poll();
    expect(item(svc)).toMatchObject({ status: "open", decision: null, askedAgain: true });
    manager = [...manager, tap("e2", T0 + 50_000)];                                              // the same tap again: a new answer
    svc.poll();
    expect(item(svc)).toMatchObject({ status: "answered", decision: { via: "elsewhere", choice: { key: "ship" } } });
  });

  it("a later tap of the same line is the new ask's answer once the old echo has left the history", async () => {
    const svc = await start();
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "delivered", deliveredAt: T0 + 9000 });
    await until(() => answers().length === 1);
    clock = T0 + 60_000;
    manager = [buttons("m1", T0 - 60_000), buttons("m2", T0 + 30_000), tap("e1", T0 + 40_000)];
    svc.poll();
    expect(item(svc)).toMatchObject({ status: "open", decision: null });
    manager = [buttons("m2", T0 + 30_000), tap("e2", T0 + 50_000)];                              // the echo scrolled out; this tap is new
    svc.poll();
    expect(item(svc)).toMatchObject({ status: "answered", decision: { via: "elsewhere", choice: { key: "ship" } } });
  });

  it("the fleet down: nothing counts as given, and the ask stays open (spec §10)", async () => {
    const svc = await start();
    await rig.fleet.setStatus("pc", "offline");
    expect(await ship(svc)).toMatchObject({ ok: false, problem: "node_offline" });
    expect(item(svc)).toMatchObject({ status: "open", decision: null });
    expect(store.managerDelivery(ID)).toBeNull();
  });
});

describe("the switch off", () => {
  it("types the answer directly, under the same key the queue would use (negative control)", async () => {
    const svc = await start({ on: false });
    expect(await ship(svc)).toMatchObject({ ok: true });
    expect(rig.fleet.deliveryCalls).toEqual([]);
    expect(backend.typed).toEqual([{ pane: "%0", text: "[tap ny-7] ship (Ship it)", key: ID }]);
  });

  it("an answer still in doubt is never typed directly: its repeat is uncertain, another answer answer_in_doubt (ruling 49)", async () => {
    const svc = await start({ on: false });
    // In doubt: its cancel at start went unanswered, so its row is still "sending".
    store.saveManagerDelivery({ deliveryId: ID, kind: "answer", escalationId: "ny-7", ask: "m1", choice: JSON.stringify({ kind: "option", key: "ship", label: "Ship it" }),
      endpointId: "ep1", sessionId: "s1", requestId: "r1", queuedAt: T0, state: "sending", updatedAt: T0 });
    expect(await ship(svc)).toMatchObject({ ok: false, problem: "uncertain" });
    expect(await svc.answer(auth, "ny-7", { kind: "option", key: "hold" }, "r2")).toMatchObject({ ok: false, problem: "answer_in_doubt" });
    expect(backend.typed).toEqual([]);
  });

  it("a queued answer is cancelled first, its ask opens again, and a direct answer types it once", async () => {
    const on = await start();
    await ship(on);
    running[0]?.queue.stop();
    const off = await start({ on: false });
    await until(() => item(off)?.status === "open");
    expect(rig.fleet.cancels).toEqual([ID]);
    expect(await ship(off, "r2")).toMatchObject({ ok: true });
    expect(backend.typed.map(t => t.key)).toEqual([ID]);
  });
});

// #29's review cases (its tests went with its inbox; ruling 81), on the queue: each failed there before its fix.
describe("#29's review cases, on the queue", () => {
  const restart = async (o: { on?: boolean } = {}) => { for (const r of running.splice(0)) { r.queue.stop(); r.svc.stop(); } return start(o); };
  const hold = (svc: EscalationService, request = "r2") => svc.answer(auth, "ny-7", { kind: "option", key: "hold" }, request);
  // A typed, so not withdrawn; the ask asked again (m2) and answered anew with B, queued.
  const answeredAnew = async () => {
    const svc = await start();
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "typed", typedAt: T0 + 5 });
    await until(() => item(svc)?.waiting === "typed");
    clock = T0 + 60_000;
    manager = [buttons("m1", T0 - 60_000), buttons("m2", T0 + 30_000)];
    svc.poll();
    expect(await hold(svc)).toMatchObject({ ok: true, item: { decision: { choice: { key: "hold" } } } });
    return svc;
  };

  it("B3: an older answer that ends after the ask was answered anew leaves the newer Decision, across a restart", async () => {
    const svc = await answeredAnew();
    rig.fleet.moveDelivery(ID, { state: "delivered", deliveredAt: T0 + 61_000 });
    await until(() => answers().length === 1);
    expect(item(svc)).toMatchObject({ status: "answered", decision: { choice: { key: "hold" }, delivery: { state: "queued" } } });
    const after = await restart();
    expect(item(after)).toMatchObject({ status: "answered", decision: { choice: { key: "hold" }, delivery: { state: "queued" } } });
  });

  it("B7: two answers to one ask, asked again in between: each is recorded once delivered, with its own choice and time", async () => {
    const svc = await answeredAnew();
    rig.fleet.moveDelivery(ID, { state: "delivered", deliveredAt: T0 + 61_000 });
    const second = rig.fleet.deliveryCalls[1]?.id ?? "";
    rig.fleet.moveDelivery(second, { state: "delivered", deliveredAt: T0 + 62_000 });
    await until(() => answers().length === 2);
    const recorded = answers().map(a => [(a as { choice: { key: string } }).choice.key, (a as { at: number }).at]);
    expect(recorded.sort((x, y) => Number(x[1]) - Number(y[1]))).toEqual([["ship", T0 + 61_000], ["hold", T0 + 62_000]]);
    expect(item(svc)).toMatchObject({ status: "answered", decision: { choice: { key: "hold" }, delivery: { state: "delivered", at: T0 + 62_000 } } });
  });

  describe("B5: the queue's word after a restart, before the ask is sighted again", () => {
    // An ask from a button message alone (not on the list): sighted only while the manager's conversation can be read.
    const go = (svc: EscalationService) => svc.answer(auth, "ship-1", { kind: "option", key: "go" }, "r1");
    const away = async () => {
      manager = [{ id: "m1", at: T0 - 60_000, author: { kind: "agent", name: "manager" }, kind: "text", text: "Ship the hotfix?\n\n[buttons ship-1] go=Go | hold=Hold" }];
      const svc = await start();
      expect(await go(svc)).toMatchObject({ ok: true });
      for (const r of running.splice(0)) { r.queue.stop(); r.svc.stop(); }
      delete backend.panes["%0"];                                                // the hub restarts while the manager isn't running
      return rig.fleet.deliveryCalls[0]?.id ?? "";
    };
    const back = (svc: EscalationService) => {
      backend.panes["%0"] = { name: "manager", cwd: "/w/manager", screen: "❯ ", sessionId: "s-manager" };
      svc.poll();
      return item(svc, "ship-1");
    };

    it("delivered: recorded at once, and the ask, sighted again, shows it delivered", async () => {
      const id = await away();
      rig.fleet.moveDelivery(id, { state: "delivered", deliveredAt: T0 + 1000 });
      const svc = await start();
      await until(() => answers().length === 1);
      expect(item(svc, "ship-1")).toBeUndefined();
      expect(back(svc)).toMatchObject({ status: "answered", decision: { delivery: { state: "delivered", at: T0 + 1000 } } });
    });

    it("given up: the ask, sighted again, is open, and nothing is recorded", async () => {
      const id = await away();
      rig.fleet.moveDelivery(id, { state: "given_up", why: "expired" });
      const svc = await start();
      await until(() => store.managerDelivery(id)?.state === "given_up");
      expect(back(svc)).toMatchObject({ status: "open", decision: null });
      expect(answers()).toEqual([]);
    });
  });

  it("B8: after restarts, a card's Decision carries only the Decision's own fields", async () => {
    const declared = ["at", "choice", "delivery", "endpointId", "sessionId", "via"];
    await ship(await start());
    let svc = await restart();
    expect(Object.keys(item(svc)?.decision ?? {}).sort()).toEqual(declared);
    rig.fleet.moveDelivery(ID, { state: "delivered", deliveredAt: T0 + 9000 });
    await until(() => answers().length === 1);
    svc = await restart();
    expect(Object.keys(item(svc)?.decision ?? {}).sort()).toEqual(declared);
  });

  it("B9: words that are empty once control characters go are refused, and nothing is queued", async () => {
    const svc = await start();
    expect(await svc.answer(auth, "ny-7", { kind: "words", text: " \u001b\u0007\u0000\r\n " }, "r1")).toMatchObject({ ok: false, problem: "empty" });
    expect(rig.fleet.deliveryCalls).toEqual([]);
  });
});

describe("the card's notice (#29's notices, on the queue)", () => {
  it("given up: Not delivered on the open card, still after a restart; answering again clears it", async () => {
    let svc = await start();
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "given_up", why: "expired" });
    await until(() => item(svc)?.status === "open");
    expect(item(svc)?.notice).toBe("Not delivered: the answer never reached the manager. Answer again.");
    for (const r of running.splice(0)) { r.queue.stop(); r.svc.stop(); }
    svc = await start();
    expect(item(svc)?.notice).toMatch(/^Not delivered/);
    expect(await ship(svc, "r2")).toMatchObject({ ok: true });
    expect(item(svc)?.notice).toBeUndefined();
  });

  it("the same request again after it was given up: not delivered, nothing queued again", async () => {
    const svc = await start();
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "given_up", why: "cancelled" });
    await until(() => item(svc)?.status === "open");
    expect(await ship(svc)).toMatchObject({ ok: false, problem: "not_delivered", item: { status: "open" } });
    expect(rig.fleet.deliveryCalls).toHaveLength(1);
  });

  it("delivered late, for the ask before it was asked again: the new ask's card says so (negative control: a new ask after a delivery says nothing)", async () => {
    const svc = await start();
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "typed", typedAt: T0 + 5 });
    await until(() => item(svc)?.waiting === "typed");
    clock = T0 + 60_000;
    manager = [buttons("m1", T0 - 60_000), buttons("m2", T0 + 30_000)];
    svc.poll();
    rig.fleet.moveDelivery(ID, { state: "delivered", deliveredAt: T0 + 61_000 });
    await until(() => answers().length === 1);
    expect(item(svc)).toMatchObject({ status: "open", notice: "This reached the manager late, as an answer to the earlier version of the question." });
    clock = T0 + 120_000;
    manager = [...manager, buttons("m3", T0 + 120_000)];                       // asked again after that delivery
    svc.poll();
    expect(item(svc)?.notice).toBeUndefined();
  });

  it("a given-up answer for an earlier ask says nothing on the new ask", async () => {
    const svc = await start();
    await ship(svc);
    clock = T0 + 60_000;
    manager = [buttons("m1", T0 - 60_000), buttons("m2", T0 + 30_000)];
    svc.poll();
    await until(() => rig.fleet.deliveries.get(ID)?.delivery.state === "given_up");
    await until(() => store.managerDelivery(ID)?.state === "given_up");
    expect(item(svc)).toMatchObject({ status: "open", askedAgain: true });
    expect(item(svc)?.notice).toBeUndefined();
  });
});

describe("an answer #29's inbox left queued (no delivery row here)", () => {
  it("may have been delivered: it stays answered, is never asked again, and nothing is typed or queued (ruling 82)", async () => {
    store.saveDecision("ny-7", { choice: { kind: "option", key: "ship", label: "Ship it" }, at: T0 - 5000, via: "here", endpointId: "ep1", sessionId: "s1", delivery: { state: "queued", at: null } });
    const svc = await start();
    expect(item(svc)).toMatchObject({ status: "answered", decision: { delivery: { state: "uncertain", at: null } } });
    expect(store.decisions()[0]?.decision).toMatchObject({ delivery: { state: "uncertain" } });
    expect(await svc.answer(auth, "ny-7", { kind: "option", key: "hold" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
    expect(rig.fleet.deliveryCalls).toEqual([]);
    expect(backend.typed).toEqual([]);
  });
});
