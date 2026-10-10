// The hook stream end to end (spec 9, "Stream"): a real fleet, a scripted agent with its spool, real subscribers.
// A fleet restart mid-stream: each event reaches the subscriber at least once, and the subscriber's idempotency key
// makes its handling exactly once. An agent database reset (a new streamId) is delivered, not taken for duplicates.
// A subscriber answering 400 gets a dead letter while another subscriber receives everything.
import { describe, expect, it, vi } from "vitest";
import type { Subscriber } from "../src/config.ts";
import { HOOK_PATHS } from "../src/config.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { Spool } from "./helpers/spool.ts";
import { startSubscriber } from "./helpers/subscriber.ts";
import { tempDir } from "./helpers/temp.ts";

const FAST = { backoff: { baseMs: 5, maxMs: 40 }, tickMs: 20, random: () => 1 };
const all = (name: string, url: string): Subscriber => ({ name, url, paths: HOOK_PATHS });

describe("the hook stream end to end", () => {
  it("a fleet restart mid-stream: every event at least once, handled exactly once by its idempotency key", async () => {
    let release: () => void = () => {};
    const released = new Promise<void>(r => { release = r; });
    // Event 10's first delivery reaches the subscriber, but its answer is held until the fleet is gone.
    const kira = await startSubscriber(async (r, attempt) => { if (r.body.seq === 10 && attempt === 1) await released; return 200; });
    const dir = tempDir();
    const config = { subscribers: [all("kira", kira.url)] };
    const before = await startTestFleet({ dir, config, delivery: FAST });
    const agent = await before.online("pc");
    const spool = new Spool(40);
    expect(await spool.replay(agent, { upTo: 20 })).toBe(20);                          // stored and acknowledged
    await vi.waitFor(() => expect(kira.received.map(r => r.body.seq)).toContain(10));
    expect(kira.received.map(r => r.body.seq)).not.toContain(11);                        // 11 waits for 10 (seq order)
    await before.close();                                                              // the fleet stops mid-stream
    release();
    const after = await startTestFleet({ dir, config, delivery: FAST });
    const same = after.agent({ node: "pc", key: agent.key, instanceId: agent.instanceId, streamId: agent.streamId });
    expect(await same.connect()).toMatchObject({ ok: true, welcome: { ackSeq: 20, streamKnown: true } });
    expect(await spool.replay(same)).toBe(40);                                          // 21..40, never 1..20 again
    await vi.waitFor(() => expect(kira.handled.size).toBe(40), { timeout: 10_000 });
    const keys = Array.from({ length: 40 }, (_, i) => `pc:${agent.streamId}:${i + 1}`);
    expect([...kira.handled.keys()].sort()).toEqual([...keys].sort());                  // each event, handled once
    for (const key of keys) expect(kira.received.filter(r => r.key === key).length, key).toBeGreaterThanOrEqual(1);
    expect(kira.received.filter(r => r.body.seq === 10)).toHaveLength(2);               // at least once: 10 came again
    expect(kira.received.length).toBe(41);
  });

  it("an agent whose database was reset starts a new stream, and its events are delivered", async () => {
    const kira = await startSubscriber();
    const fleet = await startTestFleet({ config: { subscribers: [all("kira", kira.url)] }, delivery: FAST });
    const old = await fleet.online("pc");
    expect(await new Spool(5).replay(old)).toBe(5);
    await old.close();
    const reinstalled = fleet.agent({ node: "pc", key: old.key });                      // new instance, new streamId
    expect(await reinstalled.connect()).toMatchObject({ ok: true, welcome: { ackSeq: 0, streamKnown: false } });
    expect(await new Spool(3).replay(reinstalled)).toBe(3);
    await vi.waitFor(() => expect(kira.handled.size).toBe(8));
    expect([...kira.handled.keys()].filter(k => k.startsWith(`pc:${reinstalled.streamId}:`)).sort()).toEqual([1, 2, 3].map(n => `pc:${reinstalled.streamId}:${n}`));
  });

  it("a subscriber answering 400 gets a dead letter and an alert; the other subscriber receives everything", async () => {
    const picky = await startSubscriber(r => (r.body.seq === 2 ? 400 : 200));
    const other = await startSubscriber();
    const fleet = await startTestFleet({ config: { subscribers: [all("picky", picky.url), all("other", other.url)] }, delivery: FAST });
    const agent = await fleet.online("pc");
    expect(await new Spool(5).replay(agent)).toBe(5);
    await vi.waitFor(() => expect(other.handled.size).toBe(5));
    await vi.waitFor(() => expect(fleet.outbox.states("picky")).toEqual({ delivered: 4, dead: 1 }));
    expect(fleet.outbox.deadLetters("picky").map(d => d.seq)).toEqual([2]);
    expect(fleet.audit.of("alert.dead_letter")).toHaveLength(1);
  });
});
