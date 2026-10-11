// SQLite adapter for the Access context (ADR-0005). The domain never sees SQL; this maps rows to domain values.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertLocalDisk } from "@morndo/service-kit";
import { migrate } from "./migrations.ts";
import {
  endpointId, pairingTokenId, sessionId,
  type AccessEvent, type AccountUsage, type BoardChanged, type EnginesChanged, type EscalationAnswered, type Endpoint, type LinkRequest, type LinkState, type NotificationEvent, type PairingToken,
  type Session, type Task, type TaskEvent, type Upload,
} from "@morndo/domain";

// What the audit log holds: Access events, and the principal's Decisions (the words of a Decision never, only their
// length and a hash), and his changes to the engines (ADR-0013).
export type AuditEvent = AccessEvent | NotificationEvent | (EscalationAnswered & { length?: number; digest?: string }) | EnginesChanged | BoardChanged;

// An agent token (ADR-0015, B1): the credential the manager's lane or a worker's changes the board with. Only its hash
// is kept; `role` says whether it acts as the manager or as the worker lane it names on each call.
export type AgentToken = { id: string; name: string; role: "manager" | "worker"; secretHash: string; createdAt: number; lastUsedAt: number | null; revokedAt: number | null };

type Row = Record<string, unknown>;

// A sends row, its state first (as Store.send returned it before `workerId` and `key` were added, so a failed assertion on
// one still prints its state).
export type SendRow = {
  state: "started" | "done"; at: number; outcome: string | null; typedAt: number | null; store: string | null; storeSeq: number | null; workerId: string | null; key: string;
};
type SendRowSql = {
  key: string; state: "started" | "done"; at: number; outcome: string | null; typed_at: number | null; node_store: string | null; node_store_seq: number | null; worker_id: string | null;
};
const sendRow = (r: SendRowSql): SendRow =>
  ({ state: r.state, at: r.at, outcome: r.outcome, typedAt: r.typed_at, store: r.node_store, storeSeq: r.node_store_seq, workerId: r.worker_id, key: r.key });
const SEND_COLUMNS = "key, state, at, outcome, typed_at, node_store, node_store_seq, worker_id";

export const READ_MARKS_KEPT = 500;

const linkFrom = (r: Row): LinkRequest => ({
  id: r.id as string, secretHash: r.secret_hash as string, tokenSecretHash: r.token_secret_hash as string, code: r.code as string,
  createdAt: r.created_at as number, expiresAt: r.expires_at as number, state: r.state as LinkState,
  requester: JSON.parse(r.requester as string) as LinkRequest["requester"],
  tokenId: r.token_id === null ? null : pairingTokenId(r.token_id as string),
  decidedBy: r.decided_by === null ? null : endpointId(r.decided_by as string),
});

export class Store {
  readonly db: Database.Database;

  constructor(dataDir: string) {
    assertLocalDisk(dataDir);                            // before anything is created: a missing dir is judged by its parent
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new Database(join(dataDir, "morndo.db"));
    this.db.pragma("journal_mode = WAL");
    // NORMAL, said out loud: what the hub has always run with, since better-sqlite3 builds SQLite with
    // SQLITE_DEFAULT_WAL_SYNCHRONOUS=1 (its compile_options; checked 2026-10-08, 13.0.3), which a WAL database takes on
    // its first write. Set here, so another build can't change it unseen. A power loss may take back the last commits,
    // never corrupt (https://www.sqlite.org/pragma.html#pragma_synchronous); fleet core §16.4.
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    try { migrate(this.db); }                            // numbered migrations (migrations.ts); refuses a newer database
    catch (e) { this.db.close(); throw e; }
  }

  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }

  setting<T>(key: string): T | null {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    try { return r ? (JSON.parse(r.value) as T) : null; } catch { return null; }
  }
  saveSetting(key: string, value: unknown) {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  // Append-only log (ADR-0004: every device change is recorded; ADR-0006: every Decision too).
  record(events: AuditEvent[]) {
    const ins = this.db.prepare("INSERT INTO audit (at, type, body) VALUES (?, ?, ?)");
    for (const e of events) ins.run(e.at, e.type, JSON.stringify(e));
  }
  // The audit rows of one type since a time, oldest first (AC13: the additions a device hasn't seen).
  auditOf(type: string, since: number): AuditEvent[] {
    return (this.db.prepare("SELECT body FROM audit WHERE type = ? AND at > ? ORDER BY seq").all(type, since) as Row[]).map(r => JSON.parse(r.body as string) as AuditEvent);
  }
  audit(limit = 50) {
    return (this.db.prepare("SELECT seq, at, type, body FROM audit ORDER BY seq DESC LIMIT ?").all(limit) as Row[])
      .map(r => ({ seq: r.seq as number, at: r.at as number, type: r.type as string, body: JSON.parse(r.body as string) as AuditEvent }));
  }

  // The latest Decision taken here per Escalation, so "already answered" survives a restart (E8).
  saveDecision(id: string, decision: unknown) {
    this.db.prepare("INSERT INTO decisions (escalation_id, at, body) VALUES (?, ?, ?) ON CONFLICT(escalation_id) DO UPDATE SET at = excluded.at, body = excluded.body")
      .run(id, Date.now(), JSON.stringify(decision));
  }
  // ADR-0010: the answers handed to the manager's inbox and not settled yet, one row per inbox message (its key), so two
  // answers to one ask (asked again in between) are each recorded when they arrive (code review B7).
  savePending(key: string, escalationId: string, body: unknown) {
    this.db.prepare("INSERT INTO pending_answers (key, escalation_id, body, at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body")
      .run(key, escalationId, JSON.stringify(body), Date.now());
  }
  pendingAnswers(): { key: string; escalationId: string; body: unknown }[] {
    return (this.db.prepare("SELECT key, escalation_id, body FROM pending_answers ORDER BY at").all() as Row[])
      .map(r => ({ key: r.key as string, escalationId: r.escalation_id as string, body: JSON.parse(r.body as string) as unknown }));
  }
  dropPending(key: string) { this.db.prepare("DELETE FROM pending_answers WHERE key = ?").run(key); }
  // Only while the stored Decision is still this one (the time it was taken): a newer answer's row is left alone (B3).
  replaceDecisionIf(id: string, at: number, decision: unknown) {
    this.db.prepare("UPDATE decisions SET body = ? WHERE escalation_id = ? AND json_extract(body, '$.at') = ?").run(JSON.stringify(decision), id, at);
  }
  dropDecisionIf(id: string, at: number) {
    this.db.prepare("DELETE FROM decisions WHERE escalation_id = ? AND json_extract(body, '$.at') = ?").run(id, at);
  }
  decisions(sinceMs = 7 * 24 * 3_600_000): { id: string; decision: unknown }[] {
    return (this.db.prepare("SELECT escalation_id, body FROM decisions WHERE at >= ?").all(Date.now() - sinceMs) as Row[])
      .map(r => ({ id: r.escalation_id as string, decision: JSON.parse(r.body as string) as unknown }));
  }

  // Retention (ADR-0008, A8; the policy is in application/retention.ts): pairing tokens expired or redeemed before
  // `before`, and sessions ended (or, never ended, last seen) before `before`. Returns how many went.
  pruneTokens(before: number): number {
    return this.db.prepare(`DELETE FROM pairing_tokens WHERE (redeemed_at IS NOT NULL AND redeemed_at < @before)
      OR (redeemed_at IS NULL AND expires_at < @before)`).run({ before }).changes;
  }
  pruneSessions(before: number): number {
    return this.db.prepare(`DELETE FROM sessions WHERE (ended_at IS NOT NULL AND ended_at < @before)
      OR (ended_at IS NULL AND last_seen_at < @before)`).run({ before }).changes;
  }

  // S5: a request id's record, written "started" before typing and "done" after; kept 24 hours. `typedAt`: the node's
  // own time of the typing (fleet core §3.1), null for a row from before it was kept. `outcome`: "typed", "queued"
  // (handed to the manager's inbox, ADR-0010), or "requeued" (queued once more after the inbox gave the first up,
  // ADR-0011); null while started. `workerId`: the worker an answer went to (null for a
  // send, whose repeat names its worker itself).
  send(key: string): SendRow | null {
    const r = this.db.prepare(`SELECT ${SEND_COLUMNS} FROM sends WHERE key = ?`).get(key) as SendRowSql | undefined;
    return r ? sendRow(r) : null;
  }
  // An escalation answer, written "started" before it is typed, as a send is (fleet core §3.1; final review C1 and its
  // follow-up): under its answer key, with the worker it goes to and the request that sends it ("<endpoint>:<request
  // id>"); its store and store sequence once its node answers (setSendStore). A repeat by either finds it and asks that
  // node (SteeringService's settle) instead of typing it again, after a hub that stopped while typing it too. False if a
  // row for the key is there already.
  startAnswer(key: string, at: number, o: { workerId: string | null; request: string }): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO sends (key, state, at, worker_id, request) VALUES (?, 'started', ?, ?, ?)")
      .run(key, at, o.workerId, o.request).changes === 1;
  }
  // The answer a request sent, if any (its row, under its answer key).
  sendOfRequest(request: string): SendRow | null {
    const r = this.db.prepare(`SELECT ${SEND_COLUMNS} FROM sends WHERE request = ?`).get(request) as SendRowSql | undefined;
    return r ? sendRow(r) : null;
  }
  // Every answer to one ask kept here (24 hours), whatever its choice: the rows whose answer key starts with `prefix`
  // (escalation-service.ts askPrefix), oldest first. SQLite's substr counts characters, so the prefix is counted in
  // code points, not UTF-16 units.
  answersOfAsk(prefix: string): SendRow[] {
    return (this.db.prepare(`SELECT ${SEND_COLUMNS} FROM sends WHERE substr(key, 1, ?) = ? ORDER BY at, key`)
      // oxlint-disable-next-line typescript/no-misused-spread -- code points on purpose: SQLite's substr counts them (above)
      .all([...prefix].length, prefix) as SendRowSql[]).map(sendRow);
  }
  // The store of the node a send went to (fleet core §3.1), kept with its row: only that store can say it never started.
  // With it, the store sequence its answer gave (null when unknown): a lower one from that store later means its
  // database went backwards (final review I2).
  setSendStore(key: string, store: string, storeSeq: number | null = null) {
    this.db.prepare("UPDATE sends SET node_store = ?, node_store_seq = ? WHERE key = ?").run(store, storeSeq, key);
  }
  startSend(key: string, at: number): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO sends (key, state, at) VALUES (?, 'started', ?)").run(key, at).changes === 1;
  }
  finishSend(key: string, typedAt: number) { this.db.prepare("UPDATE sends SET state = 'done', outcome = 'typed', typed_at = ? WHERE key = ?").run(typedAt, key); }
  // Handed to the manager's inbox (ADR-0010): done, with no typedAt, because the deliverer types it.
  finishQueued(key: string) { this.db.prepare("UPDATE sends SET state = 'done', outcome = 'queued' WHERE key = ?").run(key); }
  // Queued once more after the inbox gave the first up (ADR-0011): the row remembers it, so a further repeat adds nothing.
  finishRequeued(key: string) { this.db.prepare("UPDATE sends SET state = 'done', outcome = 'requeued' WHERE key = ?").run(key); }
  // Commands handed to the inbox (outcome queued, no answer request). Answers carry a request and are not these.
  queuedCommands(): string[] {
    return (this.db.prepare("SELECT key FROM sends WHERE state = 'done' AND outcome = 'queued' AND request IS NULL").all() as { key: string }[])
      .map(r => r.key);
  }
  // A crash between startAnswer and finishQueued, for a manager that is not running (no worker). The message is
  // already in the inbox. Left started, every repeat is refused as uncertain (round 3.8).
  recoverQueuedAnswers(): number {
    return this.db.prepare(`UPDATE sends SET state = 'done', outcome = 'queued'
      WHERE state = 'started' AND worker_id IS NULL AND substr(key, 1, 7) = 'answer:'`).run().changes;
  }
  dropSend(key: string) { this.db.prepare("DELETE FROM sends WHERE key = ?").run(key); }
  pruneSends(now: number, keepMs = 24 * 3_600_000): number {
    return this.db.prepare("DELETE FROM sends WHERE at < ?").run(now - keepMs).changes;
  }

  // When an ask that has no message of its own (a list item without buttons, a menu on a screen) was first seen: kept so
  // its answer key (escalation-service.ts answerKey) is the same after a restart. Keyed by the ask's own identity.
  askFirstSeen(): Map<string, number> {
    return new Map((this.db.prepare("SELECT key, at FROM ask_first_seen").all() as { key: string; at: number }[]).map(r => [r.key, r.at]));
  }
  setAskFirstSeen(key: string, at: number) { this.db.prepare("INSERT OR REPLACE INTO ask_first_seen (key, at) VALUES (?, ?)").run(key, at); }
  dropAskFirstSeen(key: string) { this.db.prepare("DELETE FROM ask_first_seen WHERE key = ?").run(key); }

  // The images the principal pasted (S1, S2): kept so an attach works after a restart, within the upload's day.
  saveUpload(u: Upload) {
    this.db.prepare("INSERT OR REPLACE INTO uploads (id, endpoint_id, path, mime, size, at) VALUES (?, ?, ?, ?, ?, ?)").run(u.id, u.endpointId, u.path, u.mime, u.size, u.at);
  }
  upload(id: string): Upload | undefined {
    const r = this.db.prepare("SELECT * FROM uploads WHERE id = ?").get(id) as Row | undefined;
    return r ? { id: r.id as string, endpointId: endpointId(r.endpoint_id as string), path: r.path as string, mime: r.mime as Upload["mime"], size: r.size as number, at: r.at as number } : undefined;
  }
  pruneUploads(before: number): number { return this.db.prepare("DELETE FROM uploads WHERE at < ?").run(before).changes; }

  // Reading (ADR-0008 phase D): one read mark per conversation (the forward-only rule is the domain's, O7), and mute.
  readMarks(): Record<string, number> {
    return Object.fromEntries((this.db.prepare("SELECT conversation, at FROM read_marks").all() as { conversation: string; at: number }[]).map(r => [r.conversation, r.at]));
  }
  // At most READ_MARKS_KEPT marks, the latest: every hello sends them all, and any name can be marked (review L6).
  saveReadMark(conversation: string, at: number) {
    this.db.prepare("INSERT INTO read_marks (conversation, at) VALUES (?, ?) ON CONFLICT(conversation) DO UPDATE SET at = excluded.at").run(conversation, at);
    this.db.prepare("DELETE FROM read_marks WHERE conversation NOT IN (SELECT conversation FROM read_marks ORDER BY at DESC LIMIT ?)").run(READ_MARKS_KEPT);
  }
  mutedConversations(): string[] {
    return (this.db.prepare("SELECT conversation FROM conversation_prefs WHERE muted = 1 ORDER BY conversation").all() as { conversation: string }[]).map(r => r.conversation);
  }
  // "Last caught up" (ADR-0009, C7): one time, in the settings table; the forward-only rule is the domain's.
  caughtUpAt(): number | null { const v = this.setting<unknown>("caught_up_at"); return typeof v === "number" ? v : null; }
  saveCaughtUp(at: number) { this.saveSetting("caught_up_at", at); }
  setMuted(conversation: string, muted: boolean) {
    if (!muted) { this.db.prepare("DELETE FROM conversation_prefs WHERE conversation = ?").run(conversation); return; }
    this.db.prepare("INSERT INTO conversation_prefs (conversation, muted) VALUES (?, 1) ON CONFLICT(conversation) DO UPDATE SET muted = 1").run(conversation);
  }

  saveToken(t: PairingToken) {
    this.db.prepare(`INSERT INTO pairing_tokens (id, secret_hash, issued_by, code, issued_at, expires_at, redeemed_at, redeemed_by)
      VALUES (@id, @secretHash, @issuedBy, @code, @issuedAt, @expiresAt, @redeemedAt, @redeemedBy)
      ON CONFLICT(id) DO UPDATE SET redeemed_at = excluded.redeemed_at, redeemed_by = excluded.redeemed_by, expires_at = excluded.expires_at`)
      .run({ ...t, issuedBy: JSON.stringify(t.issuedBy) });
  }
  tokenBySecretHash(hash: string): PairingToken | null {
    return this.#token(this.db.prepare("SELECT * FROM pairing_tokens WHERE secret_hash = ?").get(hash) as Row | undefined);
  }
  // The tokens an Endpoint issued that are neither used nor past their time (whole-branch review M1).
  openTokensIssuedBy(endpointId: string, now: number): PairingToken[] {
    return (this.db.prepare("SELECT * FROM pairing_tokens WHERE redeemed_at IS NULL AND expires_at > ? AND json_extract(issued_by, '$.endpointId') = ?")
      .all(now, endpointId) as Row[]).flatMap(r => this.#token(r) ?? []);
  }
  token(id: string): PairingToken | null {
    return this.#token(this.db.prepare("SELECT * FROM pairing_tokens WHERE id = ?").get(id) as Row | undefined);
  }
  #token(r: Row | undefined): PairingToken | null {
    return r ? {
      id: pairingTokenId(r.id as string), secretHash: r.secret_hash as string, issuedBy: JSON.parse(r.issued_by as string),
      code: (r.code as string | null) ?? null, issuedAt: r.issued_at as number, expiresAt: r.expires_at as number,
      redeemedAt: (r.redeemed_at as number | null) ?? null,
      redeemedBy: r.redeemed_by === null ? null : endpointId(r.redeemed_by as string),
    } : null;
  }

  // Link requests (ADR-0008 phase E, AC11). `identity`: the hub identity the approving device had pinned, and its
  // proof (an HMAC under a key only the two devices saw), handed to the new device for its fingerprint check.
  saveLink(r: LinkRequest, identity: { pinned: string; proof: string } | null = null) {
    this.db.prepare(`INSERT INTO link_requests (id, secret_hash, token_secret_hash, code, created_at, expires_at, state, requester, token_id, decided_by, pinned, proof)
      VALUES (@id, @secretHash, @tokenSecretHash, @code, @createdAt, @expiresAt, @state, @requester, @tokenId, @decidedBy, @pinned, @proof)
      ON CONFLICT(id) DO UPDATE SET state = excluded.state, token_id = excluded.token_id, decided_by = excluded.decided_by,
        pinned = COALESCE(excluded.pinned, link_requests.pinned), proof = COALESCE(excluded.proof, link_requests.proof)`)
      .run({ ...r, requester: JSON.stringify(r.requester), pinned: identity?.pinned ?? null, proof: identity?.proof ?? null });
  }
  link(id: string): { request: LinkRequest; identity: { pinned: string; proof: string } | null } | null {
    const r = this.db.prepare("SELECT * FROM link_requests WHERE id = ?").get(id) as Row | undefined;
    if (!r) return null;
    const identity = typeof r.pinned === "string" && typeof r.proof === "string" ? { pinned: r.pinned, proof: r.proof } : null;
    return { request: linkFrom(r), identity };
  }
  openLinks(): LinkRequest[] {
    return (this.db.prepare("SELECT * FROM link_requests WHERE state = 'open'").all() as Row[]).map(linkFrom);
  }
  pruneLinks(before: number): number {
    return this.db.prepare("DELETE FROM link_requests WHERE expires_at < ?").run(before).changes;
  }

  // Push subscriptions (ADR-0008 phase F, N4): at most one per Endpoint, as the browser gave it.
  savePushSubscription(endpointId: string, s: { endpoint: string; p256dh: string; auth: string }, at: number) {
    this.db.prepare(`INSERT INTO push_subscriptions (endpoint_id, url, p256dh, auth, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint_id) DO UPDATE SET url = excluded.url, p256dh = excluded.p256dh, auth = excluded.auth, at = excluded.at`)
      .run(endpointId, s.endpoint, s.p256dh, s.auth, at);
  }
  pushSubscriptions(): { endpointId: string; endpoint: string; p256dh: string; auth: string }[] {
    return (this.db.prepare("SELECT endpoint_id, url, p256dh, auth FROM push_subscriptions ORDER BY at").all() as Row[])
      .map(r => ({ endpointId: r.endpoint_id as string, endpoint: r.url as string, p256dh: r.p256dh as string, auth: r.auth as string }));
  }
  deletePushSubscription(endpointId: string): boolean {
    return this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint_id = ?").run(endpointId).changes > 0;
  }

  saveEndpoint(e: Endpoint) {
    this.db.prepare(`INSERT INTO endpoints (id, name, credential_id, public_key, counter, transports, paired_at, paired_with, last_seen_at, revoked_at)
      VALUES (@id, @name, @credentialId, @publicKey, @counter, @transports, @pairedAt, @pairedWith, @lastSeenAt, @revokedAt)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, counter = excluded.counter,
        last_seen_at = excluded.last_seen_at, revoked_at = excluded.revoked_at`)
      .run({
        id: e.id, name: e.name, credentialId: e.credential.id, publicKey: Buffer.from(e.credential.publicKey),
        counter: e.credential.counter, transports: JSON.stringify(e.credential.transports),
        pairedAt: e.pairedAt, pairedWith: e.pairedWith, lastSeenAt: e.lastSeenAt, revokedAt: e.revokedAt,
      });
  }
  #endpoint(r: Row): Endpoint {
    return {
      id: endpointId(r.id as string), name: r.name as string,
      credential: {
        id: r.credential_id as string, publicKey: new Uint8Array(r.public_key as Buffer),
        counter: r.counter as number, transports: JSON.parse(r.transports as string) as string[],
      },
      pairedAt: r.paired_at as number, pairedWith: pairingTokenId(r.paired_with as string),
      lastSeenAt: (r.last_seen_at as number | null) ?? null, revokedAt: (r.revoked_at as number | null) ?? null,
    };
  }
  endpoint(id: string): Endpoint | null {
    const r = this.db.prepare("SELECT * FROM endpoints WHERE id = ?").get(id) as Row | undefined;
    return r ? this.#endpoint(r) : null;
  }
  endpointByCredential(credentialId: string): Endpoint | null {
    const r = this.db.prepare("SELECT * FROM endpoints WHERE credential_id = ?").get(credentialId) as Row | undefined;
    return r ? this.#endpoint(r) : null;
  }
  endpoints(): Endpoint[] {
    return (this.db.prepare("SELECT * FROM endpoints ORDER BY paired_at").all() as Row[]).map(r => this.#endpoint(r));
  }
  activeEndpointCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM endpoints WHERE revoked_at IS NULL").get() as { n: number }).n;
  }

  saveSession(s: Session) {
    this.db.prepare(`INSERT INTO sessions (id, endpoint_id, started_at, last_seen_at, verified_at, ended_at, end_reason)
      VALUES (@id, @endpointId, @startedAt, @lastSeenAt, @verifiedAt, @endedAt, @endReason)
      ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, verified_at = excluded.verified_at,
        ended_at = excluded.ended_at, end_reason = excluded.end_reason`)
      .run(s);
  }
  #session(r: Row): Session {
    return {
      id: sessionId(r.id as string), endpointId: endpointId(r.endpoint_id as string),
      startedAt: r.started_at as number, lastSeenAt: r.last_seen_at as number,
      verifiedAt: (r.verified_at as number | null) ?? (r.started_at as number),
      endedAt: (r.ended_at as number | null) ?? null, endReason: (r.end_reason as Session["endReason"]) ?? null,
    };
  }
  session(id: string): Session | null {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return r ? this.#session(r) : null;
  }
  openSessionsOf(endpoint: string): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE endpoint_id = ? AND ended_at IS NULL").all(endpoint) as Row[]).map(r => this.#session(r));
  }

  // The board (ADR-0015): every task, its events in order, and the key counter (B7: a number is never given twice).
  tasks(): Task[] {
    return (this.db.prepare("SELECT * FROM board_tasks ORDER BY n").all() as Row[]).map(taskFrom);
  }
  // The tasks the board shows: every open one, and Done since `doneAfter` (a week, DONE_SHOWN_MS).
  shownTasks(doneAfter: number): Task[] {
    return (this.db.prepare("SELECT * FROM board_tasks WHERE status != 'done' OR done_at > ? ORDER BY n").all(doneAfter) as Row[]).map(taskFrom);
  }
  // The tasks in progress now (B5), by the (status, assignee) index.
  tasksInProgress(): Task[] {
    return (this.db.prepare("SELECT * FROM board_tasks WHERE status = 'doing' ORDER BY n").all() as Row[]).map(taskFrom);
  }
  taskInProgressOf(lane: string): Task | null {
    const r = this.db.prepare("SELECT * FROM board_tasks WHERE status = 'doing' AND assignee = ? ORDER BY n LIMIT 1").get(lane) as Row | undefined;
    return r ? taskFrom(r) : null;
  }
  task(key: string): Task | null {
    const r = this.db.prepare("SELECT * FROM board_tasks WHERE key = ?").get(key) as Row | undefined;
    return r ? taskFrom(r) : null;
  }
  // The next task number, and taking it: the counter only grows, and is written in the same transaction as the task,
  // only once the task is accepted (a refused filing burns no number).
  peekTaskNumber(): number { return (this.setting<number>("board_counter") ?? 0) + 1; }
  takeTaskNumber(n: number) {
    if (n !== this.peekTaskNumber()) throw new Error(`task number ${n} is not the next one`);
    this.saveSetting("board_counter", n);
  }
  saveTask(t: Task) {
    this.db.prepare(`INSERT INTO board_tasks (key, n, title, description, status, assignee, priority, blocked_reason, created_at, updated_at, created_by, rev, done_at, comments)
      VALUES (@key, @n, @title, @description, @status, @assignee, @priority, @blockedReason, @createdAt, @updatedAt, @createdBy, @rev, @doneAt, @comments)
      ON CONFLICT(key) DO UPDATE SET title = excluded.title, description = excluded.description, status = excluded.status, assignee = excluded.assignee,
        priority = excluded.priority, blocked_reason = excluded.blocked_reason, updated_at = excluded.updated_at, rev = excluded.rev, done_at = excluded.done_at, comments = excluded.comments`)
      .run({ ...t, createdBy: JSON.stringify(t.createdBy) });
  }
  saveTaskEvent(e: TaskEvent) {
    this.db.prepare("INSERT INTO board_events (key, rev, at, actor, change) VALUES (?, ?, ?, ?, ?)").run(e.key, e.rev, e.at, JSON.stringify(e.actor), JSON.stringify(e.change));
  }
  taskEvents(key: string): TaskEvent[] {
    return (this.db.prepare("SELECT key, rev, at, actor, change FROM board_events WHERE key = ? ORDER BY rev").all(key) as Row[])
      .map(r => ({ key: r.key as Task["key"], rev: r.rev as number, at: r.at as number, actor: JSON.parse(r.actor as string) as TaskEvent["actor"], change: JSON.parse(r.change as string) as TaskEvent["change"] }));
  }

  // Agent tokens (ADR-0015, B1).
  saveAgentToken(t: AgentToken) {
    this.db.prepare(`INSERT INTO agent_tokens (id, name, role, secret_hash, created_at, last_used_at, revoked_at) VALUES (@id, @name, @role, @secretHash, @createdAt, @lastUsedAt, @revokedAt)
      ON CONFLICT(id) DO UPDATE SET last_used_at = excluded.last_used_at, revoked_at = excluded.revoked_at`).run(t);
  }
  agentTokenBySecretHash(hash: string): AgentToken | null {
    const r = this.db.prepare("SELECT * FROM agent_tokens WHERE secret_hash = ?").get(hash) as Row | undefined;
    return r ? agentTokenFrom(r) : null;
  }
  agentToken(id: string): AgentToken | null {
    const r = this.db.prepare("SELECT * FROM agent_tokens WHERE id = ?").get(id) as Row | undefined;
    return r ? agentTokenFrom(r) : null;
  }
  agentTokens(): AgentToken[] {
    return (this.db.prepare("SELECT * FROM agent_tokens ORDER BY created_at").all() as Row[]).map(agentTokenFrom);
  }
  // Touched at most once a minute per token: a lane polls the board often.
  touchAgentToken(id: string, at: number) {
    this.db.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)").run(at, id, at - 60_000);
  }

  // Usage (ADR-0016): the latest state of each account, whole, so the dashboard is as it was after a restart.
  usageAccounts(): AccountUsage[] {
    return (this.db.prepare("SELECT body FROM usage_accounts ORDER BY account").all() as Row[]).map(r => JSON.parse(r.body as string) as AccountUsage);
  }
  saveUsageAccount(a: AccountUsage) {
    this.db.prepare("INSERT INTO usage_accounts (account, body, reported_at) VALUES (?, ?, ?) ON CONFLICT(account) DO UPDATE SET body = excluded.body, reported_at = excluded.reported_at")
      .run(a.account, JSON.stringify(a), a.reportedAt);
  }

  // One comment per job id. `open` is a claim this process still has to finish. A settled row is not taken again.
  claimJobNotice(id: string): "claimed" | "open" | "settled" {
    if (this.db.prepare("INSERT OR IGNORE INTO job_notices (id, result) VALUES (?, 'open')").run(id).changes === 1) return "claimed";
    const row = this.db.prepare("SELECT result FROM job_notices WHERE id = ?").get(id) as { result: string } | undefined;
    return row?.result === "open" ? "open" : "settled";
  }
  finishJobNotice(id: string, result: "commented" | "given_up" | "task_gone") {
    this.db.prepare("UPDATE job_notices SET result = ? WHERE id = ?").run(result, id);
  }
  jobNotices(): { id: string; result: string }[] {
    return this.db.prepare("SELECT id, result FROM job_notices").all() as { id: string; result: string }[];
  }
  unackedJobNotices(): { id: string; result: string }[] {
    return this.db.prepare("SELECT id, result FROM job_notices WHERE result != 'open' AND acked = 0").all() as { id: string; result: string }[];
  }
  ackJobNotice(id: string) {
    this.db.prepare("UPDATE job_notices SET acked = 1 WHERE id = ?").run(id);
  }

  close() { this.db.close(); }
}

const taskFrom = (r: Row): Task => ({
  key: r.key as Task["key"], n: r.n as number, title: r.title as string, description: r.description as string, status: r.status as Task["status"],
  assignee: (r.assignee as string | null) ?? null, priority: r.priority as Task["priority"], blockedReason: (r.blocked_reason as string | null) ?? null,
  createdAt: r.created_at as number, updatedAt: r.updated_at as number, createdBy: JSON.parse(r.created_by as string) as Task["createdBy"],
  rev: r.rev as number, doneAt: (r.done_at as number | null) ?? null, comments: r.comments as number,
});
const agentTokenFrom = (r: Row): AgentToken => ({
  id: r.id as string, name: r.name as string, role: r.role as AgentToken["role"], secretHash: r.secret_hash as string,
  createdAt: r.created_at as number, lastUsedAt: (r.last_used_at as number | null) ?? null, revokedAt: (r.revoked_at as number | null) ?? null,
});
