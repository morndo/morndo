// An answer carries a key to the asker's node (fleet core §3.1, §9 "Retry and duplicates" (c)): answer:<id>:<ask>:<choice>.
// The node keeps what it typed by key, as the agent does, so an answer retried after the connection dropped once the
// line was pasted is typed once; and a question asked again is a new ask, so the same choice for it is typed again.
// Both configurations (spec §9): the legacy hub's port drops the connection after its first paste (it throws); in fleet
// mode the node sits behind the fake fleet, which keeps the keys and loses its first answer after the paste. Synthetic
// list and conversation.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId, type Message } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { answerKey } from "../src/application/escalation-service.ts";
import type { SendOutcome, Tmux } from "../src/application/ports.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { LOST } from "./helpers/fake-fleet.ts";
import { HUB_MODES, escalationsFor, portsFor, type HubMode, type ModePorts } from "./helpers/hub-mode.ts";

const T0 = Date.UTC(2026, 9, 6, 8);
let dir: string;
let store: Store;
let ledgerPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-answer-keys-"));
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-7", kind: "tap", question: "Ship the demo release tonight?", default: "hold" }], needsYouClosed: [] }));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const auth: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: T0, lastSeenAt: T0, verifiedAt: T0, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: T0, revokedAt: null },
};
const asked = (id: string, at: number): Message => ({ id, at, author: { kind: "agent", name: "manager" }, kind: "text", text: "Ready.\n\n[buttons ny-7] ship=Ship it | hold=Hold for a day" });

// The manager's pane %0: types, keeps the key's outcome (a key it typed answers that, not typed again). In legacy mode
// its first `drops` sends drop the connection after the paste (throw); in fleet mode the fake fleet loses those answers.
function node(mode: HubMode, drops: number) {
  const typed: { pane: string; text: string; key: string }[] = [];
  const done = new Map<string, SendOutcome>();
  let lose = drops;
  const tmux: Tmux = {
    listWorkers: async () => [{ id: "%0", name: "manager", location: "manager", node: "local", offline: false }],
    capture: async () => "❯ ", captureMany: async ids => new Map(ids.map(id => [id, "❯ "])),
    send: async (pane, text, key) => {
      const known = done.get(key);
      if (known) return known;                                         // typed before: its outcome, not typed again
      typed.push({ pane, text, key });
      done.set(key, { problem: null, typedAt: T0 });
      if (mode === "legacy" && lose-- > 0) throw new Error("fleet: connection lost after the paste");
      return { problem: null, typedAt: T0 };
    },
  };
  const loseFirst = (ports: ModePorts) => {
    if (mode !== "fleet") return;
    let left = drops;
    ports.rig?.fleet.intercept("pane.send", async (_call, next) => { const r = await next(); return left-- > 0 ? LOST : r; });
  };
  return { tmux, typed, loseFirst };
}

describe.each(HUB_MODES)("answers and their keys, %s hub", mode => {
  let ports: ModePorts | null = null;
  let manager: Message[] = [];
  let clock = T0;
  beforeEach(() => { manager = [asked("m1", T0 - 60_000)]; clock = T0; });
  afterEach(async () => { await ports?.close(); ports = null; });
  const atNode = (key: string) => (mode === "fleet" ? `hub:${key}` : key);
  // The first attempt, its answer lost after the paste: "uncertain" (409, "may have been sent"). Fleet: the node may have
  // typed it (SendInDoubt; final review I1). Legacy: the port's throw may come after the paste, so the row is kept too
  // (ADR-0008, phase C).
  const inDoubt = async (first: Promise<unknown>) => { expect(await first).toMatchObject({ ok: false, problem: "uncertain" }); };
  // Its repeat: the fleet asks the node, which typed it (delivered, recorded once); the legacy hub can ask nobody, so it
  // stays uncertain and nothing is typed again.
  const repeated = mode === "fleet" ? { ok: true } : { ok: false, problem: "uncertain" };
  // A service on the same ports and the same store: calling it again is a hub restart. On another store: a hub whose
  // database knows nothing of the answers before it.
  const build = (p: ModePorts, ledger: boolean, screen: (id: string) => string | undefined = () => undefined, on: Store = store) => escalationsFor(p, {
    store: on, now: () => clock, ledger: ledger ? ledgerReader(ledgerPath, () => clock) : null,
    watch: { workers: () => [{ id: p.id("%0"), name: "manager" }, { id: p.id("%4"), name: "alpha" }], history: id => (id === p.id("%0") ? manager : []), openQuestions: () => [], screen },
  });
  const start = async (n: ReturnType<typeof node>) => {
    ports = await portsFor(mode, { tmux: n.tmux });
    n.loseFirst(ports);
    return build(ports, true);
  };

  it("an answer retried after the connection dropped is typed once: the retry carries the same key and gets the node's outcome", async () => {
    const n = node(mode, 1);
    const s = await start(n);
    s.poll();
    await inDoubt(s.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r1"));
    expect(await s.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject(repeated);
    expect(n.typed).toEqual([{ pane: "%0", text: "[tap ny-7] ship (Ship it)", key: atNode("answer:ny-7:m1:option:ship") }]);
    expect(store.audit(10).filter(a => a.type === "EscalationAnswered")).toHaveLength(mode === "fleet" ? 1 : 0);
  });

  // The key is made of the ask and the choice alone, by whichever hub makes it, and the node keeps what it typed by key.
  // So with the hub's own row of the answer gone (its database lost, or restored from before the answer), the hub's
  // in-doubt checks have nothing to find, and the node's record of the key is what keeps it from being typed twice.
  it("the same answer to the same ask carries the same key from any hub: with the hub's row of it gone, the node still types it once", async () => {
    const n = node(mode, 0);
    const s = await start(n);
    s.poll();
    expect(await s.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: true });
    const lostDir = mkdtempSync(join(tmpdir(), "morndo-answer-keys-lost-"));
    const lost = new Store(lostDir);                                   // the hub's database, without that answer
    try {
      const again = build(ports!, true, undefined, lost);
      again.poll();
      expect(await again.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r2")).toMatchObject({ ok: true });
      expect(n.typed).toEqual([{ pane: "%0", text: "[tap ny-7] ship (Ship it)", key: atNode("answer:ny-7:m1:option:ship") }]);
    } finally {
      lost.close();
      rmSync(lostDir, { recursive: true, force: true });
    }
  });

  it("a question asked again is a new ask: the same tap is typed once for each ask, never lost to the first one's key", async () => {
    const n = node(mode, 0);
    const s = await start(n);
    s.poll();
    expect(await s.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: true });
    manager = [...manager, asked("m2", T0 - 30_000)];                  // the manager asks ny-7 again, a newer message
    s.poll();
    expect(await s.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r2")).toMatchObject({ ok: true });
    expect(n.typed.map(t => t.key)).toEqual([atNode("answer:ny-7:m1:option:ship"), atNode("answer:ny-7:m2:option:ship")]);
  });

  // An ask with no message of its own (a list item that has no buttons message) is dated by when the hub first saw it; that
  // time is kept in the database, so its key is the same after a restart (review F1).
  it("an ask without a message, across a hub restart: a retry after the restart is typed once: the new service on the same store dates the ask as the first did", async () => {
    manager = [];
    const words = { kind: "words", text: "Monday" } as const;
    const n = node(mode, 1);
    const first = await start(n);
    first.poll();
    await inDoubt(first.answer(auth, "ny-7", words, "r1"));
    clock = T0 + 90_000;                                               // the hub was down for a while
    const restarted = build(ports!, true);                             // a new service on the same database
    restarted.poll();
    expect(await restarted.answer(auth, "ny-7", words, "r1")).toMatchObject(repeated);
    expect(n.typed).toHaveLength(1);
    expect(n.typed[0]?.key).toMatch(new RegExp(`^${atNode(`answer:ny-7:t${T0}:words:`)}`));
    expect(store.askFirstSeen().get("ledger:ny-7")).toBe(T0);          // the persisted row kept
  });

  // A new tap of the same words after the restart (another request) finds the answer in doubt by its key alone, so the
  // key must be the first one's: the ask's first-seen time is read back from the database, not taken anew.
  it("an ask without a message, across a hub restart: a new tap of the same words after the restart is typed once: it carries the first's key, its time read back from the database", async () => {
    manager = [];
    const words = { kind: "words", text: "Monday" } as const;
    const n = node(mode, 1);
    const first = await start(n);
    first.poll();
    await inDoubt(first.answer(auth, "ny-7", words, "r1"));
    clock = T0 + 90_000;                                               // the hub was down for a while
    const restarted = build(ports!, true);                             // a new service on the same database
    restarted.poll();
    const tapped = await restarted.answer(auth, "ny-7", words, "r2");   // a new request, not a retry of r1
    expect(n.typed).toHaveLength(1);
    expect(tapped).toMatchObject(repeated);
  });

  it("an ask that went off a readable list is forgotten, and when it comes back it is a new ask with a new time", async () => {
    manager = [];
    const s = await start(node(mode, 0));
    s.poll();
    expect(store.askFirstSeen().get("ledger:ny-7")).toBe(T0);
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [], needsYouClosed: [] }));
    s.poll();
    expect(store.askFirstSeen().size).toBe(0);
    clock = T0 + 120_000;
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-7", kind: "tap", question: "Ship the demo release tonight?", default: "hold" }], needsYouClosed: [] }));
    s.poll();
    expect(store.askFirstSeen().get("ledger:ny-7")).toBe(T0 + 120_000);
  });
});

// Legacy only: the menu item and its store key ("menu-4", "menu:%4") are built from the tmux pane id, which in fleet mode is a worker id.
// A menu is answered on its screen (the hub types nothing for it), so what is checked is the time its key is made of:
// the ask's askedAt, which must not be restamped by a poll that has no screen to read.
describe("a menu ask kept across a restart", () => {
  let clock = T0;
  beforeEach(() => { clock = T0; });
  it("a menu ask keeps its first-seen time when its screen is not read after the restart (null is no news)", async () => {
    const MENU = "work\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel\n\n";
    let screen: string | undefined = MENU;
    const p = await portsFor("legacy", { tmux: node("legacy", 0).tmux });
    const mk = () => escalationsFor(p, {
      store, now: () => clock, ledger: null,
      watch: { workers: () => [{ id: "%0", name: "manager" }, { id: "%4", name: "alpha" }], history: () => [], openQuestions: () => [], screen: id => (id === "%4" ? screen : undefined) },
    });
    const askedAt = (s: ReturnType<typeof mk>) => s.board().items.find(i => i.id === "menu-4")?.askedAt;
    const first = mk();
    first.poll();
    expect(askedAt(first)).toBe(T0);
    clock = T0 + 90_000;
    screen = undefined;                                                // after the restart: not read yet
    const restarted = mk();
    restarted.poll();
    expect(store.askFirstSeen().get("menu:%4")).toBe(T0);
    screen = MENU;
    restarted.poll();
    expect(askedAt(restarted)).toBe(T0);                               // the same ask, the same time, so the same key
    screen = "work\n❯ \n";                                            // read, and no menu: it is gone
    restarted.poll();
    expect(store.askFirstSeen().has("menu:%4")).toBe(false);
  });
});

describe("answerKey", () => {
  it("names the ask and the choice; words go by their digest, never as they are", () => {
    const ask = { messageId: "m1", askedAt: T0 };
    expect(answerKey("ny-7", ask, { kind: "option", key: "ship" })).toBe("answer:ny-7:m1:option:ship");
    expect(answerKey("ny-7", { messageId: null, askedAt: T0 }, { kind: "option", key: "ship" })).toBe(`answer:ny-7:t${T0}:option:ship`);
    const words = answerKey("ny-8", ask, { kind: "words", text: "  Monday the 12th " });
    expect(words).toMatch(/^answer:ny-8:m1:words:[0-9a-f]{16}$/);
    expect(words).toBe(answerKey("ny-8", ask, { kind: "words", text: "Monday the 12th" }));
    expect(words).not.toContain("Monday");
    expect(answerKey("ny-8", ask, { kind: "words", text: "Tuesday" })).not.toBe(words);
  });
});
