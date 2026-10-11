// A transcript source that can't answer now (fleet core §3.1: the fleet's source throws SourceUnavailable while the node
// is offline or slow) is not a transcript that is gone (null). The follow keeps its place and its conversation through
// it, and the next poll reads on from there, nothing lost or repeated; only null starts the follow over, with a whole
// history again. A source in memory that a test makes unavailable; no tmux.
import { describe, expect, it } from "vitest";
import type { Message } from "@morndo/domain";
import { ObservationService, type Listener } from "../src/application/observation-service.ts";
import { SourceUnavailable, type Sessions, type TranscriptSource } from "../src/application/ports.ts";

const T = "2026-10-06T08:00:00.000Z";
const line = (uuid: string, text: string) => `${JSON.stringify({ type: "assistant", uuid, timestamp: T, message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;

// One session's transcript: "ok", "unavailable" (every call throws SourceUnavailable) or "gone" (null). `failRead(n)`:
// the n-th read from now throws SourceUnavailable once, as a node that drops in the middle of a follow.
function transcript() {
  let bytes = Buffer.from(line("a1", "first"));
  let state: "ok" | "unavailable" | "gone" = "ok";
  let reads = 0;
  let failAt: number | null = null;
  const check = () => { if (state === "unavailable") throw new SourceUnavailable("the node is offline"); };
  const source: TranscriptSource = {
    size: async () => { check(); return state === "gone" ? null : bytes.length; },
    read: async (_s, offset, max) => {
      check();
      if (state === "gone") return null;
      if (++reads === failAt) { failAt = null; throw new SourceUnavailable("dropped in the middle of a follow"); }
      const b = bytes.subarray(offset, offset + max);
      return { bytes: b, eof: offset + b.length >= bytes.length };
    },
    locate: async () => { check(); return null; },
  };
  return {
    source,
    append: (s: string) => { bytes = Buffer.concat([bytes, Buffer.from(s)]); },
    set: (s: typeof state) => { state = s; },
    failRead: (n: number) => { reads = 0; failAt = n; },
  };
}

function watched(source: TranscriptSource) {
  const sessions: Sessions = { byPane: async () => new Map([["%1", { sessionId: "s1", name: null, pane: "%1", cwd: "/w", version: null, pid: 1, status: null }]]) };
  const svc = new ObservationService(
    { listWorkers: async () => [{ id: "%1", name: "builder", location: "w", node: "local", offline: false }], captureMany: async ids => new Map(ids.map(id => [id, "❯ "])) },
    60_000, Date.now, { sessions, transcripts: source },
  );
  const sent: [string, string[]][] = [];
  const ids = (ms: Message[]) => ms.map(m => m.id);
  const listener: Listener = {
    events: () => {}, screen: () => {}, watching: () => "%1",
    history: (_w, ms) => { sent.push(["history", ids(ms)]); },
    messages: (_w, ms) => { sent.push(["messages", ids(ms)]); },
  };
  svc.subscribe(listener);
  return { svc, sent };
}

describe("a transcript that can't be read now", () => {
  it("keeps the follow's place: nothing rebuilt, nothing lost or repeated, and what came meanwhile arrives as new", async () => {
    const t = transcript();
    const { svc, sent } = watched(t.source);
    await svc.poll();
    t.set("unavailable");
    await svc.poll();
    await svc.poll();
    expect(svc.history("%1").map(m => m.id)).toEqual(["a1:0"]);        // the conversation is kept meanwhile
    t.append(line("a2", "second"));
    t.set("ok");
    await svc.poll();
    expect(sent).toEqual([["history", ["a1:0"]], ["messages", ["a2:0"]]]);
  });
  it("one that fails in the middle of a follow (a later read of the same poll): nothing read before it is lost", async () => {
    const t = transcript();
    const { svc, sent } = watched(t.source);
    await svc.poll();
    t.append(line("a2", "short") + line("a3", "x".repeat(300_000)));  // two reads of one chunk each (256 KiB)
    t.failRead(2);
    await svc.poll();
    await svc.poll();
    expect(sent).toEqual([["history", ["a1:0"]], ["messages", ["a2:0", "a3:0"]]]);
  });
  it("gone (null) starts the follow over, with a whole history again (negative control: not kept as unavailable is)", async () => {
    const t = transcript();
    const { svc, sent } = watched(t.source);
    await svc.poll();
    t.set("gone");
    await svc.poll();
    t.append(line("a2", "second"));
    t.set("ok");
    await svc.poll();
    expect(sent).toEqual([["history", ["a1:0"]], ["history", ["a1:0", "a2:0"]]]);
  });
});
