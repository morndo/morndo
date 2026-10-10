// A node's followed transcripts are asked a few at a time, not one after another (EF4): over the fleet each is a round
// trip, and a node with many lanes took longer than the poll interval. What they bring still reaches the feed in lane order.
import { describe, expect, it } from "vitest";
import { ObservationService } from "../src/application/observation-service.ts";

const LANES = 12;
const ids = Array.from({ length: LANES }, (_, i) => `n1.0123abcd.${i}`);
const line = (i: number) => `${JSON.stringify({ type: "assistant", uuid: `a${i}`, timestamp: "2026-10-06T08:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: `m${i}` }] } })}\n`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("a node's round", () => {
  it("asks its lanes' transcripts at most four at once, more than one at a time, and keeps lane order", async () => {
    let inflight = 0, most = 0;
    const around = async <T>(v: T): Promise<T> => { inflight++; most = Math.max(most, inflight); await sleep(15); inflight--; return v; };
    const tmux = {
      listWorkers: async () => ids.map((id, i) => ({ id, name: `w${i}`, location: "w", node: "n1", offline: false })),
      captureMany: async (xs: string[]) => new Map(xs.map(x => [x, "❯ "] as const)),
    };
    const transcripts = {
      size: (s: string) => around(line(Number(s.slice(1))).length),
      read: (s: string, offset: number, max: number) => around({ bytes: Buffer.from(line(Number(s.slice(1)))).subarray(offset, offset + max), eof: true }),
      locate: async () => null,
    };
    const sessions = { byPane: async () => new Map(ids.map((id, i) => [id, { sessionId: `s${i}`, pid: 1, name: `w${i}`, cwd: "/w", version: "x", updatedAt: 1 }])) };
    const svc = new ObservationService(tmux as never, 60_000, Date.now, { sessions: sessions as never, transcripts, nodeStates: async () => new Map([["n1", "online"]]), nodeWaitMs: 5000 });
    const seen: string[] = [];
    svc.subscribe({ events: () => {}, screen: () => {}, watching: () => null, history: () => {}, messages: () => {}, attachments: () => {} });
    await svc.poll();
    for (const id of ids) seen.push(svc.history(id)[0]?.text ?? "");
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(4);
    expect(seen).toEqual(ids.map((_, i) => `m${i}`));
  });
});
