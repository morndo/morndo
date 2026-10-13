// `morndo lanes brief` (reliable lanes design §3.5): what an orchestrator must know after a restart or a compaction, from
// the fleet and not from its conversation, in at most 60 lines. Run as a SessionStart hook (matcher
// `startup|resume|clear|compact`), its output is put back into the orchestrator's context each time
// (https://code.claude.com/docs/en/hooks, SessionStart, read 2026-10-13). In order:
// - the lanes: each one's last turn (status, how long ago), its deadline or what it waits on, stale ones with their stall
//   count, and lanes with no turn seen in the last day;
// - deliveries not yet taken (queued, typed or held), with why they wait;
// - the last day's alerts.
// Pure: the fleet's answers in, lines out.
import type { Alert, Delivery, LaneWatchEntry } from "@morndo/protocol";

export const BRIEF_MAX_LINES = 60;
const LANES_MAX = 36;
const DELIVERIES_MAX = 8;
const ALERTS_MAX = 8;
const DAY_MS = 86_400_000;

export type BriefInput = {
  lanes: { name: string; node: string; workerId: string | null; conflict: boolean }[];
  watch: LaneWatchEntry[];
  deliveries: Delivery[];
  alerts: Alert[];
};

const ago = (ms: number) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);
const STATUS: Record<string, string> = { done: "DONE", blocked: "BLOCKED", needs_decision: "NEEDS DECISION", waiting: "WAITING" };
const more = (n: number, what: string) => (n > 0 ? [`  … and ${n} more ${what}`] : []);

function laneLine(w: LaneWatchEntry, now: number): string {
  const said = w.status ? STATUS[w.status] ?? w.status : "no status";
  const parts = [`${w.window}@${w.node}`, said, `${ago(now - w.at)} ago`];
  if (w.waitingOn) parts.push(`on ${w.waitingOn}`);
  if (w.stale) parts.push(`STALE${w.stalls > 1 ? ` x${w.stalls}` : ""}${w.stalls > 2 ? ", re-plan it" : ""}`);
  else if (w.deadline !== null) parts.push(w.deadline > now ? `deadline in ${ago(w.deadline - now)}` : "deadline passed");
  return `  ${parts.join(" · ")}`;
}

export function briefLines(b: BriefInput, now: number): string[] {
  const lines = [`Fleet brief, ${new Date(now).toISOString()} (morndo lanes brief)`];
  // Stale first, then the ones with a deadline, then the rest; newest first within each.
  const rank = (w: LaneWatchEntry) => (w.stale ? 0 : w.deadline !== null ? 1 : 2);
  const watched = [...b.watch].sort((x, y) => rank(x) - rank(y) || y.at - x.at);
  const seen = new Set(watched.map(w => `${w.node}\u0000${w.window}`));
  const unseen = b.lanes.filter(l => !seen.has(`${l.node}\u0000${l.name}`));
  lines.push(`Lanes (${b.lanes.length}; ${watched.filter(w => w.stale).length} stale):`);
  const shown = watched.slice(0, LANES_MAX).map(w => laneLine(w, now));
  lines.push(...shown, ...more(watched.length - shown.length, "lanes"));
  if (unseen.length) {
    const names = unseen.map(l => `${l.name}@${l.node}${l.workerId === null ? " (offline)" : ""}${l.conflict ? " (name conflict)" : ""}`);
    lines.push(`  no turn seen in the last day: ${names.slice(0, 12).join(", ")}${names.length > 12 ? `, … ${names.length - 12} more` : ""}`);
  }
  // A delivery to a worker ID (the lane watch's nudge) names its lane, while one lane holds that pane.
  const byWorker = new Map(b.lanes.flatMap(l => (l.workerId === null ? [] : [[l.workerId, `${l.name}@${l.node}`] as const])));
  const open = b.deliveries.filter(d => d.state === "queued" || d.state === "typed" || d.state === "held");
  lines.push(`Deliveries not yet taken (${open.length}):`);
  for (const d of open.slice(0, DELIVERIES_MAX)) {
    const to = "lane" in d.target ? d.target.lane : byWorker.get(d.target.workerId) ?? d.target.workerId;
    lines.push(`  ${d.id} → ${to} · ${d.state}${d.waiting ? ` (${d.waiting.reason})` : ""} · ${ago(now - d.queuedAt)}`);
  }
  lines.push(...more(open.length - DELIVERIES_MAX, "deliveries"));
  const recent = b.alerts.filter(a => now - a.at < DAY_MS).sort((x, y) => y.at - x.at);
  lines.push(`Alerts in the last day (${recent.length}):`);
  for (const a of recent.slice(0, ALERTS_MAX)) {
    const lane = typeof a.detail.lane === "string" ? ` ${a.detail.lane}` : "";
    lines.push(`  ${a.kind}${a.node ? ` on ${a.node}` : ""}${lane} · ${ago(now - a.at)} ago`);
  }
  lines.push(...more(recent.length - ALERTS_MAX, "alerts"));
  return lines.slice(0, BRIEF_MAX_LINES);
}
