// Decisions end to end inside the hub, on synthetic sources: a fake manager conversation, a synthetic needs-you list
// on disk, and a recording typist instead of tmux.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId, type Message } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import type { SendProblem } from "@morndo/node-ops";
import { EscalationService, type Watch } from "../src/application/escalation-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";

const T0 = Date.UTC(2026, 9, 1, 8);
const MIN = 60_000;
let now = T0;
let dir: string;
let store: Store;
let ledgerPath: string;
let sent: { pane: string; text: string }[];
let refuse: SendProblem | null;
let manager: Message[];
let workers: { id: string; name: string }[];
let questions: Record<string, Message[]>;
let screens: Record<string, string>;

const auth = (verifiedAt = now): Authenticated => ({
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: verifiedAt, lastSeenAt: now, verifiedAt, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
});
const agent = (id: string, at: number, text: string): Message => ({ id, at, author: { kind: "agent", name: "manager" }, kind: "text", text });
const principal = (id: string, at: number, text: string): Message => ({ id, at, author: { kind: "principal", name: "You" }, kind: "text", text });
const writeLedger = (needsYou: unknown[], needsYouClosed: unknown[] = []) => writeFileSync(ledgerPath, JSON.stringify({ needsYou, needsYouClosed }));

const watch: Watch = {
  workers: () => workers,
  history: id => (id === "%0" ? manager : []),
  openQuestions: id => questions[id] ?? [],
  screen: id => screens[id],
};
const service = () => new EscalationService({
  watch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
  send: async (pane, text) => { if (refuse) return { problem: refuse, typedAt: 0 }; sent.push({ pane, text }); return { problem: null, typedAt: 0 }; },
});

beforeEach(() => {
  now = T0;
  dir = mkdtempSync(join(tmpdir(), "morndo-esc-"));
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  sent = []; refuse = null;
  workers = [{ id: "%0", name: "manager" }, { id: "%3", name: "builder" }];
  questions = {}; screens = {};
  manager = [agent("m1", T0 - MIN, "The demo release is ready. CI is green.\n\n[buttons ny-7] ship=Ship it | hold=Hold for a day")];
  writeLedger([
    { id: "ny-7", kind: "tap", question: "Ship the demo release tonight?", default: "hold", deadline: "2026-10-01", blocking: true, task: "demo" },
    { id: "ny-8", kind: "tap", question: "Pick the launch date", default: "next Monday" },
    { id: "ny-9", kind: "time", item: "Sign the venue contract", default: "not signed" },
  ]);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("what lands in the panel", () => {
  it("joins the list and the button message by id: the list's question and terms, the message's options and context", () => {
    const s = service();
    s.poll();
    const items = Object.fromEntries(s.board().items.map(i => [i.id, i]));
    expect(items["ny-7"]).toMatchObject({
      title: "Ship the demo release tonight?", answerBy: "tap", ifNoAnswer: "hold", blocking: true, project: "demo",
      options: [{ key: "ship", label: "Ship it" }, { key: "hold", label: "Hold for a day" }],
      context: "The demo release is ready. CI is green.", messageId: "m1", status: "open", answerable: null,
    });
    expect(items["ny-8"]).toMatchObject({ answerBy: "words", options: [] });
    expect(items["ny-9"]).toMatchObject({ need: "time" });
    expect(s.board().items.map(i => i.id)).toEqual(["ny-7", "ny-8", "ny-9"]);
  });
  it("a worker's open question lands with its options, answered on its screen; a menu shows the screen's last lines", () => {
    questions["%3"] = [{ id: "q1", at: T0, author: { kind: "agent", name: "builder" }, kind: "question", text: "Keep the old endpoint?", questionId: "toolu_1",
      questions: [{ question: "Keep the old endpoint?", header: "Endpoint", options: [{ label: "Keep", description: "One more release" }, { label: "Drop", description: null }], multiSelect: false }] }];
    workers.push({ id: "%4", name: "reviewer" });
    screens["%4"] = "work…\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel\n\n";
    const s = service();
    s.poll();
    const items = Object.fromEntries(s.board().items.map(i => [i.id, i]));
    expect(items["q-toolu_1"]).toMatchObject({ asker: { kind: "worker", name: "builder", workerId: "%3" }, answerBy: "screen", answerable: "on_screen",
      options: [{ key: "1", label: "Keep", detail: "One more release" }, { key: "2", label: "Drop", detail: null }] });
    expect(items["menu-4"]).toMatchObject({ contextKind: "screen", answerBy: "screen" });
    expect(items["menu-4"]?.context?.endsWith("Esc to cancel")).toBe(true);
  });
});

describe("answering", () => {
  it("types the tap line into the manager's pane, records the Decision with its provenance, and audits it", async () => {
    const s = service();
    s.poll();
    const r = await s.answer(auth(), "ny-7", { kind: "option", key: "ship" }, "req-1");
    expect(r.ok).toBe(true);
    expect(sent).toEqual([{ pane: "%0", text: "[tap ny-7] ship (Ship it)" }]);
    expect(r.item).toMatchObject({ status: "answered", decision: { choice: { kind: "option", key: "ship", label: "Ship it" }, via: "here", endpointId: "ep1" } });
    expect(store.audit(5).find(a => a.type === "EscalationAnswered")?.body).toMatchObject({ escalationId: "ny-7", choice: { key: "ship" }, endpointId: "ep1", sessionId: "s1" });
  });
  it("refuses a second answer and types nothing; the same request repeated is not a second answer", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-7", { kind: "option", key: "ship" }, "req-1");
    expect((await s.answer(auth(), "ny-7", { kind: "option", key: "ship" }, "req-1")).ok).toBe(true);
    const second = await s.answer(auth(), "ny-7", { kind: "option", key: "hold" }, "req-2");
    expect(second).toMatchObject({ ok: false, problem: "already_answered" });
    expect(sent).toHaveLength(1);
  });
  it("needs a fresh passkey check under the policy (AC7): nothing is typed without it", async () => {
    const s = service();
    s.poll();
    const r = await s.answer(auth(now - 2 * 3_600_000), "ny-7", { kind: "option", key: "ship" }, "req-1");
    expect(r).toMatchObject({ ok: false, problem: "step_up" });
    expect(sent).toEqual([]);
  });
  it("an option that isn't on the ask is refused (negative control for the label coming from the ask)", async () => {
    const s = service();
    s.poll();
    expect(await s.answer(auth(), "ny-7", { kind: "option", key: "deploy-prod" }, "r")).toMatchObject({ ok: false, problem: "bad_option" });
    expect(sent).toEqual([]);
  });
  it("words go to the manager with the item's id; the audit keeps their length and a hash, never the words", async () => {
    const s = service();
    s.poll();
    const r = await s.answer(auth(), "ny-8", { kind: "words", text: "Monday the 12th works" }, "r");
    expect(r.ok).toBe(true);
    expect(sent[0]?.text).toBe("About ny-8: Monday the 12th works");
    const body = JSON.stringify(store.audit(5));
    expect(body).not.toContain("Monday the 12th");
    expect(store.audit(5).find(a => a.type === "EscalationAnswered")?.body).toMatchObject({ length: 21 });
  });
  it("a refused delivery (a menu open in the manager's pane) records nothing; it can be answered again", async () => {
    const s = service();
    s.poll();
    refuse = "menu_open";
    expect(await s.answer(auth(), "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: false, problem: "menu_open" });
    expect(s.board().items.find(i => i.id === "ny-7")?.status).toBe("open");
    refuse = null;
    expect((await s.answer(auth(), "ny-7", { kind: "option", key: "ship" }, "r2")).ok).toBe(true);
  });
  it("closed on the list a moment ago: refused, with how it was settled", async () => {
    const s = service();
    s.poll();
    writeLedger([{ id: "ny-7", kind: "tap", question: "Ship?", status: "closed", answer: "Shipped by hand", closedAt: "2026-10-01T09:59:00Z" }]);
    const r = await s.answer(auth(), "ny-7", { kind: "option", key: "ship" }, "r");
    expect(r).toMatchObject({ ok: false, problem: "settled", item: { resolution: "Shipped by hand" } });
    expect(sent).toEqual([]);
  });
  it("an unreadable list refuses answers (fails closed) and keeps the items", async () => {
    const s = service();
    s.poll();
    writeFileSync(ledgerPath, "{ half-written");
    expect(await s.answer(auth(), "ny-7", { kind: "option", key: "ship" }, "r")).toMatchObject({ ok: false, problem: "cant_check" });
    expect(s.board().items.find(i => i.id === "ny-8")?.status).toBe("open");
    expect(s.board().ledger.ok).toBe(false);
    expect(s.board().items.find(i => i.id === "ny-7")).toMatchObject({ title: "Ship the demo release tonight?", blocking: true });   // the list's wording stays
  });
  it("a tap from another endpoint (the chat bot) seen in the manager's conversation counts as answered there", async () => {
    manager.push(principal("m2", T0, "[tap ny-7] hold (Hold for a day)"));
    const s = service();
    s.poll();
    expect(s.board().items.find(i => i.id === "ny-7")).toMatchObject({ status: "answered", decision: { via: "elsewhere", choice: { key: "hold" } } });
    expect(await s.answer(auth(), "ny-7", { kind: "option", key: "ship" }, "r")).toMatchObject({ ok: false, problem: "already_answered" });
  });
  it("a Decision survives a restart of the hub", async () => {
    const s = service();
    s.poll();
    await s.answer(auth(), "ny-7", { kind: "option", key: "ship" }, "r");
    const after = service();
    after.poll();
    expect(after.board().items.find(i => i.id === "ny-7")?.status).toBe("answered");
    expect(await after.answer(auth(), "ny-7", { kind: "option", key: "hold" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
  });
  it("pushes the board to subscribers when something changed", async () => {
    const s = service();
    const boards: number[] = [];
    s.subscribe(b => boards.push(b.items.length));
    s.poll();
    s.poll();
    expect(boards).toEqual([3]);
  });
  it("a source that throws doesn't stop the polling (negative control: it polls again after)", async () => {
    let calls = 0;
    const s = new EscalationService({
      watch: { ...watch, workers: () => { calls++; if (calls === 1) throw new Error("tmux gone"); return workers; } },
      ledger: null, store, managerName: "manager", send: async () => ({ problem: null, typedAt: 0 }), now: () => now,
    });
    const errors: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      s.start(20);
      await new Promise(r => setTimeout(r, 120));
    } finally { s.stop(); process.stderr.write = orig; }
    expect(errors.filter(e => e.includes("decisions poll failed")).length).toBe(1);
    expect(calls).toBeGreaterThan(2);
  });
});

// Review of PR #7, finding 5: the phone holds an answer for 5 s before it goes, so it carries the version of the ask it
// was given for; restated meanwhile (new wording, the same id), the ask doesn't take the old answer.
describe("an answer given for one version of an ask", () => {
  it("is refused as changed when the ask was restated meanwhile, and nothing is typed; for the current version it goes", async () => {
    const s = service();
    s.poll();
    const seen = s.board().items.find(i => i.id === "ny-7")?.version;
    expect(typeof seen).toBe("string");
    now += MIN;
    manager = [...manager, agent("m2", now, "CI is red now.\n\n[buttons ny-7] ship=Ship it | hold=Hold for a day")];
    const r = await s.answer(auth(), "ny-7", { kind: "option", key: "ship" }, "req-1", seen);
    expect(r).toMatchObject({ ok: false, problem: "changed" });
    expect(sent).toEqual([]);
    const fresh = s.board().items.find(i => i.id === "ny-7")?.version;
    expect(fresh).not.toBe(seen);
    expect((await s.answer(auth(), "ny-7", { kind: "option", key: "ship" }, "req-2", fresh)).ok).toBe(true);
    expect(sent.map(x => x.text)).toEqual(["[tap ny-7] ship (Ship it)"]);
  });
  it("without a version (the desktop answers at once), it is judged as before", async () => {
    const s = service();
    s.poll();
    expect((await s.answer(auth(), "ny-7", { kind: "option", key: "ship" }, "req-1")).ok).toBe(true);
  });
});

// Stage-4 review of 489a1ad..8a598fa, finding 2: a menu on a worker's screen keeps one version while it shows (a redraw,
// a spinner or output above it is the same ask), so "kept for later" holds; another menu is another version.
describe("the version of a menu on a worker's screen", () => {
  it("stays while the same menu shows, whatever changes around it, and changes for another menu", () => {
    workers = [...workers, { id: "%4", name: "deployer" }];
    const menu = (above: string, question = "Do you want to proceed?") => `${above}\n ${question}\n ❯ 1. Yes\n   2. No\n Esc to cancel\n\n`;
    const s = service();
    screens["%4"] = menu("⠋ Working… (3s)");
    s.poll();
    const v1 = s.board().items.find(i => i.id === "menu-4")?.version;
    screens["%4"] = menu("⠙ Working… (4s)\nwrote 2 files");
    s.poll();
    expect(s.board().items.find(i => i.id === "menu-4")?.version).toBe(v1);
    screens["%4"] = menu("⠙ Working… (5s)", "Allow the deploy to production?");
    s.poll();
    expect(s.board().items.find(i => i.id === "menu-4")?.version).not.toBe(v1);
  });
});

// The list's short form (the owner's feedback on the phone, 2026-10-04): what the list says of an item in a few words
// reaches the board as it is; its own options make it answerable by a tap; and its kind decides decision or task.
describe("the list's short form", () => {
  it("reaches the board next to the long question", () => {
    writeLedger([{ id: "ny-9", kind: "time", item: "Sign the venue contract: print it, sign page 4 and send it back", title: "Sign the venue contract", summary: "Print, sign page 4 and send it back.", minutes: 10, link: "https://example.com/contract", details: "Page 4 only." }]);
    const s = service();
    s.poll();
    expect(s.board().items.find(i => i.id === "ny-9")).toMatchObject({
      need: "time", title: "Sign the venue contract: print it, sign page 4 and send it back", shortTitle: "Sign the venue contract",
      summary: "Print, sign page 4 and send it back.", minutes: 10, link: "https://example.com/contract", details: "Page 4 only.",
    });
    expect(s.board().items.find(i => i.id === "ny-7")).toMatchObject({ shortTitle: null, summary: null, minutes: null, link: null, details: null });
  });
  it("its own options make it a tap, the recommended first; the tap reaches the manager as its tap line", async () => {
    writeLedger([{ id: "ny-8", kind: "tap", question: "Pick the launch date", options: [{ key: "mon", label: "Next Monday" }, { key: "fri", label: "Friday" }, { key: "later", label: "After the fair" }] }]);
    const s = service();
    s.poll();
    expect(s.board().items.find(i => i.id === "ny-8")).toMatchObject({ answerBy: "tap", options: [{ key: "mon", label: "Next Monday", detail: null }, { key: "fri", label: "Friday", detail: null }, { key: "later", label: "After the fair", detail: null }] });
    expect((await s.answer(auth(), "ny-8", { kind: "option", key: "fri" }, "req-1")).ok).toBe(true);
    expect(sent).toEqual([{ pane: "%0", text: "[tap ny-8] fri (Friday)" }]);
  });
  it("the list's kind decides: a task stays a task when the manager posts buttons for it too; a button message keeps its options", () => {
    manager.push(agent("m2", T0, "Your hands are needed for the contract.\n\n[buttons ny-9] now=Doing it now | later=Later today"));
    const s = service();
    s.poll();
    expect(s.board().items.find(i => i.id === "ny-9")).toMatchObject({ need: "time", answerBy: "tap", options: [{ key: "now", label: "Doing it now" }, { key: "later", label: "Later today" }] });
    expect(s.board().items.find(i => i.id === "ny-7")).toMatchObject({ need: "decision", answerBy: "tap" });
  });
});
