// The manager's inbox (the queue for the manager's terminal; one deliverer types each message
// exactly once and confirms it in the manager's transcript). For the manager's pane the hub no longer types: it drops a
// message here and reads back where it stands. The on-disk contract, v1:
//   msg/<key>.json     {v, key, sender, id, kind, text, enqueuedAt, seq, meta?}, created once with link(2) from tmp/;
//                      EEXIST = the same sender and id again (a duplicate: nothing new is queued)
//   state/<key>.json   {status, reason?, deliveredAt?, …}, written by the deliverer only; no file yet = queued
//   disabled           present: senders type directly, as before (the kill switch)
//   deliverer.json     {pid, at}: the deliverer's heartbeat, every 10 s; none for 90 s = nobody empties the inbox, so
//                      senders type directly instead of queueing
// key = sha256(sender + "\0" + id), first 24 hex characters.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export type InboxKind = "owner" | "tap" | "answer" | "event";
// gone: the hub's own word, never the deliverer's: msg/ can be read and the message isn't in it (removed by hand, say).
export type InboxStatus = "queued" | "held" | "typing" | "sent" | "stuck" | "accepted" | "delivered" | "lost" | "expired" | "cancelled" | "gone";
export type InboxReason = "menu" | "foreign_text" | "no_manager" | "busy" | "unseen" | "lock" | "lost_in_queue" | "unconfirmed";
// attempts: how often the deliverer pasted it (0: never typed, so no echo of it can reach the manager); null: unknown.
export type InboxState = { status: InboxStatus; reason: InboxReason | null; deliveredAt: number | null; attempts: number | null };

export type ManagerInbox = {
  dir: string;                                                  // where it is (kept with a queued answer, B6)
  // null: the inbox is switched off (`manager-inbox disable`) or no deliverer runs: type directly, as before.
  // notAfter: the spool drops the message, still untyped, once this time has passed (S7: a command is not typed hours later).
  enqueue(m: { id: string; kind: InboxKind; text: string; meta?: Record<string, string>; notAfter?: number }): { key: string; duplicate: boolean } | null;
  // False when the inbox is switched off or no deliverer is emptying it: the caller types directly, as enqueue does.
  accepting(): boolean;
  state(key: string): InboxState | null;                        // null: can't be told now (msg/ unreadable): ask again
  // Withdraw one of the hub's own messages (B1): ctl/<key>.cancel. The deliverer applies that to any non-terminal
  // status, typed or not. The hub writes it while a message is still untyped, and also for
  // `lost` or `unconfirmed`: those are not terminal, so a cleared line is typed again unless it is cancelled.
  cancel(key: string): boolean;                                 // false: the file was not written; the caller tries again
  // Ask the deliverer to send an undelivered message again (ctl/<key>.retry). It requeues anything not delivered.
  retry(key: string): boolean;
  // A retry starts the message over and the deliverer then ignores notAfter. Move the deadline so the hub can
  // withdraw it two minutes later (round 3.5). False: the message was not rewritten.
  renew(key: string, notAfter: number): boolean;
  deadline(key: string): number | null;
};

export const SENDER = "morndo-hub";
export const inboxKey = (sender: string, id: string) => createHash("sha256").update(`${sender}\0${id}`).digest("hex").slice(0, 24);

// As the inbox's own writers do: CRLF to LF, control characters other than newline and tab dropped (an ESC[201~ would
// end the bracketed paste early), trimmed.
const kept = (c: string) => { const n = c.charCodeAt(0); return n === 9 || n === 10 || (n >= 32 && n !== 127); };
export function cleanText(s: string): string {
  let out = "";
  for (const c of s.replace(/\r\n?/g, "\n")) if (kept(c)) out += c;
  return out.trim();
}

// ctl/<key>.<op>, the deliverer's request files (cancel, retry). A removed inbox stays removed (review #12).
function control(dir: string, key: string, op: "cancel" | "retry", now: () => number): boolean {
  if (!/^[0-9a-f]{24}$/.test(key)) return false;
  if (!existsSync(dir)) return false;
  const ctl = join(dir, "ctl");
  try { mkdirSync(ctl); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false; }
  try {
    const fd = openSync(join(ctl, `${key}.${op}`), "w", 0o600);
    try { writeSync(fd, `${new Date(now()).toISOString()}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    return true;
  } catch { return false; }   // the next poll tries again; a swallowed failure must not look done
}

function syncDir(path: string) {
  try { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* best effort */ }
}

const inboxOpen = (dir: string, now: () => number) => !existsSync(join(dir, "disabled")) && delivererAlive(dir, now());

export function delivererAlive(dir: string, now: number, maxAgeMs = 90_000): boolean {
  try {
    const hb = JSON.parse(readFileSync(join(dir, "deliverer.json"), "utf8")) as { at?: unknown };
    return typeof hb.at === "number" && now - hb.at < maxAgeMs;
  } catch { return false; }
}

const STATUSES = new Set<string>(["queued", "held", "typing", "sent", "stuck", "accepted", "delivered", "lost", "expired", "cancelled"]);
const REASONS = new Set<string>(["menu", "foreign_text", "no_manager", "busy", "unseen", "lock", "lost_in_queue", "unconfirmed"]);

export function managerInbox(dir: string, now: () => number = Date.now): ManagerInbox {
  return {
    dir,
    accepting() { return inboxOpen(dir, now); },
    enqueue({ id, kind, text, meta, notAfter }) {
      if (!inboxOpen(dir, now)) return null;
      for (const d of ["tmp", "msg"]) mkdirSync(join(dir, d), { recursive: true });
      const clean = cleanText(text);
      if (!clean) throw new Error("empty text");               // as the inbox's own writers refuse it (spool.ts)
      const key = inboxKey(SENDER, id);
      const msg = { v: 1, key, sender: SENDER, id, kind, text: clean, enqueuedAt: now(), seq: String(process.hrtime.bigint()),
        ...(notAfter !== undefined ? { notAfter } : {}), ...(meta ? { meta } : {}) };
      const tmp = join(dir, "tmp", `hub-${process.pid}-${randomUUID()}.json`);
      const fd = openSync(tmp, "w", 0o600);
      try { writeSync(fd, JSON.stringify(msg) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      try {
        linkSync(tmp, join(dir, "msg", `${key}.json`));
        syncDir(join(dir, "msg"));                               // the link itself survives a power loss, as spool.ts does
        return { key, duplicate: false };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return { key, duplicate: true };
        throw e;
      } finally {
        try { unlinkSync(tmp); } catch { /* already gone */ }
      }
    },
    cancel(key) { return control(dir, key, "cancel", now); },
    retry(key) { return control(dir, key, "retry", now); },
    renew(key, notAfter) {
      if (!/^[0-9a-f]{24}$/.test(key)) return false;
      const path = join(dir, "msg", `${key}.json`);
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; }
      catch { return false; }
      msg.notAfter = notAfter;
      try { mkdirSync(join(dir, "tmp"), { recursive: true }); } catch { return false; }
      const tmp = join(dir, "tmp", `hub-${process.pid}-${randomUUID()}.json`);
      try {
        const fd = openSync(tmp, "w", 0o600);
        try { writeSync(fd, JSON.stringify(msg) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(tmp, path);
        syncDir(join(dir, "msg"));
        return true;
      } catch {
        try { unlinkSync(tmp); } catch { /* already gone */ }
        return false;
      }
    },
    deadline(key) {
      if (!/^[0-9a-f]{24}$/.test(key)) return null;
      try {
        const msg = JSON.parse(readFileSync(join(dir, "msg", `${key}.json`), "utf8")) as { notAfter?: unknown };
        return typeof msg.notAfter === "number" ? msg.notAfter : null;
      } catch (e) {
        // The file is gone: an untyped command can never be typed, so its deadline has already passed. Any other
        // read failure stays unknown, so a brief unreadable directory does not withdraw a command that is still there.
        const code = e && typeof e === "object" && "code" in e ? (e as { code?: unknown }).code : undefined;
        return code === "ENOENT" ? 0 : null;
      }
    },
    state(key) {
      if (!/^[0-9a-f]{24}$/.test(key)) return null;
      if (!existsSync(join(dir, "msg", `${key}.json`))) {
        try { readdirSync(join(dir, "msg")); } catch { return null; }   // msg/ can't be read now: no verdict (B2)
        // Its file removed: the deliverer's state still stands, including one still in flight (accepted, typing,
        // sent). "gone" is only the absence of that state. A final word stays final (validated review finding #3).
        try {
          const s = JSON.parse(readFileSync(join(dir, "state", `${key}.json`), "utf8")) as Record<string, unknown>;
          const status = typeof s.status === "string" && STATUSES.has(s.status) ? s.status as InboxStatus : null;
          if (status) {
            const reason = typeof s.reason === "string" && REASONS.has(s.reason) ? s.reason as InboxReason : null;
            return { status, reason, deliveredAt: typeof s.deliveredAt === "number" ? s.deliveredAt : null, attempts: typeof s.attempts === "number" ? s.attempts : null };
          }
        } catch { /* no state file: gone */ }
        return { status: "gone", reason: null, deliveredAt: null, attempts: null };
      }
      let s: Record<string, unknown>;
      try { s = JSON.parse(readFileSync(join(dir, "state", `${key}.json`), "utf8")) as Record<string, unknown>; }
      catch { return { status: "queued", reason: null, deliveredAt: null, attempts: 0 }; }   // no state yet: waiting its turn
      const status = typeof s.status === "string" && STATUSES.has(s.status) ? s.status as InboxStatus : "queued";
      const reason = typeof s.reason === "string" && REASONS.has(s.reason) ? s.reason as InboxReason : null;
      return { status, reason, deliveredAt: typeof s.deliveredAt === "number" ? s.deliveredAt : null, attempts: typeof s.attempts === "number" ? s.attempts : null };
    },
  };
}
