// The feed's words for the manager's delivery queue (fleet-clients §9.1, Task 13): a Decision's delivery state and why it
// waits, the card's notice, and the `deliveries` frame (this device's messages to the manager, by request id). A hub from
// before says none of it, and an app reads that as before; a state this app doesn't know reads as queued, never as
// delivered (E13). Synthetic frames only.
import { describe, expect, it } from "vitest";
import { ServerFeedFrames, decode } from "../src/index.ts";

const T0 = Date.UTC(2026, 9, 8, 9);
const item = (o: Record<string, unknown> = {}) => ({
  id: "ny-7", asker: { kind: "manager", name: "Manager", workerId: "pc.aaaaaaaa.1" }, need: "decision", title: "Ship it?",
  context: null, contextKind: "markdown", options: [], answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: null,
  blocking: false, project: null, askedAt: T0, messageId: null, tracking: "ledger", status: "answered", source: "open",
  decision: { choice: { kind: "option", key: "ship", label: "Ship it" }, at: T0, via: "here", endpointId: "ep1", sessionId: "s1", delivery: { state: "queued", at: null } },
  resolution: null, settledAt: null, askedAgain: false, answerable: "already_answered", version: "v1", ...o,
});
const board = (items: unknown[]) => decode(ServerFeedFrames, JSON.stringify({ t: "decisions", items, ledger: { configured: true, ok: true, at: T0 } }));
const first = (d: ReturnType<typeof board>) => (d.kind === "ok" && d.frame.t === "decisions" ? d.frame.items[0] : undefined);

describe("a Decision's delivery in the feed", () => {
  it("carries its state, why it waits, and the card's notice", () => {
    const d = first(board([item({ waiting: "menu_open" })]));
    expect(first(board([item({ status: "open", decision: null, notice: "Not delivered: the answer never reached the manager. Answer again." })]))?.notice).toMatch(/^Not delivered/);
    expect(d?.decision?.delivery).toEqual({ state: "queued", at: null });
    expect(d?.waiting).toBe("menu_open");
    expect(first(board([item({ decision: { ...item().decision, delivery: { state: "delivered", at: T0 + 5 } } })]))?.decision?.delivery).toEqual({ state: "delivered", at: T0 + 5 });
    expect(first(board([item({ decision: { ...item().decision, delivery: { state: "uncertain", at: null } } })]))?.decision?.delivery?.state).toBe("uncertain");
  });
  it("a hub from before says neither: no delivery, no reason", () => {
    const { delivery: _gone, ...before } = item().decision;
    const d = first(board([item({ decision: before })]));
    expect(d?.decision?.delivery).toBeUndefined();
    expect(d && "waiting" in d).toBe(false);
  });
  it("a delivery state this app doesn't know reads as queued, never delivered (negative control)", () => {
    const d = first(board([item({ decision: { ...item().decision, delivery: { state: "teleported", at: T0 } } })]));
    expect(d?.decision?.delivery).toEqual({ state: "queued", at: T0 });
  });
});

describe("the deliveries frame", () => {
  it("decodes each of this device's messages to the manager by request id", () => {
    const frame = { t: "deliveries", items: [
      { requestId: "r1", state: "queued", waiting: "draft_present", why: null },
      { requestId: "r2", state: "delivered", waiting: null, why: null },
      { requestId: "r3", state: "given_up", waiting: null, why: "expired" },
    ] };
    expect(decode(ServerFeedFrames, JSON.stringify(frame))).toEqual({ kind: "ok", frame });
  });
  it("a state it doesn't know reads as queued; an item that doesn't fit is dropped, not the frame (negative control)", () => {
    const d = decode(ServerFeedFrames, JSON.stringify({ t: "deliveries", items: [
      { requestId: "r1", state: "beamed", waiting: null, why: null },
      { requestId: 7, state: "delivered", waiting: null, why: null },
    ] }));
    expect(d).toEqual({ kind: "ok", frame: { t: "deliveries", items: [{ requestId: "r1", state: "queued", waiting: null, why: null }] } });
    expect(decode(ServerFeedFrames, JSON.stringify({ t: "deliveries" })).kind).toBe("malformed");
  });
});
