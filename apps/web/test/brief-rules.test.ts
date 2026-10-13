// Review round 1 of the desktop brief (PR #47). Pure rules: calendar due line, docked panel width,
// inline markdown, and the shared answer session (restate resets a pick; the shown brief stays put).
import { describe, expect, it } from "vitest";
import { dueLine } from "../src/lib/desktop/decisions.ts";
import { commitWidth, dockedWidth, layoutIsNarrow, widthAfterWindowChange, RIGHT_MIN } from "../src/lib/desktop/panel-width.ts";
import { openSession, pick, showNew, noteClosed, releaseAbsentSession, ABSENT_GRACE_MS } from "../src/lib/desktop/answer-session.ts";
import type { DecisionItem } from "../src/lib/desktop/decisions.ts";

const at = (iso: string) => Date.parse(iso);

describe("due line counts calendar days", () => {
  it("a date-only due later today is due today, not in 1 day", () => {
    expect(dueLine(at("2026-10-13T23:59:00"), at("2026-10-13T00:30:00"))).toBe("Due today");
  });
  it("tomorrow's date-only due is in 1 day, including just after midnight", () => {
    expect(dueLine(at("2026-10-14T23:59:00"), at("2026-10-13T08:00:00"))).toMatch(/\(in 1 day\)$/);
    expect(dueLine(at("2026-10-14T00:30:00"), at("2026-10-13T23:30:00"))).toMatch(/\(in 1 day\)$/);
  });
  it("two calendar days ahead is in 2 days", () => {
    expect(dueLine(at("2026-10-15T23:59:00"), at("2026-10-13T01:00:00"))).toMatch(/\(in 2 days\)$/);
  });
});

describe("widening the decisions panel stays docked", () => {
  const sidebar = 300;
  it("caps the width so a 1440px window never flips to the overlay", () => {
    expect(dockedWidth(640, 1440, sidebar)).toBeLessThanOrEqual(506);
    expect(layoutIsNarrow(1440, sidebar)).toBe(false);
    expect(dockedWidth(640, 1440, sidebar)).toBeGreaterThanOrEqual(RIGHT_MIN);
  });
  it("a window too narrow for the minimum panel is the overlay, and the width can still be 640", () => {
    expect(layoutIsNarrow(1000, sidebar)).toBe(true);
    expect(dockedWidth(640, 1000, sidebar)).toBe(640);
  });
  it("a narrower window draws less and the chosen width is still there when it widens", () => {
    const chosen = 600;
    const windowWidth = 1440;
    const tight = widthAfterWindowChange(chosen, windowWidth, 400);
    expect(tight.drawn).toBe(406);
    expect(tight.chosen).toBe(600);
    const restored = widthAfterWindowChange(tight.chosen, windowWidth, 260);
    expect(restored.drawn).toBe(546);
    expect(restored.chosen).toBe(600);
  });
  it("an arrow or a drag on a narrow window commits relative to the chosen width", () => {
    expect(commitWidth(640, 480, 0)).toBe(640);
    expect(commitWidth(640, 480, 16)).toBe(640);
    expect(commitWidth(640, 480, -16)).toBe(640);
    expect(commitWidth(500, 480, 16)).toBe(516);
    expect(commitWidth(480, 480, 16)).toBe(496);
    expect(commitWidth(480, 480, -16)).toBe(464);
  });
});

function item(version: string, label: string, status: DecisionItem["status"] = "open"): DecisionItem {
  return {
    id: "d-1" as DecisionItem["id"],
    asker: { kind: "manager", name: "Manager", workerId: "w" },
    need: "decision", title: "Approve option B", shortTitle: "Triage", summary: null, minutes: 8, link: null,
    details: null, context: null, contextKind: "markdown",
    options: [{ key: "b", label, detail: null }],
    answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null,
    askedAt: 0, messageId: null, tracking: "hub", status, source: "open", decision: null, resolution: null,
    settledAt: null, askedAgain: false, answerable: null, version, inbox: null, brief: null, briefVersion: version === "v1" ? 1 : 2, draftedBy: null,
  };
}

describe("answer session", () => {
  it("show new drops the pick so the next answer is chosen from the version on screen", () => {
    let s = pick(openSession(item("v1", "Extend the triage script")), "B · Extend the triage script", { key: "b" });
    const live = item("v2", "Buy a hosted add-on");
    expect(s.shown.version).not.toBe(live.version);
    expect(s.shown.options[0]?.label).toBe("Extend the triage script");
    s = showNew(s, live);
    expect(s.mode).toBe("idle");
    expect(s.picked).toBeNull();
    expect(s.shown.options[0]?.label).toBe("Buy a hosted add-on");
    expect(s.shown.version).toBe("v2");
  });
  it("a decision that closed meanwhile clears an answer in doubt", () => {
    const s = openSession(item("v1", "Extend the triage script"));
    s.again = { body: { key: "b" }, requestId: "req-1", code: "uncertain" };
    s.error = "May have been sent.";
    const closed = noteClosed(s);
    expect(closed.again).toBeNull();
    expect(closed.error).toBeNull();
    expect(closed.mode).toBe("idle");
    expect(closed.picked).toBeNull();
  });
  it("an answer in doubt, a sent flag, or typed words survive a brief absence and not a closed one", () => {
    const open = openSession(item("v1", "Extend the triage script"));
    const doubt = { ...open, again: { body: { key: "b" }, requestId: "req-1", code: "uncertain" } };
    expect(releaseAbsentSession(doubt, 0)).toBe(false);
    expect(releaseAbsentSession(doubt, ABSENT_GRACE_MS - 1)).toBe(false);
    expect(releaseAbsentSession(doubt, ABSENT_GRACE_MS)).toBe(true);
    expect(releaseAbsentSession({ ...open, sent: true }, 0)).toBe(false);
    expect(releaseAbsentSession({ ...open, words: "Ship on Tuesday" }, 0)).toBe(false);
    expect(releaseAbsentSession(open, 0)).toBe(true);
    expect(releaseAbsentSession({ ...doubt, live: item("v1", "Extend the triage script", "expired") }, 0)).toBe(true);
  });
  it("a refusal stays visible when the item closes and nothing is in doubt", () => {
    const s = openSession(item("v1", "Extend the triage script"));
    s.mode = "confirm";
    s.error = "This was already answered.";
    const closed = noteClosed(s);
    expect(closed.mode).toBe("idle");
    expect(closed.error).toBe("This was already answered.");
  });
});
