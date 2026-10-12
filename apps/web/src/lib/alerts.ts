// The fleet's alerts in the app (the owner, 2026-10-12; fleet-api §14): what each says, in words, from its kind and
// detail. A kind a newer fleet added still shows, in general words. `urgent`: the ones a push is sent for (the hub's
// alerts-service.ts says which); here, they stand out. What he has seen is his read mark of SEEN_MARK, on every device.
import { urgentAlert, type AlertWire } from "@morndo/protocol";

export const SEEN_MARK = "@alerts";
export type AlertWords = { title: string; detail: string; urgent: boolean };

const str = (v: unknown, or: string) => (typeof v === "string" && v ? v : or);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const secs = (ms: unknown) => { const n = num(ms); return n === null ? "a while" : n < 60_000 ? `${Math.round(n / 1000)} s` : `${Math.round(n / 60_000)} min`; };

// Why a delivery still waits (fleet clients §4.2), as the chat says it.
const WAITING: Record<string, string> = {
  menu_open: "a menu is open in its terminal", draft_present: "its input box has text that isn't from Morndo",
  no_input_box: "it has no input box right now", busy: "another typist holds its pane", no_pane: "it has no window",
  no_session: "it is still starting", earlier: "an earlier message to it goes first", unavailable: "its node couldn't be asked",
};
const STATE: Record<string, string> = { typed: "it was typed and isn't taken yet", held: "it waits in the lane's own queue" };

export function alertWords(a: AlertWire): AlertWords {
  const d = a.detail;
  const node = a.node ?? "the fleet";
  switch (a.kind) {
    case "source_changed": return {
      title: `${node} connected from a new address`,
      detail: `From ${str(d.from, "one address")} to ${str(d.to, "another")}. If you didn't move it, its key may be stolen: revoke the node.`, urgent: urgentAlert(a) };
    case "instance_conflict": return {
      title: `A second copy of ${node} tried to connect`,
      detail: "It was refused, because the running one answered. If you didn't start another copy, its key may be stolen: revoke the node.", urgent: urgentAlert(a) };
    case "dead_letter": return {
      title: `${str(d.subscriber, "A subscriber")} didn't take an event`,
      detail: `${str(d.path, "An event")}: ${str(d.reason, "refused")}${num(d.attempts) ? `, after ${num(d.attempts)} tries` : ""}. It was set aside; later events still go.`, urgent: urgentAlert(a) };
    case "backlog_full": return {
      title: `${str(d.subscriber, "A subscriber")} has too many events waiting`,
      detail: `${num(d.cap) ?? "Too many"} are waiting. Progress events are dropped until it catches up.`, urgent: urgentAlert(a) };
    case "delivery_waiting": {
      const minutes = num(d.minutes);
      const why = STATE[str(d.state, "")] ?? WAITING[str(d.reason, "")] ?? "it wasn't taken yet";
      const lane = str(d.lane, "a lane");
      return { title: `A message to ${lane === "manager" ? "the manager" : lane} has waited ${minutes ?? "some"} min`, detail: `It goes in once it can: ${why}.`, urgent: urgentAlert(a) };
    }
    case "lane_conflict": return {
      title: `Two windows are named ${str(d.name, "the same")}`,
      detail: "Messages to that name are refused until one is renamed. Each still takes messages by its worker ID.", urgent: urgentAlert(a) };
    case "subscriber_lagging": return {
      title: `${str(d.subscriber, "A subscriber")} is behind`,
      detail: `Its oldest event waiting is ${secs(d.oldestAgeMs)} old. The fleet keeps trying.`, urgent: urgentAlert(a) };
    case "clock_offset": return {
      title: `${node}'s clock is off by ${secs(d.offsetMs)}`,
      detail: "Nothing depends on it, but times shown for that machine may be off.", urgent: urgentAlert(a) };
    case "rate_limited": return {
      title: `${node} sent too many messages`,
      detail: "The fleet disconnected it. It connects again by itself.", urgent: urgentAlert(a) };
    case "unrouted_hook": return {
      title: `No one takes ${str(d.path, "these")} events`,
      detail: "They're counted and dropped. A subscriber in the fleet's config would receive them.", urgent: urgentAlert(a) };
    case "job_failed": return {
      title: `A background job failed: ${str(d.name, str(d.id, "a job"))}`,
      detail: `${str(d.outcome, "It didn't end well")}${a.node ? ` on ${a.node}` : ""}.`, urgent: urgentAlert(a) };
    case "job_unnoticed": return {
      title: `A job's notice didn't reach its lane: ${str(d.name, str(d.id, "a job"))}`,
      detail: "The job ended, but its lane never took the notice.", urgent: urgentAlert(a) };
    default: return { title: `${node}: ${a.kind.replace(/_/g, " ")}`, detail: "A newer fleet raised this alert.", urgent: urgentAlert(a) };
  }
}

// The ones he hasn't seen: newer than his mark.
export const unseen = (items: readonly AlertWire[], mark: number | undefined) => items.filter(a => a.at > (mark ?? 0)).length;
