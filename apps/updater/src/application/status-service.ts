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

export function readStatus(p: { installer: Installer; store: UpdateStore; settings: SettingsSource }) {
  const layout = p.installer.layout();
  const settings = p.settings.read();
  const trust = p.store.trust();
  const checks = p.store.checks(10);        // newest first, as the store answers
  // The feed's word: the newest check that carries one. A later refusal leaves the last good word standing (§4.5).
  const feed = checks.flatMap(row => row.feedSeq !== null && row.feedExpiresAt !== null
    ? [{ channel: row.channel, seq: row.feedSeq, expiresAt: iso(row.feedExpiresAt) }]
    : [])[0] ?? null;
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
      at: iso(checks[0].at), channel: checks[0].channel, outcome: checks[0].outcome, detail: checks[0].detail, version: checks[0].version,
    },
    checks: checks.map(row => ({ at: iso(row.at), channel: row.channel, outcome: row.outcome, detail: row.detail, version: row.version })),
  });
}

// What readStatus hands back, named once: the protocol's own shape, kept honest by the parse inside it.
export type Status = ReturnType<typeof readStatus>;

const NONE = "none";
const orNone = (text: string | null): string => text ?? NONE;

// One fact per line, no colour: a terminal, a tmux pane, a log file all read it the same way.
export function formatStatus(s: Status): string {
  return [
    `install: ${s.installMethod}`,
    `channel: ${s.channel} · mode: ${s.mode} · pin: ${orNone(s.pin)} · window: ${orNone(s.window)}`,
    `current: ${orNone(s.current)} · previous: ${orNone(s.previous)} · good: ${orNone(s.good)} · staged: ${orNone(s.staged)}`,
    `key set: ${s.keySet === null ? NONE : `${s.keySet.version} (expires ${s.keySet.expiresAt})`}`,
    `feed: ${s.feed === null ? NONE : `${s.feed.channel} ${s.feed.seq} (expires ${s.feed.expiresAt})`}`,
    `last check: ${s.lastCheck === null ? "never" : `${s.lastCheck.outcome}${s.lastCheck.version === null ? "" : ` ${s.lastCheck.version}`} at ${s.lastCheck.at}`}`,
  ].join("\n");
}
