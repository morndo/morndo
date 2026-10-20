// The hub's adapter onto the fleet's Runs (ADR-0032 §6): GET /v1/runs and the `run` events, each run decoded on its own
// (one this build can't read is dropped, never guessed), and a client without runs() read as a fleet that can't be asked.
// A fake client in the shape of @morndo/fleet-client's; synthetic lanes only.
import { describe, expect, it } from "vitest";
import type { RunView } from "@morndo/protocol";
import { fleetRuns, type RunsClient } from "../src/adapters/fleet-runs.ts";

const working: RunView = { lane: "builder", node: "pc", phase: "working", deadline: null, overdue: false, since: 1000, source: "session" };
const waiting: RunView = { lane: "reviewer", node: "pc", phase: "waiting", wait: { on: "wakeup", next: 5000 }, deadline: 5000 + 300_000, overdue: false, since: 900, source: "hook", line: "STATUS: WAITING on CI for 10 min" };

function fakeClient(list: readonly unknown[] | undefined) {
  let on: ((e: { t: string; node: string; body: unknown }) => void) | null = null;
  let opened: (() => void) | undefined;
  const client = {
    events(f: (e: never) => void, o: { onOpen?: () => void } = {}) { on = f as never; opened = o.onOpen; return () => { on = null; }; },
    ...(list === undefined ? {} : { runs: async () => list }),
  } as unknown as RunsClient;
  return { client, emit: (e: { t: string; node: string; body: unknown }) => on?.(e), open: () => opened?.() };
}

describe("fleetRuns", () => {
  it("runs(): the fleet's list, each run decoded; one that doesn't read is left out", async () => {
    const { client } = fakeClient([working, { lane: "broken", phase: "sideways" }, waiting]);
    expect(await fleetRuns(client).runs()).toEqual([working, waiting]);
  });

  it("a client without runs() can't be asked: it throws, and is never read as no runs", async () => {
    const { client } = fakeClient(undefined);
    await expect(fleetRuns(client).runs()).rejects.toThrow(/no runs\(\)/);
  });

  it("subscribe(): only `run` events, decoded; onOpen after each open", () => {
    const { client, emit, open } = fakeClient([]);
    const seen: RunView[] = [];
    let opens = 0;
    const stop = fleetRuns(client).subscribe(r => seen.push(r), () => { opens++; });
    emit({ t: "lane", node: "pc", body: working });
    emit({ t: "run", node: "pc", body: working });
    emit({ t: "run", node: "pc", body: { lane: "builder" } });       // not a run: dropped
    open();
    expect(seen).toEqual([working]);
    expect(opens).toBe(1);
    stop();
    emit({ t: "run", node: "pc", body: waiting });
    expect(seen).toEqual([working]);
  });
});
