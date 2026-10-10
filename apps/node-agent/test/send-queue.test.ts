// The two send queues (spec §5.2 "Frames"): control before bulk, one bulk message in flight.
import { describe, expect, it } from "vitest";
import { SendQueue } from "../src/conn/send-queue.ts";

function wire() {
  const sent: string[] = [];
  const callbacks: (() => void)[] = [];
  return { sent, finish: () => callbacks.shift()?.(), send: (d: string, cb: () => void) => { sent.push(d); callbacks.push(cb); } };
}

describe("send queues", () => {
  it("sends control messages at once, and holds the second bulk message until the first is written", () => {
    const w = wire();
    const q = new SendQueue(w);
    q.push("bulk-1", "bulk");
    q.push("bulk-2", "bulk");
    q.push("ctl-1", "control");
    expect(w.sent).toEqual(["bulk-1", "ctl-1"]);                          // ctl-1 overtook bulk-2
    q.push("ctl-2", "control");
    expect(w.sent).toEqual(["bulk-1", "ctl-1", "ctl-2"]);
    w.finish();                                                            // bulk-1 written
    expect(w.sent).toEqual(["bulk-1", "ctl-1", "ctl-2", "bulk-2"]);
  });
  it("drops what is queued when the connection closes", () => {
    const w = wire();
    const q = new SendQueue(w);
    q.push("bulk-1", "bulk");
    q.push("bulk-2", "bulk");
    q.close();
    w.finish();
    q.push("ctl", "control");
    expect(w.sent).toEqual(["bulk-1"]);
    expect(q.pending).toBe(0);
  });
});
