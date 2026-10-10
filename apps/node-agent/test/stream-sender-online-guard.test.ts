// StreamSender.online() must not throw when the spool read fails (the file's own invariant: its methods run in the ws
// message handler and may not throw). A spool stub whose maxSeq() throws models a corrupted stream table at a welcome.
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@morndo/protocol";
import { StreamSender } from "../src/relay/stream-sender.ts";
import { captureLog } from "./helpers.ts";

describe("StreamSender.online under a stream read error", () => {
  it("logs and does not throw when maxSeq() fails", () => {
    const logged = captureLog();
    const spool = {
      streamId: "s1",
      maxSeq() { throw Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" }); },
      after() { return []; },
      ack() { /* no-op */ },
    } as unknown as import("../src/relay/spool.ts").Spool;
    const sent: AgentMessage[] = [];
    const sender = new StreamSender({ spool, node: "pc", send: m => { sent.push(m); return true; }, log: logged.log });
    expect(() => sender.online({ ackSeq: 0, streamKnown: true })).not.toThrow();
    expect(logged.lines.some(l => /hook stream|could not read/i.test(l))).toBe(true);
  });
});
