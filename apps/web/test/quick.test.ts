// A task's buttons on Today (the owner's feedback, 2026-10-04): Done, an option or his own words go to the manager
// after the same 5-second window as catch-up's answers, Undo inside it sends nothing; Later keeps the task off today on
// this device only. Pure state; synthetic ids.
import { describe, expect, it } from "vitest";
import { LATE_ANSWER_MS, UNDO_MS } from "../src/lib/catchup/run.ts";
import { bringBack, dueQuick, emptyQuick, keepForLater, keptTasks, parseQuick, settleFromBoard, settleQuick, startQuick, undoQuick } from "../src/lib/phone/quick.ts";

const T = new Date(2026, 9, 4, 9, 0).getTime();
const done = (s = emptyQuick(), at = T) => startQuick(s, { id: "ny-5", body: { text: "Done" }, label: "Done", seen: "v1", requestId: "r1" }, at);

describe("an answer from a task's row", () => {
  it("waits 5 seconds; Undo inside them sends nothing", () => {
    const s = done();
    expect(dueQuick(s, T + UNDO_MS - 1).send).toEqual([]);
    const u = undoQuick(s, "ny-5");
    expect(u.pending).toEqual({});
    expect(dueQuick(u, T + UNDO_MS + 1).send).toEqual([]);
  });
  it("then goes once, and is remembered as said from here", () => {
    const d = dueQuick(done(), T + UNDO_MS);
    expect(d.send.map(a => [a.id, a.body, a.seen, a.requestId])).toEqual([["ny-5", { text: "Done" }, "v1", "r1"]]);
    expect(dueQuick(d.state, T + UNDO_MS + 1000).send).toEqual([]);                 // sending: not twice
    expect(undoQuick(d.state, "ny-5")).toBe(d.state);                               // too late to undo
    const ok = settleQuick(d.state, "ny-5", { ok: true }, T + UNDO_MS + 300);
    expect(ok.pending).toEqual({});
    expect(ok.sent["ny-5"]).toEqual({ label: "Done", at: T + UNDO_MS + 300 });
  });
  it("a window that closed while the phone slept isn't sent late", () => {
    const d = dueQuick(done(), T + UNDO_MS + LATE_ANSWER_MS + 1);
    expect(d.send).toEqual([]);
    expect(d.late.map(a => a.id)).toEqual(["ny-5"]);
    expect(d.state.pending).toEqual({});
    expect(d.state.failed["ny-5"]?.text).toMatch(/Not sent/);
  });
  it("leaving the page sends what waits in its window now", () => {
    expect(dueQuick(done(), T + 100, true).send.map(a => a.id)).toEqual(["ny-5"]);
  });
  it("an answer the hub keeps in doubt (409 uncertain) can be checked again with the same request id", () => {
    const d = dueQuick(done(), T + UNDO_MS);
    const u = settleQuick(d.state, "ny-5", { ok: false, code: "uncertain", text: "May have been sent: …" }, T + UNDO_MS + 10);
    expect(u.failed["ny-5"]).toMatchObject({ code: "uncertain", retry: { id: "ny-5", requestId: "r1", body: { text: "Done" } } });
  });
  it("a refusal says why; an unknown outcome can be tried again with the same request id", () => {
    const d = dueQuick(done(), T + UNDO_MS);
    const no = settleQuick(d.state, "ny-5", { ok: false, code: "already_answered", text: "This was already answered." }, T + UNDO_MS + 10);
    expect(no.failed["ny-5"]).toEqual({ code: "already_answered", text: "This was already answered." });
    const lost = settleQuick(d.state, "ny-5", { ok: false, code: "unknown", text: "Not sure it went." }, T + UNDO_MS + 10);
    expect(lost.failed["ny-5"]?.retry?.requestId).toBe("r1");
    const again = startQuick(lost, { id: "ny-5", body: { text: "Done" }, label: "Done", seen: "v1", requestId: "r2" }, T + 20_000);
    expect(again.failed["ny-5"]).toBeUndefined();
  });
});

describe("Later on a task", () => {
  it("keeps it off today, on this device, while the same ask stands", () => {
    const s = keepForLater(emptyQuick(), "ny-5", "v1", T);
    expect(keptTasks(s, [{ id: "ny-5", version: "v1", status: "open" }], T + 3_600_000)).toEqual(new Set(["ny-5"]));
    expect(keptTasks(s, [{ id: "ny-5", version: "v2", status: "open" }], T + 3_600_000)).toEqual(new Set());   // restated
    expect(keptTasks(s, [{ id: "ny-5", version: "v1", status: "open" }], new Date(2026, 9, 5, 0, 1).getTime())).toEqual(new Set());   // the next day
    expect(keptTasks(bringBack(s, "ny-5"), [{ id: "ny-5", version: "v1", status: "open" }], T)).toEqual(new Set());
  });
});

describe("kept on the device", () => {
  it("reads back what it saved, and nothing from garbage", () => {
    const s = settleQuick(dueQuick(done(keepForLater(emptyQuick(), "ny-6", "v3", T)), T + UNDO_MS).state, "ny-5", { ok: true }, T + UNDO_MS);
    const back = parseQuick(JSON.parse(JSON.stringify(s)));
    expect(back.later).toEqual(s.later);
    expect(back.sent).toEqual(s.sent);
    expect(back.pending).toEqual({});
    expect(parseQuick("nonsense")).toEqual(emptyQuick());
    expect(parseQuick({ later: { "ny-1": { version: 5 } }, sent: [] })).toEqual(emptyQuick());
  });
});

// Code review #2: an answer in its window, or being sent, when the app is killed is kept on the device and read back as a
// notice, never sent again by itself and never dropped without a word; the board settles it.
describe("an answer the app closed on", () => {
  const stored = (sending: boolean) => JSON.parse(JSON.stringify({
    pending: { "ny-5": { id: "ny-5", body: { text: "Done" }, label: "Done", seen: "v1", requestId: "r1", commitAt: T + UNDO_MS, sending } }, sent: {}, failed: {}, later: {},
  }));
  it("being sent: may have gone; Try again sends it with the same request id", () => {
    const back = parseQuick(stored(true));
    expect(back.pending).toEqual({});
    expect(back.failed["ny-5"]).toMatchObject({ code: "unknown", retry: { requestId: "r1", body: { text: "Done" }, sending: false } });
    expect(back.failed["ny-5"]?.text).toMatch(/Not sure it went/);
  });
  it("still in its window: not sent, and said so", () => {
    const back = parseQuick(stored(false));
    expect(back.failed["ny-5"]).toMatchObject({ code: "closed" });
    expect(back.failed["ny-5"]?.retry).toBeUndefined();
    expect(back.failed["ny-5"]?.text).toMatch(/Not sent/);
  });
  it("a refusal kept on the device reads back as it was; a malformed one is dropped", () => {
    const back = parseQuick({ failed: { "ny-5": { code: "already_answered", text: "This was already answered." }, "ny-6": { code: 3 } } });
    expect(back.failed).toEqual({ "ny-5": { code: "already_answered", text: "This was already answered." } });
  });
  it("the board settles it: an answer that did arrive counts as said from here; anything closed clears the notice", () => {
    const back = parseQuick(stored(true));
    const arrived = settleFromBoard(back, [{ id: "ny-5", status: "answered", decision: { at: T + 9000, via: "here" } }]);
    expect(arrived.failed).toEqual({});
    expect(arrived.sent["ny-5"]).toEqual({ label: "Done", at: T + 9000 });
    expect(settleFromBoard(parseQuick(stored(false)), [{ id: "ny-5", status: "settled", decision: null }]).failed).toEqual({});
    expect(settleFromBoard(back, [{ id: "ny-5", status: "open", decision: null }])).toBe(back);       // still open: unchanged
  });
});

// Code review #3: a refusal for a stale passkey check keeps the answer, so the row can confirm with the passkey and send it.
describe("refused for the passkey check", () => {
  it("keeps the answer to send again once confirmed; other refusals keep none", () => {
    const d = dueQuick(done(), T + UNDO_MS);
    const no = settleQuick(d.state, "ny-5", { ok: false, code: "step_up", text: "Not sent: confirm with your passkey, then it goes." }, T + UNDO_MS + 10);
    expect(no.failed["ny-5"]).toMatchObject({ code: "step_up", again: { id: "ny-5", body: { text: "Done" }, label: "Done", seen: "v1", sending: false } });
    expect(no.failed["ny-5"]?.retry).toBeUndefined();
    expect(parseQuick(JSON.parse(JSON.stringify(no))).failed["ny-5"]?.again?.label).toBe("Done");
    expect(settleQuick(d.state, "ny-5", { ok: false, code: "settled", text: "Closed." }, T).failed["ny-5"]?.again).toBeUndefined();
  });
});

// V8: Check again on an answer in doubt (the same request id) keeps the doubt until the hub settles it (S7 for an
// answer; E8): Undo, a closed app, or an outcome that settles nothing (step_up, 429, 5xx) leave it in doubt.
describe("Check again on an answer in doubt keeps the doubt until it is settled", () => {
  const inDoubt = () => settleQuick(dueQuick(done(), T + UNDO_MS).state, "ny-5", { ok: false, code: "uncertain", text: "May have been sent." }, T + UNDO_MS + 10);
  const checking = () => {
    const s = inDoubt();
    const r = s.failed["ny-5"]?.retry;
    if (!r) throw new Error("no retry");
    return startQuick(s, { id: r.id, body: r.body, label: r.label, seen: r.seen, requestId: r.requestId }, T + 20_000);
  };
  it("Undo inside its window puts the doubt back, with Check again on the same request id", () => {
    const u = undoQuick(checking(), "ny-5");
    expect(u.pending).toEqual({});
    expect(u.failed["ny-5"]).toMatchObject({ code: "uncertain", text: "May have been sent.", retry: { requestId: "r1" } });
  });
  it("the app closed inside its window reads back in doubt, not Not sent", () => {
    const back = parseQuick(JSON.parse(JSON.stringify(checking())));
    expect(back.failed["ny-5"]).toMatchObject({ code: "uncertain", retry: { requestId: "r1" } });
    expect(back.failed["ny-5"]?.text).not.toMatch(/Not sent/);
  });
  it("answered step_up: still in doubt, with Check again and the passkey confirm, both on the same request id", () => {
    const d = dueQuick(checking(), T + 20_000 + UNDO_MS);
    const s = settleQuick(d.state, "ny-5", { ok: false, code: "step_up", text: "Not sent: confirm with your passkey, then it goes." }, T + 30_000);
    expect(s.failed["ny-5"]).toMatchObject({ code: "uncertain", retry: { requestId: "r1" }, again: { requestId: "r1" } });
  });
  it("answered 429 or 500: still in doubt; a refusal of an answer judged anew (already_answered) ends it", () => {
    const d = dueQuick(checking(), T + 20_000 + UNDO_MS);
    for (const code of ["rate_limited", "internal error"]) {
      expect(settleQuick(d.state, "ny-5", { ok: false, code, text: "x" }, T + 30_000).failed["ny-5"]).toMatchObject({ code: "uncertain", retry: { requestId: "r1" } });
    }
    expect(settleQuick(d.state, "ny-5", { ok: false, code: "already_answered", text: "This was already answered." }, T + 30_000).failed["ny-5"])
      .toEqual({ code: "already_answered", text: "This was already answered." });
  });
});
