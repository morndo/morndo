// The bookkeeping a send and an escalation answer share once their node has answered (S5).
import { describe, expect, it } from "vitest";
import { SendInDoubt } from "../src/application/ports.ts";
import { keepInDoubt, settleOutcome } from "../src/application/steering-service.ts";

function rows() {
  const calls: string[] = [];
  return {
    calls,
    setSendStore: (key: string, store: string, seq: number | null) => { calls.push(`store ${key} ${store} ${seq}`); },
    dropSend: (key: string) => { calls.push(`drop ${key}`); },
    finishSend: (key: string, at: number) => { calls.push(`finish ${key} ${at}`); },
  };
}
describe("settleOutcome", () => {
  it("typed: the store it went to, then done at the node's time", () => {
    const r = rows();
    settleOutcome(r, "k", { problem: null, typedAt: 7, store: "s1", storeSeq: 3 });
    expect(r.calls).toEqual(["store k s1 3", "finish k 7"]);
  });
  it("nothing reached the pane (before the paste, or a definite refusal): the row goes", () => {
    for (const problem of ["no_pane", "menu_open", "no_input_box", "draft_present", "busy", "node_offline"] as const) {
      const r = rows();
      settleOutcome(r, "k", { problem, typedAt: 0 });
      expect(r.calls, problem).toEqual(["drop k"]);
    }
  });
  it("not_submitted comes after the paste: the row stays, never done", () => {
    const r = rows();
    settleOutcome(r, "k", { problem: "not_submitted", typedAt: 5, store: "s1" });
    expect(r.calls).toEqual(["store k s1 null"]);
  });
});
describe("keepInDoubt", () => {
  it("keeps the store and its sequence when the node answered, nothing when none did", () => {
    const r = rows();
    keepInDoubt(r, "k", new SendInDoubt("s9", "x", { storeSeq: 4 }));
    keepInDoubt(r, "k", new SendInDoubt(null, "x"));
    expect(r.calls).toEqual(["store k s9 4"]);
  });
});
