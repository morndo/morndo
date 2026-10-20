// The fleet's alerts in words (the owner, 2026-10-12): every kind the fleet raises has its own words, never the general
// ones a newer fleet's kind gets; the urgent ones are the protocol's rule's; what he hasn't seen is what is newer than
// his mark.
import { describe, expect, it } from "vitest";
import { ALERT_KINDS, urgentAlert } from "@morndo/protocol";
import { alertWords, unseen } from "../src/lib/alerts.ts";

const a = (kind: string, detail: Record<string, unknown> = {}, at = 1) => ({ id: at, at, node: "pc", kind, detail });

describe("alert words", () => {
  it("every kind has its own words (connection, kept for later, may show the general ones)", () => {
    for (const k of ALERT_KINDS.filter(k => k !== "connection")) {
      const w = alertWords(a(k, { name: "alpha", lane: "manager", minutes: 15, subscriber: "kira", path: "/hook/stop", offsetMs: 3000 }));
      expect(w.detail, k).not.toBe("A newer fleet raised this alert.");
      expect(w.title.length, k).toBeGreaterThan(5);
    }
  });
  it("an engine fallback names the lane, what ran and what it passed over", () => {
    expect(alertWords(a("engine_fallback", { lane: "api", role: "implement", entry: "beta:mid-3", skipped: [{ entry: "acme:large-2", reason: "out of quota" }] }))).toEqual({
      title: "api started on a fallback: beta:mid-3", detail: "Its role implement passed over acme:large-2 on pc.", urgent: false,
    });
  });
  it("a stashed draft (#64) says whose text, since when, how to get it back and where its copy is, and is urgent", () => {
    const since = Date.parse("2026-10-20T09:04:00");
    const w = alertWords(a("draft_stashed", { lane: "manager", since, at: since + 3_600_000, chars: 42, copy: "/data/drafts/1-manager.txt" }));
    expect(w.title).toBe("Your unsent text to the manager was put away");
    expect(w.detail).toContain(new Date(since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    expect(w.detail).toContain("Press Ctrl+S in the manager's empty input box to bring it back.");
    expect(w.detail).toContain("A copy is on pc: /data/drafts/1-manager.txt.");
    expect(w.urgent).toBe(true);
  });
  it("a kind a newer fleet added still shows, in general words", () => {
    expect(alertWords(a("moon_phase"))).toEqual({ title: "pc: moon phase", detail: "A newer fleet raised this alert.", urgent: false });
  });
  it("marks the urgent ones by the protocol's rule", () => {
    for (const k of ALERT_KINDS) expect(alertWords(a(k)).urgent, k).toBe(urgentAlert(a(k)));
    expect(alertWords(a("delivery_waiting", { minutes: 15, reason: "menu_open", lane: "manager" }))).toMatchObject({
      title: "A message to the manager has waited 15 min", detail: "It goes in once it can: a menu is open in its terminal.", urgent: true });
    expect(alertWords(a("delivery_waiting", { minutes: 2, reason: "no_pane", lane: "alpha" }))).toMatchObject({
      title: "A message to alpha has waited 2 min", detail: "It goes in once it can: it has no window.", urgent: false });
  });
  it("unseen: newer than his mark", () => {
    expect(unseen([a("x", {}, 5), a("y", {}, 3)], 4)).toBe(1);
    expect(unseen([a("x", {}, 5)], undefined)).toBe(1);
  });
});
