// Retention (ADR-0008, A8): on start and daily, the hub prunes pairing tokens expired or redeemed more than 30 days ago
// and sessions ended more than 90 days ago, and Link requests a day past their life. Audit and decisions are provenance and are never pruned. Real SQLite.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_TTL_MS, endpointId, pairingTokenId, sessionId, type LinkRequest, type PairingToken, type Session } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { RETENTION, pruneOnce, startRetention } from "../src/application/retention.ts";

const DAY = 24 * 3_600_000;
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
let dir: string;
let store: Store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-retention-")); store = new Store(dir); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

const token = (id: string, issuedAt: number, redeemedAt: number | null = null): PairingToken => ({
  id: pairingTokenId(id), secretHash: `h-${id}`, issuedBy: { kind: "console" }, code: null, issuedAt, expiresAt: issuedAt + 10 * 60_000,
  redeemedAt, redeemedBy: redeemedAt === null ? null : endpointId("e1"),
});
const session = (id: string, startedAt: number, endedAt: number | null): Session => ({
  id: sessionId(id), endpointId: endpointId("e1"), startedAt, lastSeenAt: endedAt ?? startedAt, verifiedAt: startedAt,
  endedAt, endReason: endedAt === null ? null : "signed_out",
});
const link = (id: string, createdAt: number, state: LinkRequest["state"]): LinkRequest => ({
  id, secretHash: `s-${id}`, tokenSecretHash: `ts-${id}`, code: "123456", createdAt, expiresAt: createdAt + LINK_TTL_MS, state,
  requester: { login: null }, tokenId: null, decidedBy: null,
});
const ids = (table: string) => (store.db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map(r => r.id);

function seed() {
  store.saveEndpoint({ id: endpointId("e1"), name: "phone", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: NOW - 400 * DAY, pairedWith: pairingTokenId("t-old-redeemed"), lastSeenAt: NOW, revokedAt: null });
  store.saveToken(token("t-old-expired", NOW - 31 * DAY));                 // expired 31 days ago: pruned
  store.saveToken(token("t-recent-expired", NOW - 29 * DAY));              // expired 29 days ago: kept
  store.saveToken(token("t-old-redeemed", NOW - 400 * DAY, NOW - 400 * DAY)); // redeemed long ago: pruned
  store.saveToken(token("t-live", NOW - 60_000));                          // still valid: kept
  store.saveSession(session("s-old-ended", NOW - 120 * DAY, NOW - 91 * DAY));  // ended 91 days ago: pruned
  store.saveSession(session("s-recent-ended", NOW - 100 * DAY, NOW - 89 * DAY)); // ended 89 days ago: kept
  store.saveSession(session("s-open", NOW - DAY, null));                   // open: kept
  store.saveSession(session("s-abandoned", NOW - 120 * DAY, null));        // never ended, unseen 120 days: past every policy
  store.saveLink(link("l-old-denied", NOW - 2 * DAY, "denied"));           // ended two days ago: pruned
  store.saveLink(link("l-old-open", NOW - 2 * DAY, "open"));               // never answered, long past its life: pruned
  store.saveLink(link("l-recent", NOW - 3_600_000, "approved"));           // within the day: kept
  store.record([{ type: "EndpointRevoked", endpointId: endpointId("e9"), at: NOW - 900 * DAY }]);
  store.saveDecision("ny-ancient", { choice: { kind: "words" } });
  store.db.prepare("UPDATE decisions SET at = ?").run(NOW - 900 * DAY);
}

describe("pruning", () => {
  it("removes old expired or redeemed tokens and long-ended sessions, nothing else", () => {
    seed();
    expect(pruneOnce(store, NOW)).toEqual({ tokens: 2, sessions: 2, sends: 0, links: 2 });
    expect(ids("pairing_tokens")).toEqual(["t-live", "t-recent-expired"]);
    expect(ids("link_requests")).toEqual(["l-recent"]);
    expect(ids("sessions")).toEqual(["s-open", "s-recent-ended"]);
  });
  it("never prunes the audit log or the decisions, however old", () => {
    seed();
    pruneOnce(store, NOW);
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n).toBe(1);
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }).n).toBe(1);
  });
  it("keeps the endpoint whose pairing token was pruned, and its session start still works from the audit's point of view", () => {
    seed();
    pruneOnce(store, NOW);
    expect(store.endpoint("e1")?.pairedWith).toBe("t-old-redeemed");
  });
  it("uses the limits the brief sets, and a day past their life for Link requests", () => {
    expect(RETENTION).toEqual({ tokensMs: 30 * DAY, sessionsMs: 90 * DAY, linksMs: DAY, everyMs: DAY });
  });
});

describe("a prune that fails (review L1)", () => {
  it("is reported, never thrown: the hub keeps running and tries again next time", () => {
    vi.useFakeTimers();
    const broken = { pruneTokens: () => { throw new Error("SQLITE_BUSY: database is locked"); }, pruneSessions: () => 0 } as unknown as Store;
    const failures: unknown[] = [];
    const stop = startRetention(broken, () => NOW, () => {}, e => failures.push(e));
    expect(failures).toHaveLength(1);
    vi.advanceTimersByTime(24 * 3_600_000);
    expect(failures).toHaveLength(2);
    stop();
  });
});

describe("the schedule", () => {
  it("prunes on start and then daily", () => {
    vi.useFakeTimers();
    let now = NOW;
    seed();
    const runs: unknown[] = [];
    const stop = startRetention(store, () => now, r => runs.push(r));
    expect(runs).toEqual([{ tokens: 2, sessions: 2, sends: 0, links: 2 }]); // on start
    store.saveToken(token("t-later", NOW - 2 * DAY));
    now += 29 * DAY;                                                       // t-later expired 31 days ago by then
    vi.advanceTimersByTime(DAY);
    expect(runs.at(-1)).toEqual({ tokens: 2, sessions: 1, sends: 0, links: 1 }); // also t-recent-expired, s-recent-ended, l-recent
    stop();
    vi.advanceTimersByTime(5 * DAY);
    expect(runs).toHaveLength(2);
  });
});
