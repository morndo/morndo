// Validation of review finding #1 (range b9328b196..d90a1443e, PR #11): "Send again" (#queueAgain) runs before the AC7
// check. AC7 (packages/domain/src/access.ts mayCommand): sending into a worker needs a valid Session whose passkey check
// is fresher than the step-up window; a Session that never verified for Commands (verifiedAt 0, AC12) may not send at
// all. A repeat of a request id may always learn what became of it ("duplicate"), but it must not put new text into the
// manager's inbox from a Session that may not command. Synthetic data only.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import type { Tmux } from "../src/application/ports.ts";
import { SENDER, inboxKey, managerInbox } from "../src/adapters/manager-inbox.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";

const NOW = Date.UTC(2026, 9, 5, 9);
let dir: string, inboxDir: string, store: Store, typed: string[];
const endpoint: Authenticated["endpoint"] = { id: endpointId("ep1"), name: "Phone", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: NOW, revokedAt: null };
const session = (verifiedAt: number): Authenticated => ({
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: NOW - 3_600_000, lastSeenAt: NOW, verifiedAt, endedAt: null, endReason: null },
  endpoint,
});
const FRESH = session(NOW - 1000);                 // a passkey check a second ago
const LAPSED = session(NOW - 11 * 60_000);         // the same Session, its check 11 minutes old (the default window is 10)
const NEVER = session(0);                          // signed in, never verified for Commands (AC12)
const tmux: Pick<Tmux, "send"> = { send: async (_id, text) => { typed.push(text); return { problem: null, typedAt: NOW }; } };
// The strictest step-up choice (10 minutes), set explicitly so the test doesn't hang on the default policy.
const steering = () => new SteeringService(store, tmux, () => NOW, () => ({ stay: "12h", stepUp: "10m" }), null, () => "none", () => null, undefined, null,
  { isManager: id => id === "%0", inbox: managerInbox(inboxDir, () => NOW) });
const inboxed = () => readdirSync(join(inboxDir, "msg")).map(f => JSON.parse(readFileSync(join(inboxDir, "msg", f), "utf8")) as { id: string; text: string });
const givenUp = (id: string, status: "expired" | "cancelled") => {
  mkdirSync(join(inboxDir, "state"), { recursive: true });
  const key = inboxKey(SENDER, id);
  writeFileSync(join(inboxDir, "state", `${key}.json`), JSON.stringify({ v: 1, key, status, attempts: 0, updatedAt: NOW }));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-val-pr11-f01-")); inboxDir = join(dir, "inbox"); store = new Store(dir); typed = [];
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, "deliverer.json"), JSON.stringify({ pid: 1, at: NOW }));   // a deliverer runs
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("finding #1: Send again and the passkey step-up (AC7)", () => {
  for (const [word, stale] of [["lapsed", LAPSED], ["never made", NEVER]] as const) {
    it(`control: a new request from a Session whose passkey check is ${word} is refused step_up`, async () => {
      expect(await steering().send(stale, "%0", "anything", "rid-new")).toEqual({ ok: false, problem: "step_up" });
      expect(readdirSync(inboxDir)).not.toContain("msg");
    });
    for (const status of ["cancelled", "expired"] as const) {
      it(`a repeat after the inbox gave the first up (${status}), passkey check ${word}: nothing new is queued for the manager`, async () => {
        expect(await steering().send(FRESH, "%0", "deploy it", "rid-1")).toEqual({ ok: true, at: NOW, queued: true });
        givenUp("command:ep1:rid-1", status);
        const audited = store.auditOf("CommandSent", 0).length;
        // The repeat carries the request id only; its text is whatever the caller sends now.
        const r = await steering().send(stale, "%0", "text the first message never had", "rid-1");
        expect(inboxed().map(m => m.text)).toEqual(["deploy it"]);
        expect(store.auditOf("CommandSent", 0)).toHaveLength(audited);
        expect(r.ok).toBe(false);
        expect(typed).toEqual([]);
      });
    }
  }
});
