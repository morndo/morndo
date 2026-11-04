// The block gate in the hub (T-805, B21, ADR-0041): MORNDO_BLOCK_GATE off, warn or on, unset warned until 2026-11-12
// and refusing from then, the setting winning over the date; and the gate a lane's or the manager's block passes in
// BoardService — a refusal no_wait once on, an event marked unwatched while warn, the answer the agents' route returns
// carrying it. Real store and service, the clock the test's own.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "@morndo/domain";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/adapters/store.ts";
import { BoardService } from "../src/application/board-service.ts";

const T0 = 1_800_000_000_000;
const FROM = Date.parse("2026-11-12T00:00:00Z");              // unset, the gate refuses from here (the one week approved)
const MANAGER = { kind: "manager", name: "manager", token: "tok-m" } as const;
const BUILDER = { kind: "worker", name: "builder", token: "tok-w" } as const;

describe("MORNDO_BLOCK_GATE", () => {
  it("unset warns before 2026-11-12 and refuses from then on; an explicit off, warn or on wins over the date", () => {
    expect(loadConfig({}).blockGate(FROM - 1)).toEqual({ mode: "warn", from: FROM });
    expect(loadConfig({}).blockGate(FROM)).toEqual({ mode: "on", from: FROM });
    for (const v of ["off", "warn", "on"] as const) {
      expect(loadConfig({ MORNDO_BLOCK_GATE: v }).blockGate(FROM), v).toEqual({ mode: v, from: FROM });
      expect(loadConfig({ MORNDO_BLOCK_GATE: v }).blockGate(0), v).toEqual({ mode: v, from: FROM });
    }
  });
  it("any other value is refused in one sentence naming the three, as the proof gate's is", () => {
    expect(() => loadConfig({ MORNDO_BLOCK_GATE: "bogus" })).toThrow(/MORNDO_BLOCK_GATE/);
    expect(() => loadConfig({ MORNDO_BLOCK_GATE: "bogus" })).toThrow(/off.*warn.*on/);
  });
});

describe("the gate in BoardService (B21)", () => {
  let dir: string;
  let store: Store;
  let board: BoardService;
  let now: number;
  // A board over the same directory with the gate as asked; `null` wires none, as a board without the hub's setting.
  const open = (mode: "off" | "warn" | "on" | null) => {
    store = new Store(dir);
    board = new BoardService({ store, now: () => now, policy: () => DEFAULT_POLICY, ...(mode !== null ? { blockGate: () => ({ mode, from: FROM }) } : {}) });
  };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-block-gate-")); now = T0; });
  afterEach(() => { board.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  // A task of builder's, in progress, at T0: what a block blocks.
  const doing = (): string => {
    const made = board.create({ title: "Ship it", assignee: "builder" }, MANAGER);
    if (!made.ok) throw new Error(made.problem);
    const started = board.act(made.task.key, { action: "move", to: "doing" }, BUILDER);
    if (!started.ok) throw new Error(started.problem);
    return made.task.key;
  };

  it("on: a lane's block with no --on is refused no_wait; with --on until:… the wait is stored", () => {
    open("on");
    const key = doing();
    now = T0 + 1000;
    const refused = board.act(key, { action: "move", to: "blocked", reason: "needs the API key" }, BUILDER);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.problem).toBe("no_wait");
    const at = now + 2 * 24 * 3_600_000;
    const stored = board.act(key, { action: "move", to: "blocked", reason: "needs the API key", waits: [`until:${new Date(at).toISOString()}`] }, BUILDER);
    expect(stored.ok, JSON.stringify(stored)).toBe(true);
    expect(board.task(key)?.task.waits).toEqual([{ kind: "time", at }]);
  });

  it("on: the manager's block is gated the same", () => {
    open("on");
    const key = doing();
    const refused = board.act(key, { action: "move", to: "blocked", reason: "waiting on the owner" }, MANAGER);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.problem).toBe("no_wait");
  });

  it("warn: the block is accepted, and the answer the agents' route returns (the move's event) carries unwatched", () => {
    open("warn");
    const key = doing();
    now = T0 + 1000;
    const moved = board.act(key, { action: "move", to: "blocked", reason: "needs the API key" }, BUILDER);
    expect(moved.ok).toBe(true);
    if (moved.ok) expect(moved.event.change).toMatchObject({ kind: "moved", from: "doing", to: "blocked", unwatched: true });
    // The task view the CLI reads it from (the route's GET) holds the same event.
    expect(board.task(key)?.events.at(-1)?.change).toMatchObject({ kind: "moved", from: "doing", to: "blocked", unwatched: true });
  });

  it("mode off, and no gate at all: the block goes through as before, with no unwatched on the event", () => {
    open("off");
    const key = doing();
    const off = board.act(key, { action: "move", to: "blocked", reason: "needs the API key" }, BUILDER);
    expect(off.ok).toBe(true);
    if (off.ok) expect("unwatched" in off.event.change).toBe(false);
    board.stop(); store.close();
    open(null);
    const none = board.act(key, { action: "move", to: "blocked", reason: "still needs the API key" }, BUILDER);
    expect(none.ok).toBe(true);
    if (none.ok) expect("unwatched" in none.event.change).toBe(false);
  });
});
