// The agent side of the hook stream, for tests (spec 5.4): events 1..n of the agent's stream, replayed from the
// welcome's ackSeq + 1, in order, with at most `window` unacknowledged in flight; acknowledgements are cumulative.
import { LIMITS, type HookEvent } from "@morndo/protocol";
import type { FakeAgent } from "./fake-agent.ts";

export class Spool {
  readonly last: number;
  readonly pathOf: (seq: number) => HookEvent["path"];

  constructor(last: number, pathOf: (seq: number) => HookEvent["path"] = seq => (seq % 3 === 0 ? "/cc" : "/hook/stop")) {
    this.last = last;
    this.pathOf = pathOf;
  }

  // Sends until `upTo` (default: the last event) is acknowledged; returns the highest acknowledgement seen, which is
  // lower when the connection closed or nothing was acknowledged for `ms`.
  async replay(agent: FakeAgent, o: { upTo?: number; window?: number; ms?: number } = {}): Promise<number> {
    const upTo = Math.min(o.upTo ?? this.last, this.last);
    const window = o.window ?? LIMITS.replayWindow;
    let acked = agent.welcome?.ackSeq ?? 0;
    let sent = acked;
    while (acked < upTo) {
      while (sent < upTo && sent - acked < window) { sent++; agent.hook(sent, this.pathOf(sent)); }
      const a = await agent.acked(acked + 1, o.ms ?? 5000);
      if (a === null) return acked;
      acked = a;
    }
    return acked;
  }
}
