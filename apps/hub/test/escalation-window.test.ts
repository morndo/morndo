// An ask outlives the conversation window (review of PR #2, finding F6). The hub rebuilds the manager's asks each poll
// from the newest CONVERSATION_CAP messages, so its button message scrolls out, and one failed `tmux list-panes`
// empties the history for a round. Neither is the asker closing the ask (E10), nor a new ask (E11), nor a reason to take
// a second Decision (E8). Synthetic sources: the domain's own Conversation for the window, a real ObservationService
// over a fake tmux and a synthetic transcript for the empty read, a synthetic needs-you list, a recording typist.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONVERSATION_CAP, Conversation, TAP_TTL_MS, endpointId, sessionId, type Message } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { localTranscripts } from "../src/adapters/local-node.ts";
import type { Tmux } from "../src/application/ports.ts";
import { EscalationService, type Watch } from "../src/application/escalation-service.ts";
import { ObservationService } from "../src/application/observation-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";

// The clocks are fake, so a slow box only stretches the wall time: a run past vitest's 5 s default would fail a test
// that held, the negative control included.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const T0 = Date.UTC(2026, 9, 1, 8);
const MIN = 60_000;
let now = T0;
let dir: string;
let store: Store;
let ledgerPath: string;
let sent: { pane: string; text: string }[];
let conversation: Conversation;
let workers: { id: string; name: string }[];

const auth = (): Authenticated => ({
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: now, lastSeenAt: now, verifiedAt: now, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
});
const agent = (id: string, at: number, text: string): Message => ({ id, at, author: { kind: "agent", name: "manager" }, kind: "text", text });
const principal = (id: string, at: number, text: string): Message => ({ id, at, author: { kind: "principal", name: "You" }, kind: "text", text });
// n newer messages in the manager's conversation, a second apart from `from` on
const chatter = (n: number, from: number) => conversation.add(Array.from({ length: n }, (_, i) => agent(`c${from}-${i}`, from + i * 1000, `Progress note ${i}.`)));
const writeLedger = (needsYou: unknown[]) => writeFileSync(ledgerPath, JSON.stringify({ needsYou, needsYouClosed: [] }));

// The manager's history as main.ts reads it: the latest CONVERSATION_CAP messages its Conversation keeps.
const windowed: Watch = {
  workers: () => workers,
  history: id => (id === "%0" ? conversation.latest(CONVERSATION_CAP) : []),
  openQuestions: () => [],
  screen: () => undefined,
};
const service = (watch: Watch = windowed) => new EscalationService({
  watch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
  send: async (pane, text) => { sent.push({ pane, text }); return { problem: null, typedAt: 0 }; },
});
const item = (s: EscalationService, id: string) => s.board().items.find(i => i.id === id);

beforeEach(() => {
  now = T0;
  dir = mkdtempSync(join(tmpdir(), "morndo-esc-window-"));
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  sent = [];
  workers = [{ id: "%0", name: "manager" }];
  conversation = new Conversation();
  // ny-7 is on the list, ny-8 is a list item without buttons; neither carries a "ts" (the adapter allows that).
  writeLedger([
    { id: "ny-7", kind: "tap", question: "Ship the demo release tonight?", default: "hold" },
    { id: "ny-8", kind: "tap", question: "Pick the launch date", default: "next Monday" },
  ]);
  conversation.add([
    agent("m1", T0 - MIN, "The demo release is ready.\n\n[buttons ny-7] ship=Ship it | hold=Hold for a day"),
    agent("m2", T0, "Release notes are drafted.\n\n[buttons rel-3] publish=Publish | wait=Wait"),   // not a list id: "age"
  ]);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("(a) an unanswered ask stays answerable when its message leaves the window", () => {
  it("negative control: 299 newer messages keep the button message in view, and the ask is open", () => {
    const s = service();
    s.poll();
    now = T0 + 30 * MIN;
    chatter(CONVERSATION_CAP - 1, now);              // m2 is still the oldest of the latest 300
    s.poll();
    expect(item(s, "rel-3")).toMatchObject({ status: "open", answerable: null });
  });
  it("an id not on the list stays open for its day after 300 newer messages, and a tap on it is delivered (E10)", async () => {
    const s = service();
    s.poll();
    expect(item(s, "rel-3")).toMatchObject({ status: "open", tracking: "age", answerable: null });
    now = T0 + 30 * MIN;
    chatter(CONVERSATION_CAP, now);
    s.poll();
    expect(item(s, "rel-3")).toMatchObject({ status: "open", answerable: null, decision: null });
    const r = await s.answer(auth(), "rel-3", { kind: "option", key: "publish" }, "r1");
    expect(r).toMatchObject({ ok: true });
    expect(sent).toEqual([{ pane: "%0", text: "[tap rel-3] publish (Publish)" }]);
  });
  it("it still expires a day after it was asked, as E10 says (not before, not by scrolling)", () => {
    const s = service();
    s.poll();
    now = T0 + 30 * MIN;
    chatter(CONVERSATION_CAP, now);
    s.poll();
    now = T0 + TAP_TTL_MS;
    s.poll();
    expect(item(s, "rel-3")).toMatchObject({ status: "expired", answerable: "expired" });
  });
  it("a list item open on the list keeps the options its message gave it after 300 newer messages", async () => {
    const s = service();
    s.poll();
    now = T0 + 30 * MIN;
    chatter(CONVERSATION_CAP, now);
    s.poll();
    expect(item(s, "ny-7")).toMatchObject({ status: "open", answerBy: "tap", options: [{ key: "ship" }, { key: "hold" }] });
    expect(await s.answer(auth(), "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: true });
    expect(sent).toEqual([{ pane: "%0", text: "[tap ny-7] ship (Ship it)" }]);
  });
});

// The hub's real Observation over a fake tmux whose `list-panes` fails once: tmuxAdapter returns [] for any failure
// (tmux.ts listWorkers), the Roster drops every worker, and Observation drops the conversations it followed.
function liveHub() {
  const transcript = join(dir, "manager.jsonl");
  writeFileSync(transcript, "");
  const line = (uuid: string, at: number, role: "assistant" | "user", text: string) => appendFileSync(transcript, `${JSON.stringify(role === "assistant"
    ? { type: "assistant", uuid, timestamp: new Date(at).toISOString(), message: { content: [{ type: "text", text }] } }
    : { type: "user", uuid, timestamp: new Date(at).toISOString(), message: { content: text } })}\n`);
  const tmux: Pick<Tmux, "listWorkers" | "captureMany"> & { fails: boolean } = {
    fails: false,
    listWorkers: async () => (tmux.fails ? [] : [{ id: "%0", name: "manager", location: "manager", node: "local", offline: false }]),
    captureMany: async ids => new Map(ids.map(id => [id, "❯ \n"])),
  };
  const sessions = {
    byPane: async () => new Map([["%0", { sessionId: "sess-1", name: null, pane: "%0", cwd: dir, version: "2.1.286", pid: process.pid }]]),
  };
  const observation = new ObservationService(tmux, 15_000, () => now, { sessions, transcripts: localTranscripts({ transcriptPath: () => transcript }) });
  const watch: Watch = {                                    // wired as main.ts wires it
    workers: () => observation.snapshot().workers.map(w => ({ id: w.id as string, name: w.name })),
    history: id => observation.history(id, CONVERSATION_CAP),
    openQuestions: id => observation.openQuestions(id),
    screen: id => observation.screen(id),
  };
  return { tmux, observation, watch, line };
}

describe("(a) one empty history read (a failed tmux list-panes) changes nothing", () => {
  it("the ask is still open during and after that round, and a tap on it is delivered", async () => {
    const hub = liveHub();
    hub.line("u1", T0, "assistant", "Release notes are drafted.\n\n[buttons rel-3] publish=Publish | wait=Wait");
    await hub.observation.poll();
    const s = service(hub.watch);
    s.poll();
    expect(item(s, "rel-3")).toMatchObject({ status: "open", answerable: null });

    now += 1500; hub.tmux.fails = true;                    // one observation round where list-panes failed
    await hub.observation.poll();
    expect(hub.watch.history("%0")).toEqual([]);           // the trigger is real: the round reads no history
    now += 500;
    s.poll();
    expect(item(s, "rel-3")).toMatchObject({ status: "open" });

    now += 1000; hub.tmux.fails = false;                   // the next round reads the transcript again
    await hub.observation.poll();
    expect(hub.watch.history("%0").length).toBeGreaterThan(0);
    now += 500;
    s.poll();
    expect(item(s, "rel-3")).toMatchObject({ status: "open", answerable: null });
    expect(await s.answer(auth(), "rel-3", { kind: "option", key: "publish" }, "r1")).toMatchObject({ ok: true });
    expect(sent).toEqual([{ pane: "%0", text: "[tap rel-3] publish (Publish)" }]);
  });
});

describe("(b) an answered list item stays answered (E8): no second Decision", () => {
  it("answered by a tap, then 300 newer messages: still answered, not asked again; a second answer is refused", async () => {
    const s = service();
    s.poll();
    expect(await s.answer(auth(), "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: true });
    conversation.add([principal("t1", now, "[tap ny-7] ship (Ship it)")]);   // the tap line the manager now has
    now = T0 + 30 * MIN;
    chatter(CONVERSATION_CAP, now);                                          // the list item stays open meanwhile
    s.poll();
    expect(item(s, "ny-7")).toMatchObject({ status: "answered", askedAgain: false, decision: { choice: { key: "ship" }, via: "here" } });
    const second = await s.answer(auth(), "ny-7", { kind: "words", text: "Hold it after all" }, "r2");   // "Something else…"
    expect(second).toMatchObject({ ok: false, problem: "already_answered" });
    expect(sent).toHaveLength(1);
    expect(store.audit(10).filter(a => a.type === "EscalationAnswered")).toHaveLength(1);
  });
  it("answered in words, then one empty history read: still answered once the history is back; a second answer is refused", async () => {
    const hub = liveHub();
    hub.line("u1", T0 - MIN, "assistant", "The demo release is ready.\n\n[buttons ny-7] ship=Ship it | hold=Hold for a day");
    await hub.observation.poll();
    const s = service(hub.watch);
    s.poll();
    expect(await s.answer(auth(), "ny-7", { kind: "words", text: "Ship it after the smoke test" }, "r1")).toMatchObject({ ok: true });
    hub.line("u2", now, "user", "About ny-7: Ship it after the smoke test");   // what the hub typed, now in the transcript

    now += 1500; hub.tmux.fails = true;
    await hub.observation.poll();
    now += 500;
    s.poll();
    now += 1000; hub.tmux.fails = false;
    await hub.observation.poll();
    now += 500;
    s.poll();
    expect(item(s, "ny-7")).toMatchObject({ status: "answered", askedAgain: false, decision: { choice: { kind: "words" } } });
    const second = await s.answer(auth(), "ny-7", { kind: "option", key: "hold" }, "r2");
    expect(second).toMatchObject({ ok: false, problem: "already_answered" });
    expect(sent).toHaveLength(1);
  });
  it("extension: answered in words, then a hub restart two hours later: the Decision still holds; a second is refused", async () => {
    const s = service();
    s.poll();
    expect(await s.answer(auth(), "ny-8", { kind: "words", text: "Monday the 12th" }, "r1")).toMatchObject({ ok: true });
    now = T0 + 120 * MIN;                                  // the list item is still open: the manager is on it
    const after = service();
    after.poll();
    expect(item(after, "ny-8")).toMatchObject({ status: "answered" });
    expect(await after.answer(auth(), "ny-8", { kind: "words", text: "Tuesday instead" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
    expect(sent).toHaveLength(1);
  });
});
