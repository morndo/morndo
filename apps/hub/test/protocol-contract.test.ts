// The hub's real output fits the protocol the app decodes it with (ADR-0008 A2, review M1): what ObservationService,
// the transcript adapter and EscalationService produce, sent as the hub sends it (JSON), decodes "ok" and loses
// nothing, including what tmux and transcripts allow but a careful schema might not expect: long window names, a huge
// pasted message, unicode. Synthetic data only; fake tmux, a temp transcript, a fake needs-you list.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Conversation, DEFAULT_POLICY, WORKER_ASK_GRACE_MS } from "@morndo/domain";
import { localTranscriptBytes } from "@morndo/node-ops";
import { ServerFeedFrames, decode } from "@morndo/protocol";
import { followTranscript } from "../src/adapters/claude-sessions.ts";
import { Store } from "../src/adapters/store.ts";
import { BoardService } from "../src/application/board-service.ts";
import { ObservationService } from "../src/application/observation-service.ts";
import { EscalationService } from "../src/application/escalation-service.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-contract-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const wire = (m: unknown) => decode(ServerFeedFrames, JSON.stringify(m));

describe("the hub's own frames decode in the app", () => {
  it("a snapshot of odd workers: a 300-character window name, unicode, an emoji", async () => {
    const workers = [
      { id: "%1", name: "w".repeat(300), location: "/work/" + "deep/".repeat(200), node: "local", offline: false },
      { id: "%2", name: "review·ü·中文·🚀", location: "/tmp", node: "local", offline: false },
    ];
    const obs = new ObservationService({ listWorkers: async () => workers, captureMany: async ids => new Map(ids.map(id => [id, "$ "])) }, 1000);
    await obs.poll();
    const d = wire({ t: "snapshot", ...obs.snapshot() });
    expect(d.kind).toBe("ok");
    expect(d.kind === "ok" && d.frame.t === "snapshot" ? d.frame.workers.map(w => w.name) : []).toEqual(workers.map(w => w.name));
  });
  it("a history read from a transcript, with a 3-million-character paste", async () => {
    const path = join(dir, "s.jsonl");
    const t = (min: number) => new Date(Date.UTC(2026, 9, 2, 9, min)).toISOString();
    writeFileSync(path, [
      { type: "user", uuid: "u1", timestamp: t(0), origin: { kind: "human" }, message: { role: "user", content: "x".repeat(3_000_000) } },
      { type: "assistant", uuid: "a1", timestamp: t(1), message: { role: "assistant", content: [{ type: "text", text: "Read it all." }, { type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
      { type: "assistant", uuid: "a2", timestamp: t(2), message: { role: "assistant", content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Keep it?", header: "Keep", multiSelect: false, options: [{ label: "Yes", description: "d" }, { label: "No", description: "e" }] }] } }] } },
    ].map(l => JSON.stringify(l)).join("\n") + "\n");
    const c = new Conversation();
    c.add((await followTranscript(localTranscriptBytes(path), { offset: 0, pending: new Set() }, "builder", { tailBytes: 8 << 20 })).entries);
    const messages = c.latest(300);
    expect(messages.length).toBeGreaterThanOrEqual(3);
    const d = wire({ t: "history", worker: "%1", messages, session: { name: null, cwd: "/w", version: "2.1.286" } });
    expect(d.kind === "ok" && d.frame.t === "history" ? d.frame.messages.length : -1).toBe(messages.length);
  });
  it("the decisions board, with list items and a worker's question", () => {
    const store = new Store(join(dir, "data"));
    try {
      const now = Date.UTC(2026, 9, 2, 9);
      const svc = new EscalationService({
        watch: {
          workers: () => [{ id: "%0", name: "manager" }, { id: "%1", name: "reviewer" }],
          history: () => [],
          openQuestions: id => (id === "%1" ? [{ id: "a2", at: now - WORKER_ASK_GRACE_MS - 1000, author: { kind: "agent", name: "reviewer" }, kind: "question", text: "Keep it?", questionId: "q1",
            questions: [{ question: "Keep it?", header: "Keep", multiSelect: false, options: [{ label: "Yes", description: null }] }] }] : []),
          screen: () => "$ ",
        },
        ledger: () => ({ ok: true, at: now, items: [
          { id: "ny-1", need: "decision", title: "T".repeat(5000), shortTitle: "Ship it", summary: "S".repeat(300), minutes: 5, options: [{ key: "a", label: "A" }], link: "https://example.com/x", details: "D".repeat(4000),
            ifNoAnswer: null, recommendation: null, deadline: null, blocking: true, project: null, addedAt: now - 5000, open: true, resolution: null, closedAt: null },
        ] }),
        store, managerName: "manager", send: async () => ({ problem: null, typedAt: 0 }), now: () => now,
      });
      svc.poll();
      const board = svc.board();
      expect(board.items.length).toBeGreaterThanOrEqual(2);
      const d = wire({ t: "decisions", ...board });
      expect(d.kind === "ok" && d.frame.t === "decisions" ? d.frame.items.length : -1).toBe(board.items.length);
    } finally { store.close(); }
  });
  it("the board frame, with the to do tasks whose lane the fleet no longer lists (B2, orphans)", () => {
    const store = new Store(join(dir, "data"));
    try {
      const board = new BoardService({
        store, now: () => 1, policy: () => DEFAULT_POLICY,
        orphans: ts => ts.filter(t => t.assignee === "ghost").map(t => t.key),
      });
      const manager = { kind: "manager", name: "manager", token: "t" } as const;
      board.create({ title: "A", assignee: "builder" }, manager);
      board.create({ title: "B", assignee: "ghost" }, manager);
      const d = wire({ t: "board", ...board.view() });
      expect(d.kind).toBe("ok");
      expect(d.kind === "ok" && d.frame.t === "board" ? d.frame.orphans : undefined).toEqual(["T-2"]);
      // A hub from before the field, with no orphans at all, still parses.
      const old = wire({ t: "board", tasks: [], lanes: [], at: 1 });
      expect(old.kind).toBe("ok");
      expect(old.kind === "ok" && old.frame.t === "board" ? "orphans" in old.frame : null).toBe(false);
    } finally { store.close(); }
  });
});
