// The hub's manager queue through a real fleet (plan/RECONCILIATION.md rulings 66, 81, 82 and 83; fleet clients spec §9.1,
// §13 steps 1 and 2): the hub with MORNDO_MANAGER_QUEUE on, a real fleet and node agent (test/fleet-harness.ts: random
// ports, temporary HOMEs, an isolated tmux server), and the manager as the fake input box with a live session
// (test/fixtures/fake-claude-pane.ts), so a delivery is typed and confirmed from its transcript. The ask is the
// manager's needs-you list's ny-1, as in drills-retry.
// - An answer and a message to the manager are each queued under the hub's key, typed once and confirmed; the answer's
//   card ends "Delivered" (its Decision's delivery state), and its EscalationAnswered is recorded once.
// - An answer typed and never seen taken (dropped on an interrupt, its line back in the box) is uncertain: its card says
//   "May have been delivered", it stays answered, it is never typed again, and it is not recorded (ruling 82).
// - A message waiting behind the owner's draft is cancelled by the principal and never typed; once a message is typed,
//   its cancel is too late (ruling 83).
// - Answer in flight (drill (f) of the fleet core's durability work, on the queue): the hub is killed after it queued an
//   answer and before it recorded it; restarted, it records it once, and nothing is delivered or typed a second time.
// - Switched off (step 2's rollback):
//   - an answer still queued is cancelled at start: never typed, its card says "Not delivered", its ask opens again
//     (ruling 82), and its direct answer types it once;
//   - a direct retry of an answer already typed finds its key on the node and is not typed again (§9.1: "nothing is typed
//     twice"). The hub only types such an answer again when it no longer knows it: here its database is put back from a
//     copy taken before the answer, as step 1's rollback does. The manager's box writes no transcript line for that answer
//     (`silent`), so the restored hub sees no echo of the tap and takes the ask as open.
// Negative control: the same retry with the node's done keys off (noDoneKeys) types the answer a second time. The key the
// queue and the direct send share is what keeps it to once.
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestHooks } from "../../apps/node-agent/src/test-hooks.ts";
import { LIMITS } from "../../packages/protocol/src/fleet.ts";
import { fakeLane, joinAgent, paneOf, sleep, startFleet, startHub, stopAll, tmuxServer, until, type Fleet, type Hub } from "../fleet-harness.ts";

afterEach(stopAll);

const TAP = "[tap ny-1] ship (Ship it)";                     // what the hub types for that answer (drills-retry's TAP)
const PAST_A_TRY = LIMITS.deliveryTryMs + 2000;
const times = (xs: string[], x: string) => xs.filter(t => t === x).length;

// n1 with the manager's lane (the box, a live session), and the hub with its queue on and the needs-you list's ny-1 open.
async function office(hooks: TestHooks = {}) {
  const fleet = await startFleet();
  const tmux = tmuxServer();
  const agent = await joinAgent(fleet, "n1", { tmux });
  const manager = await fakeLane(tmux, { window: "manager", claudeHome: agent.home });
  await agent.run(hooks);
  await agent.waitOnline();
  await until("the manager idle in n1's inventory", async () => (await paneOf(fleet.client, "n1", "manager")).status === "idle", 15_000);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const hub = await startHub(fleet, { managerQueue: true, ledger: { needsYou: [{ id: "ny-1", kind: "tap", question: "Ship the drill build?",
    options: [{ key: "ship", label: "Ship it" }, { key: "hold", label: "Hold" }], deadline: tomorrow, ts: new Date(Date.now() - 60_000).toISOString() }] } });
  await until("the hub's start line: manager queue on", () => /manager queue: on\n/.test(hub.log()), 15_000);
  const feed = await hub.feed();
  await until("the manager on the hub", () => feed.names.has("manager"), 15_000);
  const managerId = (await paneOf(fleet.client, "n1", "manager")).workerId;
  return { fleet, agent, manager, hub, managerId };
}
type Office = Awaited<ReturnType<typeof office>>;

const statusIs = (o: Office, s: string) =>
  until(`the manager ${s} in n1's inventory`, async () => (await paneOf(o.fleet.client, "n1", "manager")).status === s, 15_000);
// The hub's view of ny-1 (GET /api/escalations): open or answered, its Decision's delivery state, which its card shows
// ("Queued, it will be delivered", "Delivered", "May have been delivered"), why it waits, and its notice ("Not delivered: …").
type Item = { id: string; status: string; waiting?: string; notice?: string | null; decision: { delivery?: { state: string } } | null };
const ask = async (hub: Hub) => ((await hub.get("/api/escalations")).body.items as Item[] | undefined)?.find(i => i.id === "ny-1") ?? null;
// The fleet's deliveries whose id is the hub's answer key for ny-1, hub:answer:ny-1:<ask>:<choice> (§9.1).
const answers = async (fleet: Fleet) => (await fleet.client.deliveries({ lane: "manager" })).filter(d => d.id.startsWith("hub:answer:ny-1:"));
const recorded = (hub: Hub) => hub.audit().split("\n").filter(l => l.includes("EscalationAnswered") && l.includes("ny-1")).length;
async function theAnswer(o: Office, state: string) {
  return until(`ny-1's delivery ${state}`, async () => (await answers(o.fleet)).find(d => d.state === state) ?? null, 30_000, 250);
}
// A message to the manager as the app sends it: with the time he wrote it (createdAt), from which it waits up to 24 hours
// (ruling 83). `seen: "none"`: written for a manager that waits on no question.
const message = (o: Office, text: string, requestId: string, createdAt = Date.now()) =>
  o.hub.post(`/api/workers/${encodeURIComponent(o.managerId)}/send`, { text, requestId, seen: "none", createdAt });
const cancel = (o: Office, requestId: string) => o.hub.post("/api/manager/cancel", { requestId });
// The fleet's delivery of a message: its id is the hub's key, hub:<endpoint>:<request> (§9.1).
const messageDelivery = async (fleet: Fleet, requestId: string) =>
  (await fleet.client.deliveries({ lane: "manager" })).find(d => d.id.endsWith(`:${requestId}`)) ?? null;

describe("an answer and a message to the manager, through the queue", () => {
  it("an answer: queued under the hub's key, typed once, confirmed; its card ends Delivered; recorded once", async () => {
    const o = await office();
    expect(await o.hub.answer("ny-1", "ship")).toMatchObject({ status: 200, body: { ok: true, item: { id: "ny-1", status: "answered" } } });
    const d = await theAnswer(o, "delivered");
    expect(d.id).toMatch(/^hub:answer:ny-1:[^:]+:option:ship$/);   // the key a direct send types under (§9.1)
    await until("its card Delivered", async () => (await ask(o.hub))?.decision?.delivery?.state === "delivered", 15_000);
    await until("recorded", () => recorded(o.hub) === 1, 15_000);
    await sleep(PAST_A_TRY);
    expect(times(o.manager.submitted(), TAP)).toBe(1);
    expect(recorded(o.hub)).toBe(1);
    expect(await answers(o.fleet)).toHaveLength(1);
  });

  it("a message: queued as hub:<endpoint>:<request>, typed once, confirmed; its repeat says delivered and types nothing", async () => {
    const o = await office();
    const rid = randomUUID();
    const written = Date.now();
    expect(await message(o, "status, please", rid, written)).toMatchObject({ status: 200, body: { ok: true, at: expect.any(Number), delivery: { requestId: rid } } });
    const id = await until("the message's delivery", async () => (await messageDelivery(o.fleet, rid))?.id ?? null);
    expect(id).toMatch(new RegExp(`^hub:fleet-test-[0-9a-f]{8}:${rid}$`));   // the hub's key: hub:<endpoint>:<request>
    await until("the message delivered", async () => (await o.fleet.client.delivery(id))?.state === "delivered", 30_000);
    const again = await until("the hub's own state: delivered", async () => {
      const r = await message(o, "status, please", rid, written);
      return (r.body.delivery as { state?: string } | undefined)?.state === "delivered" ? r : null;
    }, 15_000, 500);
    expect(again).toMatchObject({ status: 200, body: { ok: true, error: "duplicate", delivery: { requestId: rid, state: "delivered", why: null } } });
    await sleep(PAST_A_TRY);
    expect(times(o.manager.submitted(), "status, please")).toBe(1);
  });
});

describe("an answer that may not have reached the manager (ruling 82)", () => {
  it("typed and never seen taken: uncertain, May have been delivered; never asked again, never typed again, not recorded", async () => {
    const o = await office();
    await o.manager.control({ status: "busy" });                   // a turn runs: the answer is typed into the manager's own queue
    await statusIs(o, "busy");
    const rid = randomUUID();
    expect((await o.hub.answer("ny-1", "ship", rid)).status).toBe(200);
    await theAnswer(o, "held");
    await o.manager.control({ interrupt: { restore: true } });     // an interrupt drops it, and its line comes back to the box
    await theAnswer(o, "uncertain");                               // the box isn't clear, so it is not typed again (FL16)
    await until("its card: May have been delivered", async () => (await ask(o.hub))?.decision?.delivery?.state === "uncertain", 15_000);
    expect(await o.hub.answer("ny-1", "hold")).toMatchObject({ status: 409, body: { error: "already_answered", item: { status: "answered" } } });
    expect(await o.hub.answer("ny-1", "ship", rid))                // the same request again: what became of it, nothing more
      .toMatchObject({ status: 200, body: { ok: true, item: { status: "answered", decision: { delivery: { state: "uncertain" } } } } });
    await sleep(PAST_A_TRY);
    expect((await ask(o.hub))?.status).toBe("answered");          // never asked again
    expect(recorded(o.hub)).toBe(0);                               // it may not have reached the manager (E13)
    expect(times(o.manager.submitted(), TAP)).toBe(1);
    expect(await answers(o.fleet)).toHaveLength(1);                // never queued again (no ~2)
  });
});

describe("a message cancelled (ruling 83)", () => {
  it("waiting behind the owner's draft: cancelled, and never typed; once a message is typed, its cancel is too late", async () => {
    const o = await office();
    o.manager.draft("the owner's half thought");                   // his own text in the box: a message waits (draft_present)
    await until("the draft in the manager's box", () => o.manager.screen().includes("the owner's half thought"));
    const rid = randomUUID();
    expect(await message(o, "never mind that", rid)).toMatchObject({ status: 200, body: { ok: true, delivery: { requestId: rid, state: "queued" } } });
    const waiting = await until("the message waiting for the draft", async () => {
      const d = await messageDelivery(o.fleet, rid);
      return d?.state === "queued" && d.waiting?.reason === "draft_present" ? d : null;
    }, 30_000, 250);
    expect(await cancel(o, rid)).toMatchObject({ status: 200, body: { ok: true, delivery: { requestId: rid, state: "given_up", why: "cancelled" } } });
    expect(await o.fleet.client.delivery(waiting.id)).toMatchObject({ state: "given_up", why: "cancelled" });
    expect(await cancel(o, rid)).toMatchObject({ status: 200, body: { delivery: { state: "given_up" } } });   // again: what it came to
    await o.manager.control({ clear: true });                      // the draft gone: the manager could take it now
    const later = randomUUID();
    expect((await message(o, "this one stays", later)).status).toBe(200);
    await until("the second message delivered", async () => (await messageDelivery(o.fleet, later))?.state === "delivered", 30_000);
    expect(await cancel(o, later)).toMatchObject({ status: 409, body: { error: "already_typed" } });
    await sleep(PAST_A_TRY);
    expect(times(o.manager.submitted(), "never mind that")).toBe(0);
    expect(times(o.manager.submitted(), "this one stays")).toBe(1);
  });
});

describe("answer in flight", () => {
  it("the hub killed after queuing an answer and before recording it records it once after its restart; typed once, delivered once", async () => {
    const o = await office();
    await o.manager.control({ status: "busy" });                   // a turn runs: the answer waits in the manager's own queue
    await statusIs(o, "busy");
    expect((await o.hub.answer("ny-1", "ship")).status).toBe(200);
    const held = await theAnswer(o, "held");
    expect(recorded(o.hub)).toBe(0);                               // queued counts as given (E8); recorded only once delivered (E13)
    await o.hub.restart({ signal: "SIGKILL", whileStopped: async () => {
      await o.manager.control({ prompt: true, status: "idle" });   // the turn ends, and the manager takes its queue
      await until("delivered while the hub was down", async () => (await o.fleet.client.delivery(held.id))?.state === "delivered", 30_000);
    } });
    await until("recorded after the restart", () => recorded(o.hub) === 1, 30_000);
    await until("its card Delivered", async () => (await ask(o.hub))?.decision?.delivery?.state === "delivered", 15_000);
    await sleep(PAST_A_TRY);
    expect(recorded(o.hub)).toBe(1);
    expect(times(o.manager.submitted(), TAP)).toBe(1);
    expect(await answers(o.fleet)).toHaveLength(1);                // no second delivery (no ~2)
  });
});

// The hub's database, copied while it is stopped (the file and its -wal and -shm), or put back from that copy.
function copyDb(hub: Hub, to: string) {
  const db = join(hub.home, "morndo.db");
  for (const s of ["", "-wal", "-shm"]) { rmSync(to + s, { force: true }); if (existsSync(db + s)) copyFileSync(db + s, to + s); }
}
function putBackDb(hub: Hub, from: string) {
  const db = join(hub.home, "morndo.db");
  for (const s of ["", "-wal", "-shm"]) { rmSync(db + s, { force: true }); if (existsSync(from + s)) copyFileSync(from + s, db + s); }
}
// An answer the queue typed into the manager, which the hub then no longer knows: the queue switched off, and the hub's
// database put back from a copy taken before the answer (§13: step 1's rollback restores the databases). The box writes no
// line for it (silent), so the restored hub sees no echo of the tap and takes ny-1 as open.
async function typedThenForgotten(o: Office): Promise<void> {
  const copy = join(o.hub.home, "morndo.db.before-the-answer");
  await o.hub.restart({ whileStopped: async () => { copyDb(o.hub, copy); } });
  await o.manager.control({ silent: true });
  expect((await o.hub.answer("ny-1", "ship")).status).toBe(200);
  await theAnswer(o, "typed");                                     // typed: the node holds its key, done
  expect(times(o.manager.submitted(), TAP)).toBe(1);
  await o.hub.restart({ managerQueue: false, whileStopped: async () => { putBackDb(o.hub, copy); } });
  await until("the start line: manager queue off", () => /manager queue: off \(MORNDO_MANAGER_QUEUE\)/.test(o.hub.log()), 15_000);
  await until("ny-1 open again: the restored hub never saw the answer", async () => (await ask(o.hub))?.status === "open", 15_000);
}

describe("switched off (MORNDO_MANAGER_QUEUE=off, step 2's rollback)", () => {
  it("an answer still queued is cancelled at start: Not delivered, its ask opens again, and a direct answer types it once", async () => {
    const o = await office();
    await o.manager.control({ status: "waiting" });                // a menu: the answer waits in the queue (menu_open)
    await statusIs(o, "waiting");
    const rid = randomUUID();
    expect((await o.hub.answer("ny-1", "ship", rid)).status).toBe(200);
    const queued = await until("ny-1's delivery waiting for the menu", async () =>
      (await answers(o.fleet)).find(d => d.state === "queued" && d.waiting?.reason === "menu_open") ?? null, 30_000, 250);
    await until("its card: queued, and why it waits", async () => (await ask(o.hub))?.waiting === "menu_open", 15_000);
    await o.hub.restart({ managerQueue: false });
    await until("the start line: manager queue off", () => /manager queue: off \(MORNDO_MANAGER_QUEUE\)/.test(o.hub.log()), 15_000);
    await until("cancelled at start", async () => (await o.fleet.client.delivery(queued.id))?.why === "cancelled", 15_000);
    expect(await o.fleet.client.delivery(queued.id)).toMatchObject({ state: "given_up", why: "cancelled" });
    await until("ny-1 open again", async () => (await ask(o.hub))?.status === "open", 15_000);
    expect((await ask(o.hub))?.notice).toMatch(/^Not delivered/);  // never typed: it reached no one (ruling 82)
    expect(await o.hub.answer("ny-1", "ship", rid)).toMatchObject({ status: 409, body: { error: "not_delivered" } });   // answering again is a new request
    await o.manager.control({ status: "idle" });
    await statusIs(o, "idle");
    expect(await o.hub.answer("ny-1", "ship")).toMatchObject({ status: 200, body: { ok: true } });
    await until("typed directly", () => times(o.manager.submitted(), TAP) === 1, 15_000);
    await sleep(PAST_A_TRY);
    expect(times(o.manager.submitted(), TAP)).toBe(1);
    expect(await answers(o.fleet)).toHaveLength(1);                // only the cancelled one: the direct answer queued nothing
  });

  // The race CI met on #94 (run 39684997329): the hub's cancel at start lands while the node is typing that very delivery
  // and is answered busy, "ask again". The node's cancelBusyTimes hook makes the first three cancels meet it every time;
  // the hub asks again and the answer still ends cancelled, never typed.
  it("an answer whose cancel at start is answered busy is asked again and still ends cancelled", async () => {
    const o = await office({ cancelBusyTimes: 3 });
    await o.manager.control({ status: "waiting" });
    await statusIs(o, "waiting");
    expect((await o.hub.answer("ny-1", "ship", randomUUID())).status).toBe(200);
    const queued = await until("ny-1's delivery waiting for the menu", async () =>
      (await answers(o.fleet)).find(d => d.state === "queued" && d.waiting?.reason === "menu_open") ?? null, 30_000, 250);
    await o.hub.restart({ managerQueue: false });
    await until("cancelled at start", async () => (await o.fleet.client.delivery(queued.id))?.why === "cancelled", 30_000);
    expect(o.hub.log()).toMatch(/cancelling it was refused \(busy\)/);   // the race was met, and asked again
    await until("ny-1 open again", async () => (await ask(o.hub))?.status === "open", 15_000);
    await sleep(PAST_A_TRY);
    expect(times(o.manager.submitted(), TAP)).toBe(0);
  });

  it("a direct retry of an answer already typed finds its key on the node and isn't typed again (§9.1)", async () => {
    const o = await office();
    await typedThenForgotten(o);
    const r = await o.hub.answer("ny-1", "ship");                   // the same answer, typed directly under the same key
    expect([200, 409]).toContain(r.status);                        // the node's stored outcome, or in doubt: never a second typing
    await sleep(PAST_A_TRY);
    expect(times(o.manager.submitted(), TAP)).toBe(1);
  });

  it("(negative control) without the node's done keys, that direct retry types the answer a second time", async () => {
    const o = await office({ noDoneKeys: true });
    await typedThenForgotten(o);
    expect((await o.hub.answer("ny-1", "ship")).status).toBe(200);
    await until("the second typing", () => times(o.manager.submitted(), TAP) === 2, 15_000);
  });
});
