// The revocation journal's hub half (RL10, docs/design/updates/README.md §11.5): every revocation is appended to
// revoked.log beside morndo.db before the database write, and each start applies the journal again — so a database
// restored from an older copy (the updater's rollback, or a copy put back by hand) brings no revoked device or agent
// token back. The start here is what main.ts does: open the store, wire the services, apply.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RevocationJournal } from "@morndo/service-kit";
import { Store } from "../src/adapters/store.ts";
import { AccessService } from "../src/application/access-service.ts";
import { AgentAccess } from "../src/application/agent-access.ts";
import { applyRevocationJournal } from "../src/application/revocations.ts";
import type { Passkeys } from "../src/adapters/passkeys.ts";

let dir: string;
let store: Store;
let journal: RevocationJournal;
let now: number;
let nextCred: number;
let access: AccessService;
let agents: AgentAccess;

const fakePasskeys = (): Passkeys => ({
  registrationOptions: async () => ({ challenge: `reg-${Math.random()}` }) as never,
  verifyRegistration: async () =>
    ({ credential: { id: `cred-${++nextCred}`, publicKey: new Uint8Array([1]), counter: 1, transports: [] }, userVerified: true }),
  authenticationOptions: async () => ({ challenge: `auth-${Math.random()}` }) as never,
  verifyAuthentication: async () => ({ userVerified: true, newCounter: 2 }),
});

async function pairDevice(name = "iPhone") {
  const { secret } = access.issueConsoleToken();
  const opts = await access.pairOptions(secret, name);
  if (!("flowId" in opts)) throw new Error(`refused: ${opts.refused}`);
  return { secret, result: await access.pairVerify(opts.flowId, {} as never) };
}

// The copy a backup is: the database as it stood, taken whole. WAL keeps recent commits in morndo.db-wal, so the
// write-ahead log is checkpointed into the file first; putting the copy back removes a stale -wal beside it, as the
// updater's own restore does (§11.4).
function snapshotDb(): string {
  store.db.pragma("wal_checkpoint(TRUNCATE)");
  const copy = join(dir, "morndo.db.old");
  copyFileSync(join(dir, "morndo.db"), copy);
  return copy;
}

function putBack(copy: string): void {
  store.close();
  copyFileSync(copy, join(dir, "morndo.db"));
  for (const side of ["-wal", "-shm"]) rmSync(join(dir, `morndo.db${side}`), { force: true });
}

// The start, as main.ts runs it: a fresh store over whatever morndo.db is now, the services wired with the journal,
// and the journal applied before anything is served.
function open(): void {
  store = new Store(dir);
  access = new AccessService(store, fakePasskeys(), () => now, journal);
  agents = new AgentAccess(store, "manager", () => now, journal);
}

function start(): number {
  open();
  return applyRevocationJournal(journal, { access, agents });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-hub-"));
  journal = new RevocationJournal(join(dir, "revoked.log"));
  now = Date.UTC(2026, 9, 22, 8, 0, 0);
  nextCred = 0;
  open();
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("the hub's revocation journal (RL10)", () => {
  it("revoking a device, or an agent token, appends one journal line", async () => {
    const { result } = await pairDevice();
    if (!("endpoint" in result)) throw new Error("setup");
    access.revoke(result.endpoint.id);
    const { token } = agents.issue("workers", "worker");
    agents.revoke(token.id);
    expect(journal.entries()).toEqual([
      { kind: "endpoint", id: result.endpoint.id, at: now }, { kind: "agent_token", id: token.id, at: now },
    ]);
  });

  it("a store restored from an older copy has the device revoked again by the start's journal apply", async () => {
    const { result } = await pairDevice();
    if (!("cookieSecret" in result)) throw new Error("setup");
    expect(access.authenticate(result.cookieSecret)).not.toBeNull();
    const older = snapshotDb();                              // before the revocation
    expect(access.revoke(result.endpoint.id)).toBe(true);
    expect(access.authenticate(result.cookieSecret)).toBeNull();

    putBack(older);                                          // the restore: the revocation is gone
    open();
    expect(store.endpoint(result.endpoint.id)?.revokedAt).toBeNull();
    expect(access.authenticate(result.cookieSecret)).not.toBeNull();

    expect(start(), "the next start applies the journal").toBe(1);
    expect(store.endpoint(result.endpoint.id)?.revokedAt).toBe(now);
    expect(access.authenticate(result.cookieSecret), "the restored session ended with it").toBeNull();

    expect(start(), "applying twice changes nothing").toBe(0);
    expect(store.endpoint(result.endpoint.id)?.revokedAt).toBe(now);
    const lines = journal.entries().length;
    expect(start()).toBe(0);
    expect(journal.entries()).toHaveLength(lines);
  });

  it("an agent token a restored store forgot is revoked again too", async () => {
    const { token, secret } = agents.issue("workers", "worker");
    const older = snapshotDb();
    expect(agents.revoke(token.id)).toBe(true);

    putBack(older);
    open();
    expect(agents.authenticate(secret, "lane-a")).toMatchObject({ ok: true });   // the restore brought it back
    expect(start()).toBe(1);
    expect(agents.authenticate(secret, "lane-a")).toMatchObject({ ok: false, refused: "revoked" });
  });
});
