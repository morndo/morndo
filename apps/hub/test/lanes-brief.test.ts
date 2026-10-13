// The orchestrator's brief (reliable lanes §3.5) as lines: stale lanes first, then the ones with a deadline, then the
// rest; lanes with no turn seen; deliveries not yet taken; the last day's alerts; never more than 60 lines.
import { describe, expect, it } from "vitest";
import type { Alert, Delivery, LaneWatchEntry } from "@morndo/protocol";
import { BRIEF_MAX_LINES, briefLines } from "../src/console/brief.ts";

const NOW = Date.UTC(2026, 9, 13, 12);
const MIN = 60_000;
const entry = (window: string, over: Partial<LaneWatchEntry> = {}): LaneWatchEntry =>
  ({ node: "pc", window, at: NOW - 5 * MIN, status: null, deadline: null, stale: false, stalls: 0, ...over });
const lane = (name: string) => ({ name, node: "pc", workerId: `pc.aaaaaaaa.${name.length}`, conflict: false });

describe("the brief", () => {
  it("orders stale, then with a deadline, then settled; says what each waits on and when", () => {
    const lines = briefLines({
      lanes: [lane("api"), lane("web"), lane("docs"), lane("idle")],
      watch: [
        entry("docs", { status: "done", at: NOW - 2 * MIN }),
        entry("web", { status: "waiting", waitingOn: "CI", deadline: NOW + 10 * MIN, reason: "waiting" }),
        entry("api", { stale: true, stalls: 3, deadline: NOW - MIN, reason: "no_status", at: NOW - 16 * MIN }),
      ],
      deliveries: [
        { id: "kira:1", node: "pc", target: { lane: "web" }, state: "queued", queuedAt: NOW - 3 * MIN, notAfter: NOW + MIN, waiting: { reason: "menu_open", since: NOW - MIN } } satisfies Delivery,
        { id: "kira:2", node: "pc", target: { lane: "web" }, state: "delivered", queuedAt: NOW - 3 * MIN, notAfter: NOW + MIN } satisfies Delivery,
      ],
      alerts: [
        { id: 1, at: NOW - 2 * 86_400_000, node: "pc", kind: "lane_conflict", detail: {} } satisfies Alert,
        { id: 2, at: NOW - 30 * MIN, node: "pc", kind: "engine_fallback", detail: { lane: "api" } } satisfies Alert,
      ],
    }, NOW);
    expect(lines).toEqual([
      "Fleet brief, 2026-10-13T12:00:00.000Z (morndo lanes brief)",
      "Lanes (4; 1 stale):",
      "  api@pc · no status · 16 min ago · STALE x3, re-plan it",
      "  web@pc · WAITING · 5 min ago · on CI · deadline in 10 min",
      "  docs@pc · DONE · 2 min ago",
      "  no turn seen in the last day: idle@pc",
      "Deliveries not yet taken (1):",
      "  kira:1 → web · queued (menu_open) · 3 min",
      "Alerts in the last day (1):",
      "  engine_fallback on pc api · 30 min ago",
    ]);
  });

  it("never runs past 60 lines, saying how many more there are", () => {
    const many = Array.from({ length: 80 }, (_, i) => `lane-${i}`);
    const lines = briefLines({
      lanes: many.map(lane), watch: many.map(w => entry(w)),
      deliveries: Array.from({ length: 20 }, (_, i) => ({ id: `kira:${i}`, node: "pc", target: { lane: "x" }, state: "queued" as const, queuedAt: NOW, notAfter: NOW })),
      alerts: Array.from({ length: 20 }, (_, i) => ({ id: i, at: NOW - MIN, node: "pc", kind: "delivery_waiting" as const, detail: {} })),
    }, NOW);
    expect(lines.length).toBeLessThanOrEqual(BRIEF_MAX_LINES);
    expect(lines).toContain("  … and 44 more lanes");
    expect(lines.at(-1)).toBe("  … and 12 more alerts");
  });
});
