// A board result is sent until the fleet acknowledges it. A refusal or a throw leaves it for the next pass.
import { describe, expect, it } from "vitest";
import { NoticeOutbox, type NoticeDelivery } from "../src/application/job-notice-outbox.ts";

const row: NoticeDelivery = { node: "pc", id: "job-1", notice: "commented" };

describe("a job notice outbox", () => {
  it("acks only a send the fleet accepted, and does not send one that is already in flight", async () => {
    const box = new NoticeOutbox();
    const acked: string[] = [];
    let mode: "throw" | "no" | "yes" = "throw";
    const send = async () => {
      if (mode === "throw") throw new Error("down");
      return mode === "yes";
    };
    await box.deliver([row], send, sent => acked.push(sent.id));
    expect(acked).toEqual([]);
    mode = "no";
    await box.deliver([row], send, sent => acked.push(sent.id));
    expect(acked).toEqual([]);
    mode = "yes";
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = box.deliver([row], async () => { await gate; return true; }, sent => acked.push(sent.id));
    await box.deliver([row], async () => { throw new Error("second"); }, sent => acked.push(`again:${sent.id}`));
    release();
    await first;
    expect(acked).toEqual(["job-1"]);
  });
});
