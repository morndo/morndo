// `morndo update --status --json` (design §8.1): the machine as the hub and the web app read it. readStatus gathers
// the words from the ports and hands them through UpdateStatusSchema — what comes back is the protocol's own shape,
// so a reader never meets a field it does not know; formatStatus renders the same words for a terminal.
import { formatVersion, type Window } from "@morndo/domain";
import { UpdateStatusSchema } from "@morndo/protocol";
import type { Installer, SettingsSource, UpdateStore } from "./ports.ts";

// The store keeps epoch milliseconds; the wire's instants are ISO text, as the signed documents write them.
export const iso = (ms: number): string => new Date(ms).toISOString();

// §8.3's window text, as local hours ("02:00-06:00"): minutes of the day, both ends zero-padded.
const hhmm = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const windowText = (w: Window | null): string | null => w === null ? null : `${hhmm(w.start)}-${hhmm(w.end)}`;

// The wire caps a check row's detail at 500 (packages/protocol CheckRowSchema). The store clips on write now; a
// row an older updater wrote at any length is clipped here on its way out, so one long refusal — an unpack reason
// naming a long path — can never make --status throw where it should speak.
const DETAIL_MAX = 500;
const clipped = (detail: string): string => detail.length <= DETAIL_MAX ? detail : `${detail.slice(0, DETAIL_MAX - 1)}…`;

export function readStatus(p: { installer: Installer; store: UpdateStore; settings: SettingsSource }) {
  const layout = p.installer.layout();
  const settings = p.settings.read();
  const trust = p.store.trust();
  const checks = p.store.checks(10);        // newest first, as the store answers
  // The feed's word: the newest check that carries one, however far back among the kept rows — a later refusal
  // leaves the last good word standing (§4.5), and ten failures in a row must not hide it.
  const feedRow = p.store.lastFeedCheck();
  const feed = feedRow !== null && feedRow.feedSeq !== null && feedRow.feedExpiresAt !== null
    ? { channel: feedRow.channel, seq: feedRow.feedSeq, expiresAt: iso(feedRow.feedExpiresAt) }
    : null;
  return UpdateStatusSchema.parse({
    installMethod: layout.method,
    channel: settings.channel,
    mode: settings.mode,
    pin: settings.pin === null ? null : formatVersion(settings.pin),   // the settings hold it parsed; the wire wants text
    window: windowText(settings.window),
    current: layout.current,
    previous: layout.previous,
    good: layout.good,
    staged: p.store.staged()?.version ?? null,
    feed,
    keySet: trust.keySet === null ? null : { version: trust.keySet.version, expiresAt: iso(trust.keySet.expiresAt) },
    lastCheck: checks[0] === undefined ? null : {
      at: iso(checks[0].at), channel: checks[0].channel, outcome: checks[0].outcome, detail: clipped(checks[0].detail), version: checks[0].version,
    },
    checks: checks.map(row => ({ at: iso(row.at), channel: row.channel, outcome: row.outcome, detail: clipped(row.detail), version: row.version })),
    updates: p.store.recentUpdates(10).map(row => ({
      id: row.id,
      target: formatVersion(row.target),
      state: row.state,
      startedAt: iso(row.startedAt),
      finishedAt: row.finishedAt === null ? null : iso(row.finishedAt),
    })),
  });
}

// What readStatus hands back, named once: the protocol's own shape, kept honest by the parse inside it.
export type Status = ReturnType<typeof readStatus>;

const NONE = "none";
const orNone = (text: string | null): string => text ?? NONE;
// An unset window is any hour (§8.3: without one, any safe point). Pin and the other absent words stay "none".
const windowWord = (text: string | null): string => text ?? "any hour";

// One fact per line, no colour: a terminal, a tmux pane, a log file all read it the same way.
// `ownerOrigin` is the text line for a machine that runs the hub: "unset" when MORNDO_ORIGIN is not set, "set"
// when it is, and null on a node (no line). The JSON status does not carry it.
export function formatStatus(s: Status, o?: { ownerOrigin?: "unset" | "set" | null }): string {
  const lines = [
    `install: ${s.installMethod}`,
    `channel: ${s.channel} · mode: ${s.mode} · pin: ${orNone(s.pin)} · window: ${windowWord(s.window)}`,
    `current: ${orNone(s.current)} · previous: ${orNone(s.previous)} · good: ${orNone(s.good)} · staged: ${orNone(s.staged)}`,
    `key set: ${s.keySet === null ? NONE : `${s.keySet.version} (expires ${s.keySet.expiresAt})`}`,
    `feed: ${s.feed === null ? NONE : `${s.feed.channel} ${s.feed.seq} (expires ${s.feed.expiresAt})`}`,
    `last check: ${s.lastCheck === null ? "never" : `${s.lastCheck.outcome}${s.lastCheck.version === null ? "" : ` ${s.lastCheck.version}`} at ${s.lastCheck.at}`}`,
    `updates: ${(s.updates ?? []).length === 0 ? NONE : (s.updates ?? []).map(row => `${row.state} ${row.target}`).join(" · ")}`,
  ];
  if (o?.ownerOrigin === "unset") {
    lines.push("owner path: the https address is not judged (MORNDO_ORIGIN is not set for the updater)");
  } else if (o?.ownerOrigin === "set") {
    lines.push("owner path: https address judged (MORNDO_ORIGIN)");
  }
  return lines.join("\n");
}
