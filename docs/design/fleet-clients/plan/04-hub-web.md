## Lane notes (hub-web: Tasks 11 to 14)

**Reconciled** with `plan/RECONCILIATION.md`: rulings 1, 3, 8, 13, 15, 26, 27, 28, 29 and 39; in the review round 49, 50, 51, 52, 53, 55, 56, 60, 61 and 66; and in the refresh after #29, 81 to 85, which rewrote Tasks 12 and 13 against `main` as it is now, and 88 to 91.

**Order.** Task 11, Task 12, Task 13, Task 14, as listed. Task 14 needs only Step 12.26 (the fake fleet), so it may also run right after that step; its `main.ts` edit quotes only lines Task 12 leaves alone (ruling 85).

**How this part was checked** (the refresh run, 2026-10-10). The base was `feat/fleet-clients` at e56fa70 (`main` 53d7a22 and two docs files) with Tasks 1 to 3 applied as part 01 has them (with its drift: `package.json`'s `check` line names `apps/board-cli`). On a scratch clone of that, every step of this part was applied in order, its test run before its code ("see it fail") and after it ("see it pass"), and every negative control listed was applied and seen to bite. Node 26.3.1 on macOS (the repo's engines say `>=24.12`; CI runs 24); vitest 5.0.3; Playwright 1.63 with its Chromium for the web tests. The blocks in this file were generated from that copy's history, and every "replace … with …" block was checked to apply in order, its old text exactly once, giving the copy's file.

What that means for the executor:
- After Task 14, `npx vitest run` (the fleet drills in `test/fleet` and the Chromium web tests included) gave 297 files and 2231 tests: 2225 passed, 2 skipped, and 4 failed that fail on the base as well, on macOS only: `packages/node-ops/test/pane-lock.test.ts`'s two (macOS has no `flock(1)`) and `main`'s own `process-start.test.ts`'s two (it reads `/proc`). They pass on Linux.
- `npm run check` (svelte-check: 722 files, 0 errors) and `npm run lint` exit 0.
- `npm run build && node e2e/gallery.e2e.ts` passed 5 of 5, and `npm run check:build` passed.
- The run was repeated on a tree built only from this file's text: the same base, then every "Create", "replace … with …" and `git rm` of this file applied in order, and the negative-control entries added. It gave the same files, byte for byte. `node scripts/negative-controls.ts --check` found every entry's text exactly once (the fleet core's `t5-answer-key-*` included, which Step 12.39 updates, ruling 51, and the eight entries next to the code Tasks 12 and 13 change), and every `fc11` to `fc14` entry bit.
- Not run here: the e2e files other than the gallery (`desktop.e2e.ts` and others need TigerVNC or the owner's office), and anything against a real fleet with deliveries (Tasks 4 to 9). `morndo lanes` and the hub's queue run here against the fake fleet; the real-fleet drills of spec §12 (`morndo lanes` against a real fleet, ruling 57) are Task 16's, on the same commands, as are the drills of the hub's queue against a real fleet (part 05, ruling 66).

**Decided here**, each settled by a ruling or said here for the review:
- **An answer given up goes again under a new id** (ruling 26). A delivery id names one delivery for its 7 days (spec §4.1), so the same answer to the same ask after its delivery was given up (expired, or cancelled by the switch) can't reuse its key. Its next delivery is `hub:<key>~2`, then `~3`. Nothing under a given-up id was ever typed, so the direct path's key (`hub:<key>`) stays free on the node, and the switch still never types an answer twice (spec §9.1). Every first delivery is `hub:<key>` exactly.
- **"Uncertain" is not recorded** (ruling 82). E13 records a Decision once it reached the manager; one typed and never seen taken may not have. It stays given (never asked again, never typed again), its card says "May have been delivered", and no `EscalationAnswered` is written.
- **An answer given up says so on its open card** (ruling 82; #29's notice): "Not delivered: the answer never reached the manager. Answer again." The notices are read from the delivery rows, not kept in #29's `pending_answers`, so they survive a restart with nothing more stored; they last as long as the row (7 days; ruling 90). The same request again is refused `not_delivered` (#29's refusal), and answering again is a new request.
- **What #29's inbox left behind** (rulings 82 and 89): a Decision restored with delivery "queued" and no delivery row here may still be typed by kira's inbox, so it reads "May have been delivered" from the first start on and is never asked again. On the owner's PC there is none (#29's inbox was never on there, and part 07's step 1 refuses to run with `MORNDO_MANAGER_INBOX` set); it is the safe default, which never types an answer twice.
- **A message given up reads "Not delivered"** (ruling 26), with why, and only Dismiss: its id is spent (§4.1), so the principal writes it again. While the switch is off, its repeat is typed directly (nothing of it was typed).
- **A message waits up to 24 hours from when it was written** (ruling 83): the send's `createdAt` (kept from #29) gives the delivery's `ttlMs`; a time that can't be right counts from its arrival. **Cancel** is `POST /api/manager/cancel`: it withdraws a message not typed yet, types nothing, and so asks no fresh passkey (AC7 guards what reaches an agent).
- **The answer's rules from ADR-0010 kept here** (ADR-0014 keeps them, ruling 81): queued counts as given (E8); recorded at its delivery's time (E13); given up opens the ask again; a queued answer whose ask was settled, expired or asked again is withdrawn (`delivery.cancel`, ADR-0010 B1 and H2); and, by ruling 27, an answer typed before its withdrawal could stop it is recorded against the ask it answered, and its echo (the first tap line equal to it from its queueing on) is never taken as a tap on the newer ask (ADR-0010 H1).
- **`CommandSent` when the hub queues a message** (ruling 28): at its first attempt the fleet didn't refuse, in doubt included, so a message found queued later is never left unaudited.
- **`morndo lanes` runs before the hub's settings and database** (main.ts, Step 14.4): it needs neither, runs on machines with no hub, and must not fail on a hub setting (`MORNDO_ORIGIN`) or create `~/.local/share/morndo`. It is still the console's `lanes` command.
- **The hub's start line** is `manager queue: on`, or `manager queue: off (MORNDO_MANAGER_QUEUE)`, once (ruling 39).
- **The fleet drills' hub follows what ships** (ruling 66; `test/fleet-harness.ts`, Step 12.54): the queue is on, unless a drill says `startHub(fleet, { managerQueue: false })`. `drills-retry` and `duplicate-names` say so: they drill the hub's keyed `pane.send` and its done keys, which the hub still uses with the switch off (step 2's rollback) and for every other lane.
- **`val-b12-e2e-listed.test.ts` stays.** #29 added it with its inbox tests, but it checks that every e2e file runs in `npm run e2e` and in CI, which holds for every e2e; Step 12.3 removes `inbox.e2e.ts` from both lists, and it passes.

---

### Task 11: Hub: answers to open asks restored whatever their age (issue #20)

**Files:**
- Modify: `apps/hub/src/adapters/store.ts` (`decisions()`)
- Create: `apps/hub/test/escalation-restore-age.test.ts`
- Modify: `scripts/negative-controls.ts` (two entries)

**Interfaces:**
- Consumes: `Store.saveDecision(id, decision)`, `Store.decisions()` (store.ts); `EscalationService`'s constructor, which restores `store.decisions()` (escalation-service.ts:158); `Escalations.restore()` (packages/domain), which applies a restored Decision only to its own ask, sighted again and not asked again since; `menuEscalationId(workerId)` (packages/protocol, `menu-…`).
- Produces: `Store.decisions(menuWindowMs = 7 days): { id: string; decision: unknown }[]`: every row whose id isn't a menu's, whatever its age; a `menu-…` row only within `menuWindowMs`. No caller changes.

**Behaviour:**
- **Why:** a hub start restored only the last 7 days of answers, so a list item answered eight days earlier and still open came back as "Needs your call" at a restart just after the answer turned 7 days old (issue #20).
- **Now:** every Decision is restored whatever its age; `Escalations.restore` keeps it until its ask is sighted, and applies it then (a list item without a message: always; one with a message: when the answer is newer than the ask). An ask closed for good is never sighted again, so its old Decision does nothing.
- **Menus keep the window:** a `menu-N` id names a legacy pane, and a later pane reuses that id, so an old answer must not answer its new menu (fleet core §4: old `menu-N` rows drop out of view).
- **Cost:** the `decisions` table is never pruned (A8). At about 20 answers a day the start loads a few thousand small rows a year, which the restore keeps in memory.

- [ ] **Step 11.1: Write the failing test**

Create `apps/hub/test/escalation-restore-age.test.ts`:

```ts
// Issue #20: a hub restart restores a Decision for every ask still open, whatever its age. Before, Store.decisions()
// loaded only the last 7 days, so a manager's list item answered 8 days ago, still open while the manager works on it,
// came back as "to decide" after a restart (2026-10-08, ny-21). Only a menu on a screen (`menu-…`) keeps the 7-day
// window: a legacy pane id comes back on a later pane, and its old answer must not answer that pane's new menu (fleet
// core §4). Synthetic list, conversation and screens; the decisions rows are dated back in the hub's own database.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId, type Decision } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { EscalationService, type Watch } from "../src/application/escalation-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";

const DAY = 24 * 3_600_000;
const T0 = Date.UTC(2026, 9, 1, 4, 46);
const MENU = "Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel";
let now = T0;
let dir: string;
let store: Store;
let ledgerPath: string;
let sent: { pane: string; text: string }[];
let screens: Record<string, string>;

const auth = (): Authenticated => ({
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: now, lastSeenAt: now, verifiedAt: now, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
});
// The manager (%0) and a worker (%3) whose screen may show a menu: a legacy hub's panes.
const watch: Watch = {
  workers: () => [{ id: "%0", name: "manager" }, { id: "%3", name: "builder" }],
  history: () => [],
  openQuestions: () => [],
  screen: id => screens[id],
};
// A hub start: a new service on the same database, as main.ts builds it.
const start = () => new EscalationService({
  watch, ledger: ledgerReader(ledgerPath, () => now), store, managerName: "manager", now: () => now,
  send: async (pane, text) => { sent.push({ pane, text }); return { problem: null, typedAt: now }; },
});
const item = (s: EscalationService, id: string) => s.board().items.find(i => i.id === id);
// A decisions row dated `days` back on the hub's clock (Store.saveDecision stamps Date.now()).
const age = (id: string, days: number) => store.db.prepare("UPDATE decisions SET at = ? WHERE escalation_id = ?").run(Date.now() - days * DAY, id);

beforeEach(() => {
  now = T0;
  dir = mkdtempSync(join(tmpdir(), "morndo-restore-age-"));
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  sent = [];
  screens = { "%0": "❯ ", "%3": "❯ " };
  // ny-21 is a list item without buttons: the manager keeps it open while it works on the answer.
  writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-21", kind: "tap", question: "Pick the launch date", default: "next Monday" }], needsYouClosed: [] }));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("a restart restores the answers to asks still open, whatever their age (issue #20)", () => {
  it("a list item answered 8 days ago and still open is still answered after a restart; a second answer is refused", async () => {
    const before = start();
    before.poll();
    expect(await before.answer(auth(), "ny-21", { kind: "words", text: "Monday the 12th" }, "r1")).toMatchObject({ ok: true });
    expect(sent).toEqual([{ pane: "%0", text: "About ny-21: Monday the 12th" }]);
    age("ny-21", 8);
    now = T0 + 8 * DAY + 22_000;                          // the hub restarts 22 s after the answer turned 7 days old
    const after = start();
    after.poll();
    expect(item(after, "ny-21")).toMatchObject({ status: "answered", decision: { choice: { kind: "words" }, via: "here" } });
    expect(await after.answer(auth(), "ny-21", { kind: "words", text: "Tuesday instead" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
    expect(sent).toHaveLength(1);
  });

  it("an answer to a menu on a screen 8 days old is not restored: that pane's new menu is a new ask (negative control)", () => {
    const old: Decision = { choice: { kind: "option", key: "1", label: "Yes" }, at: T0, via: "here", endpointId: endpointId("ep1"), sessionId: sessionId("s1") };
    store.saveDecision("menu-3", old);
    age("menu-3", 8);
    now = T0 + 8 * DAY;
    screens["%3"] = MENU;                                 // a later pane %3 shows a menu of its own
    const after = start();
    after.poll();
    expect(item(after, "menu-3")).toMatchObject({ status: "open", decision: null });
  });

  it("an answer to a menu within its 7 days is still restored (the window stays for menus)", () => {
    const recent: Decision = { choice: { kind: "option", key: "1", label: "Yes" }, at: T0, via: "here", endpointId: endpointId("ep1"), sessionId: sessionId("s1") };
    store.saveDecision("menu-3", recent);
    age("menu-3", 6);
    now = T0 + 6 * DAY;
    screens["%3"] = MENU;
    const after = start();
    after.poll();
    expect(item(after, "menu-3")).toMatchObject({ status: "answered", decision: { choice: { key: "1" } } });
  });
});
```

- [ ] **Step 11.2: Run it and see it fail**

Run: `npx vitest run apps/hub/test/escalation-restore-age.test.ts`
Expected: FAIL, 1 of 3: "a list item answered 8 days ago and still open is still answered after a restart; a second answer is refused" with `AssertionError: expected { id: 'ny-21', asker: { …(3) }, …(29) } to match object { status: 'answered', …(1) }` (received `"decision": null, "status": "open"`). The two menu tests pass: the window is there today.

- [ ] **Step 11.3: Restore every answer, and keep the window for menus only**

In `apps/hub/src/adapters/store.ts`, replace:

```ts
  decisions(sinceMs = 7 * 24 * 3_600_000): { id: string; decision: unknown }[] {
    return (this.db.prepare("SELECT escalation_id, body FROM decisions WHERE at >= ?").all(Date.now() - sinceMs) as Row[])
      .map(r => ({ id: r.escalation_id as string, decision: JSON.parse(r.body as string) as unknown }));
  }
```

with:

```ts
  // The Decisions a hub start restores (E8): every one whatever its age, since an ask can stay open far longer than a
  // week (the manager's list keeps an answered item open while it works on it; issue #20). The domain applies one only
  // to its own ask, sighted again and not asked again since (Escalations.restore). A menu on a screen (`menu-…`,
  // menuEscalationId) keeps the 7-day window: its id names a pane, and a legacy pane id comes back on a later pane, whose
  // new menu an old answer must not answer (fleet core §4: old `menu-N` rows drop out of view). SQLite's substr, not
  // LIKE, whose `_` would match any character.
  decisions(menuWindowMs = 7 * 24 * 3_600_000): { id: string; decision: unknown }[] {
    return (this.db.prepare("SELECT escalation_id, body FROM decisions WHERE substr(escalation_id, 1, 5) <> 'menu-' OR at >= ?").all(Date.now() - menuWindowMs) as Row[])
      .map(r => ({ id: r.escalation_id as string, decision: JSON.parse(r.body as string) as unknown }));
  }
```

- [ ] **Step 11.4: Run it and see it pass, with the escalation suites**

Run: `npx vitest run apps/hub/test/escalation-restore-age.test.ts apps/hub/test/escalation-window.test.ts apps/hub/test/escalation-service.test.ts apps/hub/test/escalation-menu-ids.test.ts`
Expected: PASS, 4 files, 34 tests.

Run: `npx vitest run apps/hub packages/domain`
Expected: PASS, every test (on Tasks 1–3 plus this task, at e56fa70 on 2026-10-09: 125 files, 974 tests).

- [ ] **Step 11.5: Commit, then the negative controls**

```bash
git add apps/hub/src/adapters/store.ts apps/hub/test/escalation-restore-age.test.ts
```

```bash
git commit -m "fix(hub): restore the answers to open asks whatever their age; menus keep the 7-day window (#20)"
```

Add to `scripts/negative-controls.ts`, at the end of `CONTROLS`:

```ts
  // ---- fleet-clients Task 11: answers restored whatever their age (issue #20; plan/04-hub-web.md)
  { id: "fc11-decisions-plain-window", task: "fc11", file: "apps/hub/src/adapters/store.ts",
    find: "WHERE substr(escalation_id, 1, 5) <> 'menu-' OR at >= ?", replace: "WHERE at >= ?",
    run: ["apps/hub/test/escalation-restore-age.test.ts"], expect: "expected { id: 'ny-21'" },
  { id: "fc11-decisions-no-menu-window", task: "fc11", file: "apps/hub/src/adapters/store.ts",
    find: "WHERE substr(escalation_id, 1, 5) <> 'menu-' OR at >= ?", replace: "WHERE at >= ? OR 1",
    run: ["apps/hub/test/escalation-restore-age.test.ts"], expect: "to match object { status: 'open', decision: null }" },
```

Then:

Run: `node scripts/negative-controls.ts --only fc11-decisions-plain-window --only fc11-decisions-no-menu-window`
Expected: `bit` for both (seen in the scratch copy: the first fails "a list item answered 8 days ago …" with `expected { id: 'ny-21', … } to match object { status: 'answered', … }`; the second fails the menu test with the old Decision applied).

```bash
git add scripts/negative-controls.ts
```

```bash
git commit -m "test: negative controls for restoring answers whatever their age (#20)"
```

Task 11 depends on nothing else here: it may go to `main` on its own branch first (plan.md, Lanes and order), so the rollout's first hub restart already keeps old answers.

---

### Task 12: Hub: the manager's answers and commands through the fleet's queue, the only queue

**Why this task removes code first.** PR #29 put the manager's answers and messages on `main` through kira's inbox on disk (ADR-0010 rebuilt; `MORNDO_MANAGER_INBOX`). The owner decided that the fleet's delivery queue is the only queue (ruling 81). So this task:
- takes #29's inbox out first (Steps 12.1 to 12.5), and the hub types to the manager directly again, as before #29;
- then builds the queue on what #29 put there and the plan keeps: the domain's `queue`, `delivered`, `withdraw`, `sameDecision` and `answered` (with `uncertain` added), the store's `replaceDecisionIf` and `dropDecisionIf`, the cards' delivery line, the notices, the `not_delivered` refusal and the send's `createdAt` (rulings 81 to 85);
- ports #29's review cases that the plan's tests didn't cover (B3, B5, B7, B8, B9, B10 and the notices) to the queue, in the steps that build what they guard;
- leaves migration 15's `pending_answers` in place, unused: dropping a table would be a migration of its own, and nothing needs it (ruling 81). The queue's table is migration 16 (ruling 84).

**Files:**
- Delete: `apps/hub/src/adapters/manager-inbox.ts`; #29's inbox tests: `apps/hub/test/config-manager-inbox.test.ts`, `escalation-inbox.test.ts`, `steering-inbox.test.ts`, `val-b1-queued-answer-reasked.test.ts`, `val-b2-inbox-message-gone.test.ts`, `val-b3-stale-queued-overwrites.test.ts`, `val-b4-command-inbox-outcome.test.ts`, `val-b5-restored-stale-queued.test.ts`, `val-b6-restart-without-inbox.test.ts`, `val-b7-second-queued-answer.test.ts`, `val-b8-decision-extra-fields.test.ts`, `val-b9-inbox-empty-text.test.ts`, `val-b10-manager-not-listed.test.ts`, `val-inbox-review29.test.ts`, `val-inbox-v2-decisions.test.ts`; `e2e/inbox.e2e.ts`
- Modify (Step 12.3, the inbox out): `docs/adr/0010-manager-inbox.md` (a status line under its Status: superseded by ADR-0014), `.github/workflows/ci.yml` and `package.json` (the inbox e2e), `apps/hub/src/config.ts`, `apps/hub/src/main.ts`, `apps/hub/src/adapters/http.ts`, `apps/hub/src/adapters/store.ts`, `apps/hub/src/application/escalation-service.ts`, `apps/hub/src/application/steering-service.ts`, `packages/protocol/src/feed.ts` and `packages/protocol/src/http.ts`, `apps/web/src/lib/desktop/decisions.ts` and `apps/web/src/lib/gallery/data.ts` (the feed's `inbox` field), and the eight hub tests whose `Config` literal names `managerInbox`
- Modify: `packages/domain/src/escalation.ts` (`uncertain`) and `docs/domain.md` (E13, the paragraph under it, `Send state` and S5: queue, not inbox; ruling 87)
- Modify: `packages/protocol/src/feed.ts` (a Decision's `delivery` with `uncertain`, `waiting`; `QueuedCommandSchema`; the `deliveries` frame), `packages/protocol/src/http.ts` (`CancelBody`) and `apps/web/src/lib/feed.svelte.ts` (the frame kept, so the app's switch stays exhaustive)
- Modify: `apps/hub/src/adapters/migrations.ts` (migration 16), `apps/hub/src/adapters/store.ts` (`manager_deliveries` rows) and `apps/hub/test/migrations.test.ts` (migration 15's test runs to 15 only)
- Modify: `apps/hub/src/config.ts` (`managerQueue`)
- Modify: `apps/hub/test/helpers/fake-fleet.ts` (deliveries as ruling 3 answers them, sticky names, `pane.capture`, keys by name, each session's topic and last prompt, lane events), and the two tests its session default changes (ruling 53): `apps/hub/test/fleet-adapters.test.ts`, `packages/fleet-client/test/fleet-client.test.ts`
- Modify: `apps/hub/src/application/ports.ts` (`Deliveries`, `DeliverAnswer`, `CancelAnswer`)
- Create: `apps/hub/src/adapters/fleet-deliveries.ts`, `apps/hub/src/application/manager-queue.ts`
- Modify: `apps/hub/src/application/escalation-service.ts`, `apps/hub/src/application/steering-service.ts`
- Modify: `apps/hub/src/adapters/http.ts` (the `deliveries` frame; a duplicate's `delivery`; `POST /api/manager/cancel`), `apps/hub/src/main.ts` (wiring), `apps/hub/test/inprocess-hub.ts` (`queue`)
- Modify: `test/fleet-harness.ts` (`startHub`'s `managerQueue: false`; the queue stays on by default, as it ships, ruling 66), `test/fleet/drills-retry.test.ts` and `test/fleet/duplicate-names.test.ts` (they turn it off: they drill the direct path)
- Create (tests): `apps/hub/test/no-manager-inbox.test.ts`, `packages/domain/test/escalation-delivery.test.ts`, `packages/protocol/test/feed-deliveries.test.ts`, `apps/hub/test/manager-deliveries-store.test.ts`, `apps/hub/test/config-manager-queue.test.ts`, `apps/hub/test/fleet-deliveries.test.ts`, `apps/hub/test/manager-queue.test.ts`, `apps/hub/test/escalation-queue.test.ts`, `apps/hub/test/steering-queue.test.ts`, `apps/hub/test/http-manager-queue.test.ts`, `apps/hub/test/manager-queue-main.test.ts`
- Modify: `scripts/negative-controls.ts` (the fleet core's `t5-answer-key-random` and `t5-answer-key-without-ask`, which Step 12.39 would leave found twice, ruling 51; this task's entries)

**Interfaces:**
- Consumes (plan.md Contracts):
  - **Task 1 (`@morndo/protocol`):** `Delivery`, `DeliveryState`, `WaitingReason` (with `unavailable`, ruling 15), `GiveUpReason`, `ErrorCode` with `id_conflict`, `no_session`, `already_typed`, `ERROR_EXECUTED`, `LIMITS.maxDeliveryId`, `LIMITS.deliveryTtlMs`, `LIMITS.maxSendText`, `LaneEvent`, `SessionStatus`, `Pane.status`, `Pane.pid`, `Pane.topic`, `Pane.lastPrompt` (ruling 13).
  - **Task 2 (`@morndo/node-ops`):** `SessionInfo.status` (fake-fleet.ts only).
  - **Task 3 (`@morndo/fleet-client`):** `FleetClient.deliver` (with `ttlMs`), `delivery`, `cancelDelivery` (`Delivery | null`: `null` for an id the fleet doesn't know, ruling 56), `events` (`t: "delivery"`, body `Delivery & { stale }`), `caps()` with `stickyLanes`; `FleetOpFailed`, `FleetUnavailable` (`reached`: whether the request left this process, ruling 49), `FleetMismatch`.
  - **Client API routes** (ruling 3): `POST /v1/deliveries` and `POST /v1/deliveries/<id>/cancel` (a refusal is 200 `{ ok: false, error }`), `GET /v1/deliveries/<id>` (an unknown id is 404 `{ error: "no_such_delivery" }`), `GET /v1/deliveries?lane=&state=` (the newest 1000 of the last 7 days), `GET /v1/caps` (`{ api, stickyLanes }`, ruling 8).
  - **Config:** `MORNDO_MANAGER_QUEUE` ("off" or "0" turn it off; on by default when `MORNDO_FLEET_SOCKET` is set); the only switch: `MORNDO_MANAGER_INBOX` is gone (ruling 81).
  - **Databases:** hub `morndo.db` migration 16 (ruling 84), `manager_deliveries` with exactly the Contract's columns, `NORMAL` like the hub's other tables.
  - **#29, on main and kept:** `Escalations.queue(id, choice: Choice, by, now)`, `delivered(id, expected, at)`, `withdraw(id, expected)` (each also acting on a Decision restored and not sighted yet), `sameDecision`, `answered`, `Decision.delivery`; `Store.replaceDecisionIf`, `dropDecisionIf`; `DecisionItem.notice`; the answer refusal `not_delivered` (409); `SendBody.createdAt`; the cards' `deliveryLine`.
  - The hub's own: `answerKey`, `askPrefix` (escalation-service.ts), the send key `${endpoint}:${request}` (steering-service.ts), `hubKey` (`hub:<key>`, fleet-adapters.ts), `Store.send`, `managerOf`.
- Produces:
  ```ts
  // packages/domain/src/escalation.ts (#29's, with uncertain)
  export type Delivery = { state: "queued" | "delivered" | "uncertain"; at: number | null };
  Escalations.uncertain(id, expected: Decision): boolean;
  // packages/protocol/src/feed.ts
  DecisionItem = Escalation & { answerable; version; notice?: string | null; waiting?: string };   // #29's `inbox` goes
  export const QueuedCommandSchema; export type QueuedCommand = { requestId: string; state: "queued" | "delivered" | "uncertain" | "given_up"; waiting: string | null; why: string | null };
  ServerFeedFrames.deliveries: { t: "deliveries"; items: QueuedCommand[] }
  // packages/protocol/src/http.ts
  export const CancelBody: { requestId };   // SendBody keeps createdAt; #29's `retry` goes
  // apps/hub/src/adapters/store.ts (migration 16)
  export type ManagerDeliveryState = "sending" | DeliveryState;
  export type ManagerDeliveryRow = { deliveryId; kind: "answer" | "command"; escalationId; ask; choice; endpointId; sessionId; requestId; queuedAt; state: ManagerDeliveryState; updatedAt };
  Store.saveManagerDelivery(row), managerDelivery(id), managerDeliveryOfRequest(endpointId, requestId), answerDelivery(escalationId, queuedAt),
    managerDeliveryAttempts(base), managerDeliveriesWithPrefix(prefix), openManagerDeliveries(), commandDeliveriesOf(endpointId, since),
    setManagerDeliveryState(id, state, at), dropManagerDelivery(id), pruneManagerDeliveries(before);   // #29's pending-answer helpers go
  // apps/hub/src/config.ts
  Config.managerQueue?: boolean;   // Config.managerInbox goes
  // apps/hub/src/application/ports.ts
  export type DeliverAnswer = { ok: true; delivery: Delivery } | { ok: false; refused: ErrorCode } | { ok: false; inDoubt: true };
  export type CancelAnswer = DeliverAnswer | { ok: false; unknown: true };   // unknown: cancelDelivery's null (ruling 56)
  export type Deliveries = { deliver(d: { id; lane; text; ttlMs? }): Promise<DeliverAnswer>; cancel(id): Promise<CancelAnswer>;
    get(id): Promise<Delivery | null | "unavailable">; subscribe(on, onOpen): () => void; stickyLanes(): Promise<string[] | null> };
  // apps/hub/src/adapters/fleet-deliveries.ts
  export function fleetDeliveries(client: FleetClient): Deliveries;  export const isDelivery;
  // apps/hub/src/application/manager-queue.ts
  export class ManagerQueue { constructor(p: { store; deliveries: Deliveries; lane: string; on: boolean; now?; pollMs? });
    readonly lane; readonly on; subscribe(fn: (c: QueueChange) => void); idFor(key): string; put(d: NewDelivery, text, ttlMs?): Promise<PutResult>;
    view(id): QueueView | null; row(id); byRequest(endpointId, requestId); answerRow(escalationId, queuedAt); sendingOf(prefix); openAnswers(); answersTo(escalationId);
    commandsOf(endpointId): QueuedCommand[]; forget(id); cancel(id): Promise<CancelResult>; poll(): Promise<void>; start(): Promise<void>; stop() }
  export type QueueView = { state: DeliveryState; reason: WaitingReason | null; why: GiveUpReason | null; at: number | null };
  export type CancelResult = { ok: true; view: QueueView } | { ok: false; problem: ErrorCode | "unknown" };
  export type QueueChange; export type NewDelivery; export type PutResult; export function viewOf(d); export function queuedCommand(row, view): QueuedCommand;
  // apps/hub/src/application/escalation-service.ts
  constructor's p: `inbox` goes, `queue?: ManagerQueue | null` comes;  EscalationView = Escalation & { answerable; version; waiting?: string; notice?: string }
  // apps/hub/src/application/steering-service.ts
  constructor(store, tmux, now, policy, inbox, waitingOn, nameOf, uploads, status, manager: { queue: ManagerQueue; isManager(workerId): boolean } | null = null)
  send(a, workerId, text, requestId, uploads?, seen?, name?, createdAt?): Promise<SendResult>;   // #29's `retry` goes; withdrawOverdue() goes
  SendResult's ok and "duplicate" gain delivery?: QueuedCommand (#29's queued, inbox, reason and "not_delivered" go)
  cancel(a, requestId): Promise<MessageCancel>;  export type MessageCancel = { ok: true; delivery: QueuedCommand } | { ok: false; problem: ErrorCode | "unknown" };
  export function cleanText(s: string): string;   // moved here from #29's manager-inbox.ts
  // apps/hub/src/adapters/http.ts
  startHttp's p gains queue?: ManagerQueue | null;  POST /api/manager/cancel { requestId } → 200 { ok: true, delivery } | 409 { error } | 404 { error: "unknown" }
  // apps/hub/test/helpers/fake-fleet.ts
  startFakeFleet's o gains stickyLanes?: string[] (default ["manager"]);  FakeFleet gains deliveries, deliveryCalls, cancels, moveDelivery,
    quietDeliveries, loseDeliveryAnswers, laneEvent;  MemoryPane gains status?, pid?, topic?, lastPrompt?;  MemoryBackend gains keyNamesTyped;  NodeBackend gains keyNames?, topicOf?
  // apps/hub/test/inprocess-hub.ts
  startInProcessHub's o gains queue?: (store: Store) => ManagerQueue
  // test/fleet-harness.ts
  startHub's o gains managerQueue?: boolean   // false: MORNDO_MANAGER_QUEUE=off; absent: as it ships (on with a fleet)
  ```

**Behaviour, in one place:**
- **One queue** (ruling 81). The hub has no inbox on disk and no `MORNDO_MANAGER_INBOX`: nothing in the hub writes kira's spool or reads that setting (Step 12.1's test guards both). An answer or a message to the manager goes through the fleet's delivery queue, or, with the switch off or without a fleet, is typed directly.
- **When.** With a fleet and `MORNDO_MANAGER_QUEUE` not "off" or "0", an answer whose asker is the manager, and a message to the manager's pane (`managerOf`, the pane the roster names for the manager's window now: #29's B10), go through the fleet's delivery queue to the lane named `MORNDO_MANAGER_WINDOW`. Messages to other lanes stay typed directly (`pane.send`). Without a fleet nothing changes (legacy mode).
- **Ids.** An answer's delivery id is `hub:` and its answer key, `hub:answer:<escalation>:<ask>:<choice>`; a message's is `hub:<endpoint>:<request>`. These are the keys the fleet adapters type under today (`hubKey`), so a direct send after the switch finds the delivery's key on the node: `done` is a duplicate, `started` is in doubt, and nothing is typed twice (spec §9.1). Only after a given-up delivery does an answer go again under `~2`, `~3` (Decided here).
- **The row first.** Each delivery's `manager_deliveries` row is written ("sending") before the fleet is asked, so a hub that stops then still follows it. The fleet's answer gives it its state.
  - Refused (executed "no", or the fleet never reached: `node_offline`, spec §10): nothing was queued, and a row this call wrote goes.
  - No answer (the fleet took it and never answered): the row stays "sending", unless the fleet's own `delivery` event said meanwhile that it is queued. The answer or message is "uncertain" (409), and its repeat asks again under the same id, which the fleet answers with its state and never queues twice (spec §4.1). Another answer to the same ask is refused `answer_in_doubt` meanwhile (E8).
- **Following.** The queue hears the fleet's `delivery` events, and asks about every delivery not final every 5 s and on each events reconnect (an event sent while the hub wasn't subscribed is not replayed). A word older than one applied never moves a delivery back.
  - Each change of state, or of the reason it waits, is heard once by its listeners, in one transaction with the row's new state: a change acted on (an answer recorded, an ask opened again) is acted on once across restarts.
  - A listener that throws rolls the row back, and the next round hears it again.
- **An answer's states** (E13; ADR-0014 keeps ADR-0010's domain rules):
  - queued, typed or held: the Decision counts as given (E8: a second answer is refused), its card says "Queued, it will be delivered" with why it waits (`waiting`: the queue's reason, or "typed", "held"), and nothing is recorded;
  - delivered: `EscalationAnswered` is recorded once, at the delivery's `deliveredAt` (the manager's machine's clock), with the row's own provenance (A1) and, for words, their length and digest (E9). An answer whose ask was asked again since is still recorded (the manager has it), and the newer ask's Decision and its stored row are left alone (#29's B3, B7);
  - uncertain (typed, never seen taken): the card says "May have been delivered"; it stays given, is never opened again and never typed again; it is not recorded (ruling 82);
  - given up (never typed: expired, cancelled, its lane gone): it reached no one, so the ask opens again, and its card says "Not delivered: the answer never reached the manager. Answer again." (#29's notice). The same request again is refused `not_delivered`; answering again is a new request, and the same choice goes again under `~2` (ruling 82).
  - A queued answer whose ask was settled, expired or asked again meanwhile is withdrawn (`delivery.cancel`, once); one typed already is followed to its end.
  - One typed for an ask asked again since answers the ask it was given for, and is recorded against it, never the new one (ruling 27, ADR-0010 H1). Its echo in the manager's conversation (the first principal message equal to its tap line, from its queueing on, less 5 s for the clocks) is never read as a tap on the newer ask; a later tap with the same line is a new answer. An answer in words has no tap line, so no echo to skip. Delivered after the ask was asked anew, the open card says "This reached the manager late, as an answer to the earlier version of the question." (#29's other notice).
  - The notices come from the delivery rows, so a restart still shows them; each goes once he answers again or the ask closes, and never shows on an ask asked anew after the delivery.
- **A message's states** reach the app as the send's answer (`{ ok: true, at, delivery }`; a repeat's 200 `duplicate` carries `delivery` too) and then as `deliveries` feed frames: every one of this device's messages to the manager of the last day after each hello, then each change; never another device's. The `at` is when it was queued, or typed, or delivered, on the manager's machine's clock, which the echo is matched on. `CommandSent` is recorded when the hub queues it (ruling 28): once, at its first attempt the fleet didn't refuse, in doubt included; the delivery's outcome is its row's and the fleet's audit (§8).
- **A message waits up to 24 hours** from when he wrote it (ruling 83): the delivery's `ttlMs` is 24 hours less the time since the send's `createdAt` (the device's clock), or the fleet's own 24 hours from its arrival when that time can't be right (ahead of the hub's clock, or more than a day old). Its card shows why it waits. No two-minute deadline and no Retry (#29's go).
- **Cancel** (rulings 83 and 88): `POST /api/manager/cancel { requestId }` withdraws one of this device's messages to the manager that the fleet hasn't typed yet: 200 with its delivery (given up, `cancelled`), 409 `already_typed` once typed, 404 `unknown` for no such message of this device's (another device's included). A message given up already answers its delivery again. It types nothing, so it asks no fresh passkey.
- **Restarts.** The queue follows every row not final at start. The answers' Decisions come back from `decisions` (Task 11's restore) with their delivery state and only their own fields (#29's B8), and a delivery that moved meanwhile moves them then, a Decision restored and not sighted yet included (#29's B5).
- **What #29's inbox left behind.** A Decision restored with delivery "queued" and no delivery row here was queued in kira's inbox, which may still type it: it reads "May have been delivered" from the first start on, is never asked again, and the hub never types it (ruling 82). On the owner's PC this can't happen (ruling 89): #29's inbox was never switched on there (`MORNDO_MANAGER_INBOX` unset, `pending_answers` empty on 2026-10-09), and part 07's step 1 refuses to run while that variable is set; it is the safe default for any other hub.
- **Text that is empty once control characters go** (an `ESC`, a `NUL`) is refused `empty`, answer or message, and nothing is queued (#29's B9; `cleanText`, moved from #29's adapter to steering-service.ts).
- **In doubt is never typed by hand** (ruling 49). A delivery whose answer never came keeps its row "sending" and is asked again only under its own id. While the switch is off, its repeat is "uncertain" (an answer's or a message's), and another answer to the same ask is refused `answer_in_doubt` (E8): the hub never types one directly while it may be queued.
- **The switch off** (step 2's rollback, spec §13): at start, every delivery still queued (its row "queued" or "sending") is cancelled first, before any answer is taken; one refused `already_typed` is followed to its end, as is everything else not final. A row still "sending" whose delivery the fleet doesn't know (its cancel answers `null`, the route's 404 `no_such_delivery`: rulings 3 and 56) was never queued, and goes. New answers and messages are typed directly. A message given up while the switch is off is typed directly on its repeat.
- **A manager mid-restart** is no refusal: its sticky name waits on its node (spec §4.6). The answer goes to the lane by name even while the hub sees no manager pane. A message names a pane: with the manager's window gone from the roster, it is `no_pane`, and nothing is queued (#29's B10).
- **Review Focus 5:** when the queue is on and `GET /v1/caps`'s `stickyLanes` doesn't name the manager's window, the hub says so once in its log at start, and still delivers. A fleet that can't be asked then says nothing; an older fleet without `stickyLanes` reads as `[]` (ruling 8), so the hub says it too.
- **The start line** (ruling 39): `manager queue: on`, or `manager queue: off (MORNDO_MANAGER_QUEUE)`, once, after the queue has started (and, off, cancelled what was still queued).
- Final rows are pruned after 7 days (as the node keeps its final deliveries, spec §4.3), at each start.

- [ ] **Step 12.1: Write the failing test: the inbox is gone, and ADR-0010 says so**

Create `apps/hub/test/no-manager-inbox.test.ts`:

```ts
// The fleet's delivery queue is the only queue for the manager's answers and messages (fleet-clients §9.1; plan
// reconciliation ruling 81). PR #29's manager inbox (kira's spool, MORNDO_MANAGER_INBOX) is gone from the hub: no adapter
// writes the spool, and no setting turns it on, so nothing the hub does can type into the manager a second way. ADR-0010,
// which put it there, says it is superseded, and keeps its status as it was.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const SRC = join(import.meta.dirname, "../src");
const ADR_0010 = join(import.meta.dirname, "../../../docs/adr/0010-manager-inbox.md");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
// What only a writer of the spool names: its setting, its adapter, and the files of its on-disk contract.
const SPOOL = /MORNDO_MANAGER_INBOX|manager-inbox\.ts|deliverer\.json|ctl\/\$\{|"msg"|kira\/inbox/;

describe("the manager's inbox is gone from the hub (ruling 81)", () => {
  it("no hub source writes kira's spool or reads its setting", () => {
    expect(existsSync(join(SRC, "adapters/manager-inbox.ts"))).toBe(false);
    const found = files(SRC).flatMap(f => readFileSync(f, "utf8").split("\n").flatMap((l, i) => (SPOOL.test(l) ? [`${relative(SRC, f)}:${i + 1}: ${l.trim()}`] : [])));
    expect(found).toEqual([]);
  });

  it("MORNDO_MANAGER_INBOX set is ignored: the settings have no inbox", () => {
    const config = loadConfig({ MORNDO_ORIGIN: "https://hub.example.test", MORNDO_HOME: "/tmp/morndo-unused", MORNDO_MANAGER_INBOX: "/home/x/kira/inbox" });
    expect(Object.keys(config).filter(k => /inbox/i.test(k) && k !== "inboxDir")).toEqual([]);
    expect(JSON.stringify(config)).not.toContain("kira");
  });

  it("ADR-0010 says it is superseded by ADR-0014, under its status as it was", () => {
    const adr = readFileSync(ADR_0010, "utf8");
    expect(adr).toMatch(/^- \*\*Status:\*\* Accepted, 2026-10-04\. /m);
    expect(adr).toContain("- **Superseded** by ADR-0014 (fleet clients, §9.1): the manager's answers and messages go through the fleet's delivery queue.");
  });
});
```

- [ ] **Step 12.2: Run it and see it fail**

Run: `npx vitest run apps/hub/test/no-manager-inbox.test.ts`
Expected: FAIL, 3 of 3: `AssertionError: expected true to be false` (`manager-inbox.ts` is still there), `AssertionError: expected [ 'managerInbox' ] to deeply equal []`, and `AssertionError: expected '# ADR-0010: Answers and messages for …' to contain '- **Superseded** by ADR-0014 (fleet c…'`.

- [ ] **Step 12.3: Take #29's manager inbox out**

What goes, and why (ruling 81: the fleet's queue is the only queue; ruling 83: no two-minute deadline, no Retry):
- the adapter `manager-inbox.ts` (kira's spool on disk) and its switch `MORNDO_MANAGER_INBOX` (`Config.managerInbox`, the help text);
- the inbox branches of the escalation and steering services: the queued answers and their `pending_answers` rows, the inbox's echoes, notices and readers, `#deliveries`, the commands' two-minute deadline, `withdrawOverdue` and its interval in `main.ts`, and the send's `retry` (`SendBody.retry`);
- the store's helpers for them: `savePending`, `pendingAnswers`, `dropPending`, `finishQueued`, `queuedCommands`, `recoverQueuedAnswers`, and the send row's `outcome` (nothing reads it now). `replaceDecisionIf` and `dropDecisionIf` stay: Step 12.39 uses them;
- the feed's `inbox` field on a decision (`InboxWait`) and the cards' inbox reasons (`INBOX_WAITS`); the queue's reasons come back in Step 12.13 (the feed's `waiting`) and Task 13 (their words);
- `e2e/inbox.e2e.ts` and its CI step and `npm run e2e` entry (`val-b12-e2e-listed.test.ts` checks each e2e file is in both, so all three go together);
- #29's fifteen inbox tests. Their cases that the plan's tests don't cover come back on the queue: B3, B5, B7, B8 and the notices in Step 12.37, B9 and B10 in Steps 12.37 and 12.42.

What stays: `cleanText` (moved into steering-service.ts, as both services refuse empty text with it), the restore's stripping of the two fields #29 kept on a stored Decision (B8: a row written by #29's hub still carries them), the domain's functions, `notice` on `DecisionItem`, `not_delivered`, `SendBody.createdAt`, and migration 15's table.

Remove the files:

```bash
git rm apps/hub/src/adapters/manager-inbox.ts e2e/inbox.e2e.ts apps/hub/test/config-manager-inbox.test.ts apps/hub/test/escalation-inbox.test.ts apps/hub/test/steering-inbox.test.ts apps/hub/test/val-b1-queued-answer-reasked.test.ts apps/hub/test/val-b2-inbox-message-gone.test.ts apps/hub/test/val-b3-stale-queued-overwrites.test.ts apps/hub/test/val-b4-command-inbox-outcome.test.ts apps/hub/test/val-b5-restored-stale-queued.test.ts apps/hub/test/val-b6-restart-without-inbox.test.ts apps/hub/test/val-b7-second-queued-answer.test.ts apps/hub/test/val-b8-decision-extra-fields.test.ts apps/hub/test/val-b9-inbox-empty-text.test.ts apps/hub/test/val-b10-manager-not-listed.test.ts apps/hub/test/val-inbox-review29.test.ts apps/hub/test/val-inbox-v2-decisions.test.ts
```

ADR-0010 gets a status line under its Status, which stays as it was (ruling 81; ADR-0014 supersedes it and keeps its domain rules):

In `docs/adr/0010-manager-inbox.md`, replace:

```md
- **Status:** Accepted, 2026-10-04. The owner asked for it; the manager approved the design; built by lane manager-inbox on `feat/manager-inbox`.
- **Design and incident:** an internal decision record (the inbox and its protocol, outside this tree).
```

with:

```md
- **Status:** Accepted, 2026-10-04. The owner asked for it; the manager approved the design; built by lane manager-inbox on `feat/manager-inbox`.
- **Superseded** by ADR-0014 (fleet clients, §9.1): the manager's answers and messages go through the fleet's delivery queue. The inbox adapter and MORNDO_MANAGER_INBOX were removed (Task 12, 2026-10). The domain rules here stay: an answer counts as given once queued (E8), and is recorded once it reached the manager (E13).
- **Design and incident:** an internal decision record (the inbox and its protocol, outside this tree).
```

The escalation service: the inbox's types, fields, restore and steps go; the direct path stays as it was before #29.

In `apps/hub/src/application/escalation-service.ts` (1 of 20), replace:

```ts
import {
  DEFAULT_POLICY, Escalations, answered, askVersion, escalationId, mayCommand, refusal, sameDecision,
  type AccessPolicy, type AnswerRefusal, type Ask, type Choice, type Decision, type DecidedChoice, type Escalation, type Message, type Sighting,
```

with:

```ts
import {
  DEFAULT_POLICY, Escalations, askVersion, escalationId, mayCommand, refusal,
  type AccessPolicy, type AnswerRefusal, type Ask, type Choice, type Decision, type DecidedChoice, type Escalation, type Message, type Sighting,
```

In `apps/hub/src/application/escalation-service.ts` (2 of 20), replace:

```ts
import { menuIdentity, menuOnScreen, type SendProblem } from "@morndo/node-ops";
import { cleanText, managerInbox, type InboxReason, type InboxState, type InboxStatus, type ManagerInbox } from "../adapters/manager-inbox.ts";
import type { Authenticated } from "./access-service.ts";
import { SendInDoubt, type SendOutcome, type SendRefused } from "./ports.ts";
import { keepInDoubt, settleOutcome, type SendResult } from "./steering-service.ts";
import { log } from "../adapters/log.ts";
```

with:

```ts
import { menuIdentity, menuOnScreen, type SendProblem } from "@morndo/node-ops";
import type { Authenticated } from "./access-service.ts";
import { SendInDoubt, type SendOutcome, type SendRefused } from "./ports.ts";
import { cleanText, keepInDoubt, settleOutcome, type SendResult } from "./steering-service.ts";
import { log } from "../adapters/log.ts";
```

In `apps/hub/src/application/escalation-service.ts` (3 of 20), replace:

```ts

// inbox: while a Decision for the manager waits in its inbox (ADR-0010), where it stands there; null otherwise.
export type InboxView = { status: InboxStatus; reason: InboxReason | null };
// One queued answer, by inbox key. The same shape is what the constructor restores, what a new answer stores, and what
// #giveUp withdraws (review #29.9).
type QueuedAnswer = {
  escalationId: string; decision: Decision; words: { length?: number; digest?: string }; state: InboxView; dir: string | null;
  line?: string; cancel?: boolean; late?: boolean; missed?: boolean; notice?: string; version?: string; unreadableSince?: number; sendKey?: string;
};
// What a pending row stores: the queued answer without the fields only the running hub keeps, plus settledAt once withdrawn.
type RestoredAnswer = Partial<Omit<QueuedAnswer, "escalationId" | "decision" | "words" | "state">> & {
  decision: Decision; words?: QueuedAnswer["words"]; settledAt?: number;
};
export type EscalationView = Escalation & { answerable: AnswerRefusal | null; version: string; inbox: InboxView | null; notice: string | null };
type ButtonMessage = { message: Message; body: string; options: ButtonOption[] };
```

with:

```ts

export type EscalationView = Escalation & { answerable: AnswerRefusal | null; version: string };
type ButtonMessage = { message: Message; body: string; options: ButtonOption[] };
```

In `apps/hub/src/application/escalation-service.ts` (4 of 20), replace:

```ts
// `duplicate`: a repeat of an answer in doubt that its node had typed after all; `at` is when, on that node's clock.
// `queued`: the answer is in the inbox and not typed yet. That is not delivered, and `at` is not the enqueue time.
export type AnswerResult =
  | { ok: true; item: EscalationView | null; duplicate?: true; at?: number; queued?: true }
  | { ok: false; problem: AnswerRefusal | SendProblem | SendRefused | "node_offline" | "lane_conflict" | "step_up" | "in_progress" | "too_long" | "changed" | "uncertain" | "answer_in_doubt" | "not_delivered"; item: EscalationView | null };
```

with:

```ts
// `duplicate`: a repeat of an answer in doubt that its node had typed after all; `at` is when, on that node's clock.
export type AnswerResult =
  | { ok: true; item: EscalationView | null; duplicate?: true; at?: number }
  | { ok: false; problem: AnswerRefusal | SendProblem | SendRefused | "node_offline" | "lane_conflict" | "step_up" | "in_progress" | "too_long" | "changed" | "uncertain" | "answer_in_doubt" | "not_delivered"; item: EscalationView | null };
```

In `apps/hub/src/application/escalation-service.ts` (5 of 20), replace:

```ts
const SETTLED_LEDGER_MS = 3 * 24 * 3_600_000;        // closed list items shown under "Decided" for three days
const ECHO_KEEP_MS = 24 * 3_600_000;                  // how long a withdrawn answer's echo is ignored (B1)
const UNREADABLE_GIVE_UP_MS = 15 * 60_000;            // an inbox that can't be read this long counts as gone (H3)
const LATE_ANSWER = "This reached the manager late, as an answer to the earlier version of the question.";
const MISSED_ANSWER = "The answer did not reach the manager. Answer again.";
const TYPED = new Set<InboxStatus>(["typing", "sent", "stuck", "accepted"]);

```

with:

```ts
const SETTLED_LEDGER_MS = 3 * 24 * 3_600_000;        // closed list items shown under "Decided" for three days

```

In `apps/hub/src/application/escalation-service.ts` (6 of 20), replace:

```ts
  #timer: NodeJS.Timeout | null = null;
  // Decisions handed to the manager's inbox and not delivered yet, by escalation id: the inbox key, the Decision as
  // queued (recorded with its provenance once delivered, even if the ask was asked again meanwhile), the words' length
  // and hash for the record, and the inbox's latest word on it.
  #inbox: ManagerInbox | null;
  // By inbox key (code review B7): two answers to one ask, the ask asked again between them, are two messages, each
  // recorded once it arrives. The store keeps the same, one pending_answers row per message.
  // dir: the inbox the message went to; read until it settles there, even when the hub runs without an inbox now (B6).
  // line: what was queued; cancel: withdrawn while still untyped (the ask changed); late: already typed, so it is
  // waited for and, if the ask moved on, recorded as an answer to the earlier version. version: the ask as queued (E12).
  // missed: lost or unconfirmed, so a cancel was asked; Answer again waits until the spool says cancelled (review #29.1).
  // unreadableSince: since then its inbox couldn't be read (H3).
  #queued = new Map<string, QueuedAnswer>();
  // Lines that may still reach the manager after the ask moved on. For 24 hours the first message with that line is
  // not an answer to the new ask (B1, H1). Once that message is known, a later one with the same line is (review #3).
  #echoes = new Map<string, { line: string; after: number; messageId: string | null }[]>();
  // A sentence on an open card: a late delivery, or an answer the inbox lost (decisions 2 and 3). Kept on the settled
  // pending row so a restart still shows it, and cleared when he answers (inbox or typed) or the ask is gone (review #29.8).
  #notices = new Map<string, string>();
  #readers = new Map<string, ManagerInbox>();
  #prunedAt = 0;                                        // settled pending rows are dropped on a coarse timer, not every poll
  static readonly #pruneEveryMs = 60 * 60_000;

```

with:

```ts
  #timer: NodeJS.Timeout | null = null;

```

In `apps/hub/src/application/escalation-service.ts` (7 of 20), replace:

```ts
    settle?: SettleInDoubt;
    inbox?: ManagerInbox | null;
  }) {
    this.#inbox = p.inbox ?? null;
    this.#watch = p.watch;
```

with:

```ts
    settle?: SettleInDoubt;
  }) {
    this.#watch = p.watch;
```

In `apps/hub/src/application/escalation-service.ts` (8 of 20), replace:

```ts
    this.#store = p.store;
    this.#store.recoverQueuedAnswers();
    this.#send = p.send;
```

with:

```ts
    this.#store = p.store;
    this.#send = p.send;
```

In `apps/hub/src/application/escalation-service.ts` (9 of 20), replace:

```ts
    this.#firstSeen = this.#store.askFirstSeen();
    // The stored row may also carry the inbox key and the words' hash: they are the service's, never the Decision's, so
    // they never reach the board (code review B8).
    const saved = this.#store.decisions().map(d => {
      const { inbox, words, ...decision } = d.decision as Decision & { inbox?: string; words?: { length?: number; digest?: string } };
      return { id: d.id, decision: decision as Decision, inbox, words };
    });
    this.#x.restore(saved.map(d => ({ id: escalationId(d.id), decision: d.decision })));
    // Queued before a restart: still waiting in the inbox, one row per message.
    for (const r of this.#store.pendingAnswers()) {
      const b = r.body as RestoredAnswer;
      if (b.settledAt !== undefined) {                 // a withdrawn answer kept for its echo (B1), and its card's notice
        if (this.#now() - b.settledAt > ECHO_KEEP_MS) this.#store.dropPending(r.key);
        else {
          if (b.line) this.#echo(r.escalationId, b.line, b.decision.at);
          if (typeof b.notice === "string") this.#notices.set(r.escalationId, b.notice);
        }
        continue;
      }
      this.#queued.set(r.key, this.#open({ escalationId: r.escalationId, decision: b.decision, dir: b.dir ?? null,
        ...(b.words !== undefined ? { words: b.words } : {}), ...(b.line !== undefined ? { line: b.line } : {}),
        ...(b.cancel ? { cancel: true } : {}), ...(b.late ? { late: true } : {}), ...(b.missed ? { missed: true } : {}),
        ...(b.version !== undefined ? { version: b.version } : {}), ...(b.sendKey !== undefined ? { sendKey: b.sendKey } : {}) }));
      if (b.cancel && b.line) this.#echo(r.escalationId, b.line, b.decision.at);
    }
    for (const d of saved) {                             // a row from before pending_answers: moved there
      if (d.decision.delivery?.state === "queued" && typeof d.inbox === "string" && !this.#queued.has(d.inbox)) {
        const dir = this.#inbox?.dir ?? null;
        this.#store.savePending(d.inbox, d.id, { decision: d.decision, words: d.words ?? {}, ...(dir ? { dir } : {}) });
        this.#queued.set(d.inbox, this.#open({ escalationId: d.id, decision: d.decision, dir, ...(d.words !== undefined ? { words: d.words } : {}) }));
      }
    }
  }
```

with:

```ts
    this.#firstSeen = this.#store.askFirstSeen();
    // A row kept by the manager's inbox (PR #29, removed) may also carry its key and the words' hash: they were the
    // service's, never the Decision's, so they never reach the board (code review B8).
    const saved = this.#store.decisions().map(d => {
      const { inbox: _key, words: _words, ...decision } = d.decision as Decision & { inbox?: string; words?: unknown };
      return { id: d.id, decision: decision as Decision };
    });
    this.#x.restore(saved.map(d => ({ id: escalationId(d.id), decision: d.decision })));
  }
```

In `apps/hub/src/application/escalation-service.ts` (10 of 20), replace:

```ts
    return {
      items: this.#x.list().map(e => ({ ...e, answerable: refusal(e, now), version: this.#version(e), inbox: this.#inboxView(e), notice: this.#notices.get(e.id) ?? null })),
      ledger: { configured: this.#ledger !== null, ok: l?.ok ?? false, at: l?.at ?? null },
```

with:

```ts
    return {
      items: this.#x.list().map(e => ({ ...e, answerable: refusal(e, now), version: this.#version(e) })),
      ledger: { configured: this.#ledger !== null, ok: l?.ok ?? false, at: l?.at ?? null },
```

In `apps/hub/src/application/escalation-service.ts` (11 of 20), replace:

```ts
    const e = this.#x.get(id);
    return e ? { ...e, answerable: refusal(e, this.#now()), version: this.#version(e), inbox: this.#inboxView(e), notice: this.#notices.get(e.id) ?? null } : null;
  }
  // A queued answer whose ask was asked again or settled meanwhile answers a question the principal no longer has
  // (E11, E12): withdrawn from the inbox, once, and its echo ignored should the cancel come too late (code review B1).
  #withdrawStale(spool: Map<string, InboxState | null>) {
    for (const [key, q] of this.#queued) {
      if (q.cancel || q.late) continue;
      const e = this.#x.get(q.escalationId);
      if (!e) continue;
      // Settled or expired meanwhile: withdrawn even though the ask still holds this Decision (code review H2).
      // Restated in place (same addedAt, new wording): the version changed while this Decision still stands (review #8).
      const closed = e.status === "settled" || e.status === "expired";
      const restated = q.version !== undefined && this.#version(e) !== q.version;
      if (!closed && !restated && (sameDecision(e.decision, q.decision) || !(e.askedAt > q.decision.at))) continue;
      const reader = this.#reader(q.dir);
      if (!reader) continue;
      const s = spool.get(key) ?? null;
      // Still untyped (no state file reads as queued, attempts 0): withdraw. Once typed, never cancel (decision 2):
      // wait for delivered, and if the ask moved on, record it then as a late answer to the old version.
      if (!s || this.#mayHaveTyped(s)) {
        if (s && this.#mayHaveTyped(s)) {
          q.late = true;
          if (q.line) this.#echo(q.escalationId, q.line, q.decision.at);
          this.#store.savePending(key, q.escalationId, this.#pendingBody(q));
        }
        continue;
      }
      if (s.status !== "queued" && s.status !== "held") continue;   // delivered, lost, gone, cancelled: #deliveries
      try { reader.cancel(key); } catch (err) { log.error(`answer to ${q.escalationId}: the withdrawal can't be written`, err); continue; }
      q.cancel = true;
      this.#store.savePending(key, q.escalationId, this.#pendingBody(q));
      if (q.line) this.#echo(q.escalationId, q.line, q.decision.at);
      log.info(`answer to ${q.escalationId} withdrawn from the manager's inbox: the ask changed since`);
    }
  }
  // Typed, or a cancel that arrived after a paste: an echo of it may still show up (decision 2).
  #mayHaveTyped(s: InboxState): boolean {
    return TYPED.has(s.status) || (s.attempts ?? 0) >= 1;
  }
  #echo(id: string, line: string, after: number) {
    const list = this.#echoes.get(id) ?? [];
    if (list.some(e => e.line === line && e.after === after)) return;
    list.push({ line, after, messageId: null });
    this.#echoes.set(id, list);
  }
  #unecho(id: string, line: string, after: number) {
    const list = (this.#echoes.get(id) ?? []).filter(e => e.line !== line || e.after !== after);
    if (list.length) this.#echoes.set(id, list); else this.#echoes.delete(id);
  }
  #open(p: Omit<QueuedAnswer, "state" | "words" | "unreadableSince" | "notice"> & { words?: QueuedAnswer["words"] }): QueuedAnswer {
    return { escalationId: p.escalationId, decision: p.decision, words: p.words ?? {}, state: { status: "queued", reason: null }, dir: p.dir,
      ...(p.line ? { line: p.line } : {}), ...(p.cancel ? { cancel: true } : {}), ...(p.late ? { late: true } : {}), ...(p.missed ? { missed: true } : {}), ...(p.version ? { version: p.version } : {}), ...(p.sendKey ? { sendKey: p.sendKey } : {}) };
  }
  #pendingBody(q: QueuedAnswer, settledAt?: number) {
    return { decision: q.decision, words: q.words, ...(q.dir ? { dir: q.dir } : {}), ...(q.line ? { line: q.line } : {}), ...(q.cancel ? { cancel: true } : {}),
      ...(q.late ? { late: true } : {}), ...(q.missed ? { missed: true } : {}), ...(q.notice ? { notice: q.notice } : {}), ...(q.version ? { version: q.version } : {}), ...(q.sendKey ? { sendKey: q.sendKey } : {}), ...(settledAt !== undefined ? { settledAt } : {}) };
  }
  // The answer did not stand (withdrawn, expired, gone): its sends row must not block the next one (E8).
  #releaseSend(q: { sendKey?: string }) { if (q.sendKey) this.#store.dropSend(q.sendKey); }
  // One withdraw: the Decision, its send, and the queued row. keepEcho holds a paste that may still show up; notice is
  // the card's sentence, stored on the row so a restart still shows it (review #29.9).
  #giveUp(key: string, q: QueuedAnswer, o: { now?: number; keepEcho?: boolean; notice?: string } = {}) {
    const id = q.escalationId;
    this.#x.withdraw(id, q.decision);
    this.#store.dropDecisionIf(id, q.decision.at);       // only this answer's row: a newer one stays (B3)
    this.#releaseSend(q);
    if (o.notice) q.notice = o.notice;
    if (o.keepEcho || o.notice) {
      if (q.line) this.#echo(id, q.line, q.decision.at);
      this.#store.savePending(key, id, this.#pendingBody(q, o.now));
    } else {
      this.#store.dropPending(key);
      if (q.cancel && q.line) this.#unecho(id, q.line, q.decision.at);
    }
    this.#queued.delete(key);
    if (o.notice) this.#notices.set(id, o.notice);
  }
  #forgetEchoes(now: number, rows: { key: string; escalationId: string; body: unknown }[], prune: boolean) {
    for (const [id, list] of this.#echoes) {
      const kept = list.filter(e => now - e.after < ECHO_KEEP_MS);
      if (kept.length) this.#echoes.set(id, kept); else this.#echoes.delete(id);
    }
    // Settled rows are only dropped in the constructor otherwise, so a long-running hub keeps every one (review #29.7).
    // Once an hour is enough: a poll that jumps past the keep window still drops them (round 2.8).
    if (!prune) return;
    for (const r of rows) {
      const body = r.body as { settledAt?: number; notice?: string };
      if (body.settledAt === undefined || now - body.settledAt <= ECHO_KEEP_MS) continue;
      this.#store.dropPending(r.key);
      if (typeof body.notice === "string" && this.#notices.get(r.escalationId) === body.notice) this.#notices.delete(r.escalationId);
    }
  }
  // The sentence leaves with the answer that caused it: a new answer, or the ask itself (review #29.8). An echo row
  // stays, without the sentence, so a later paste of the same line is still ignored. `rows` is the poll's one read.
  #clearNotice(id: string, rows: { key: string; escalationId: string; body: unknown }[] = this.#store.pendingAnswers()) {
    this.#notices.delete(id);
    for (const r of rows) {
      if (r.escalationId !== id) continue;
      const b = r.body as { notice?: string; line?: string };
      if (typeof b.notice !== "string") continue;
      if (b.line) {
        const rest = { ...b };
        delete rest.notice;
        this.#store.savePending(r.key, id, rest);
      } else this.#store.dropPending(r.key);
    }
  }
  #forgetNotices(rows: { key: string; escalationId: string; body: unknown }[]) {
    for (const id of [...this.#notices.keys()]) if (!this.#x.get(id)) this.#clearNotice(id, rows);
  }

  // The inbox a queued answer went to: the configured one, or, read-only, the one it named when it was queued (B6:
  // a restart without MORNDO_MANAGER_INBOX still sees it through, so it is recorded exactly once).
  #reader(dir: string | null): ManagerInbox | null {
    if (!dir) return this.#inbox;
    if (this.#inbox?.dir === dir) return this.#inbox;
    let r = this.#readers.get(dir);
    if (!r) { r = managerInbox(dir, this.#now); this.#readers.set(dir, r); }
    return r;
  }

  #inboxView(e: Escalation): InboxView | null {
    if (e.decision?.delivery?.state !== "queued") return null;
    for (const q of this.#queued.values()) if (q.escalationId === e.id && q.decision.at === e.decision.at) return q.state;
    return { status: "queued", reason: null };
  }
```

with:

```ts
    const e = this.#x.get(id);
    return e ? { ...e, answerable: refusal(e, this.#now()), version: this.#version(e) } : null;
  }
```

In `apps/hub/src/application/escalation-service.ts` (12 of 20), replace:

```ts
    for (const id of this.#buttons.keys()) if (!this.#x.get(id)) this.#buttons.delete(id);   // kept as long as its ask
    const pending = this.#store.pendingAnswers();       // one read per poll, shared by the notice and the echo prune
    this.#forgetNotices(pending);
    const prune = now - this.#prunedAt >= EscalationService.#pruneEveryMs;
    if (prune) this.#prunedAt = now;
    this.#forgetEchoes(now, pending, prune);
    // One read of each queued message per poll, shared by the withdrawal and the delivery step (review #29.10).
    const spool = new Map<string, InboxState | null>();
    for (const [key, q] of this.#queued) spool.set(key, this.#reader(q.dir)?.state(key) ?? null);
    this.#withdrawStale(spool);
    const delivered = this.#deliveries(now, spool);
    if (changed || delivered) this.#notify();
  }

  // Decisions in the manager's inbox: delivered ones are recorded (A1: with the endpoint, session and the time they
  // reached the manager), given-up ones (expired, cancelled by hand) open their ask again. Returns whether any changed.
  #deliveries(now: number, spool: Map<string, InboxState | null>): boolean {
    let changed = false;
    for (const [key, q] of this.#queued) {
      const id = q.escalationId;
      // No inbox to read: queued before migration 8 and migrated while none was configured, so where it went is
      // unknown (H4); like an inbox that can't be read.
      const reader = this.#reader(q.dir);
      let s = spool.get(key) ?? null;
      if (!s) {                                          // the inbox can't be read now: next round (code review B2),
        q.unreadableSince ??= now;                       // unless it stays so: moved or deleted (H3)
        if (now - q.unreadableSince < UNREADABLE_GIVE_UP_MS) continue;
        // The directory is still there (msg/ went, the inbox didn't): withdraw the message too (review #7).
        // cancel itself does nothing when the directory is gone, so a removed inbox is not recreated (review #12).
        try { reader?.cancel(key); } catch (err) { log.error(`answer to ${id}: the withdrawal can't be written`, err); }
      } else delete q.unreadableSince;
      if (!s || s.status === "gone") {                   // nothing can deliver it any more: the ask is open again (B2)
        this.#giveUp(key, q);
        log.warn(`answer to ${id}: ${s ? "its message is gone from the manager's inbox" : `its inbox (${q.dir ?? this.#inbox?.dir ?? "not known"}) can't be read for ${UNREADABLE_GIVE_UP_MS / 60_000} min`}; the ask is open again`);
        changed = true;
        continue;
      }
      // lost is not terminal, and a cleared line goes back to sent and is typed again (deliverer #receipt). unconfirmed
      // is the same. Cancel first. Answer again only once the spool says cancelled, so one answer is never typed twice
      // (review #29.1). Until that confirmation the Decision stays and the card does not say to answer again.
      if (s.status === "lost" || s.reason === "unconfirmed") {
        // A state this far along was read from a reader, so there is one. Once per state change: the deliverer
        // confirms cancel on its own loop, and the next poll's spool read sees it.
        if (!q.missed && reader) {
          let wrote = false;
          try { wrote = reader.cancel(key); }
          catch (err) { log.error(`answer to ${id}: the withdrawal can't be written`, err); continue; }
          if (!wrote) continue;                        // the file is not there: the next poll tries again (round 3.3)
          q.missed = true;
          this.#store.savePending(key, id, this.#pendingBody(q));
        }
        continue;
      }
      if (s.status === "delivered") {
        // Recorded from this message's own Decision (A1: who answered, and when it reached the manager).
        const at = s.deliveredAt ?? now;
        const delivered = { ...q.decision, delivery: { state: "delivered" as const, at } };
        const applied = this.#x.delivered(id, q.decision, at);
        const event = applied ?? answered(escalationId(id), delivered);   // superseded: still his answer, to the old version
        if (applied) this.#store.replaceDecisionIf(id, q.decision.at, delivered);   // B3
        else q.notice = LATE_ANSWER;
        // The ask moved on (same message, new version). The done row would block every later answer (round 2.1).
        // Applied and current: the row becomes typed, so a repeat says delivered (round 3.7). A late one is released.
        if (applied && !q.late && q.sendKey) this.#store.finishSend(q.sendKey, at);
        if (!applied || q.late) this.#releaseSend(q);
        this.#store.record([{ ...event, ...q.words }]);
        if (q.cancel || q.late || q.notice) this.#store.savePending(key, id, this.#pendingBody(q, now));   // its echo is ignored (B1)
        else this.#store.dropPending(key);
        if (q.notice) this.#notices.set(id, q.notice);
        this.#queued.delete(key);
        log.info(`answer to ${id} delivered to the manager${applied ? "" : " late, for the earlier version"}`);
        changed = true;
      } else if (s.status === "expired" || s.status === "cancelled") {
        // A paste may have happened (attempts ≥ 1, or our own cancel that didn't say attempts 0): keep the echo (B1, decision 2).
        const keepEcho = (s.attempts ?? 0) >= 1 || (q.cancel === true && s.attempts !== 0);
        this.#giveUp(key, q, { now, keepEcho, ...(q.missed ? { notice: MISSED_ANSWER } : {}) });
        log.warn(`answer to ${id} not delivered: the manager's inbox ${s.status === "expired" ? "let it expire" : "had it cancelled"}${q.missed ? "; it had been lost or unconfirmed" : ""}`);
        changed = true;
      } else if (s.status !== q.state.status || s.reason !== q.state.reason) {
        q.state = { status: s.status, reason: s.reason };
        changed = true;
      }
    }
    return changed;
  }
  #notify() { const b = this.board(); for (const l of this.#listeners) l(b); }
```

with:

```ts
    for (const id of this.#buttons.keys()) if (!this.#x.get(id)) this.#buttons.delete(id);   // kept as long as its ask
    if (changed) this.#notify();
  }

  #notify() { const b = this.board(); for (const l of this.#listeners) l(b); }
```

In `apps/hub/src/application/escalation-service.ts` (13 of 20), replace:

```ts
    const taps = new Map<string, { key: string; label: string; at: number }>();
    const echoes = new Set<string>();                    // the messages that are withdrawn answers' echoes (B1, H1)
    for (const list of this.#echoes.values()) for (const e of list) {
      if (e.messageId) { if (messages.some(m => m.id === e.messageId)) echoes.add(e.messageId); continue; }
      const m = messages.find(m => m.author.kind === "principal" && m.at >= e.after && m.text.trim() === e.line && !echoes.has(m.id));
      if (m) { e.messageId = m.id; echoes.add(m.id); }
    }
    for (const m of messages) {
```

with:

```ts
    const taps = new Map<string, { key: string; label: string; at: number }>();
    for (const m of messages) {
```

In `apps/hub/src/application/escalation-service.ts` (14 of 20), replace:

```ts
        const t = parseTap(m.text);
        if (t && !echoes.has(m.id)) taps.set(t.id, { key: t.key, label: t.label, at: m.at });   // not a withdrawn answer's echo (B1)
      }
```

with:

```ts
        const t = parseTap(m.text);
        if (t) taps.set(t.id, { key: t.key, label: t.label, at: m.at });
      }
```

In `apps/hub/src/application/escalation-service.ts` (15 of 20), replace:

```ts
      if (seen !== undefined && seen !== this.#version(e)) return { ok: false, problem: "changed", item: this.#view(id) };
      const option = choice.kind === "option" ? e.options.find(o => o.key === choice.key) : undefined;
      const line = option ? tapLine(e.id, option) : wordsLine(e.id, choice.kind === "words" ? choice.text : "");
      const words = choice.kind === "words" ? { length: choice.text.trim().length, digest: digest(choice.text) } : {};
      // The manager's answers go through its inbox (ADR-0010): queued now, delivered exactly once, recorded then.
      // The inbox switched off (`manager-inbox disable`) or not configured: typed directly, as before.
      // A manager that isn't running right now is fine: the inbox types it once it is back.
      let queued: { key: string; duplicate: boolean } | null = null;
      const k = answerKey(e.id, e, choice);
      if (e.asker.kind === "manager" && this.#inbox) {
        // The same in-doubt checks as the typed path, before anything is queued (E8, review #29.2): an earlier answer
        // this hub may have typed must block a second one, or the manager can be given both.
        const earlierSend = this.#store.send(k);
        if (earlierSend) {
          const settled = await this.#settleAnswer(a, id, choice, earlierSend, key);
          if (settled) return settled;
        }
        const other = await this.#otherAnswer(a, id, askPrefix(e.id, e), k);
        if (other) return other;
        try { queued = this.#inbox.enqueue({ id: `answer:${key}`, kind: option ? "tap" : "answer", text: line, meta: { escalation: e.id } }); }
        catch (err) { log.error(`answer to ${e.id}: the manager's inbox can't be written; typing directly`, err); }
      }
      if (queued) {
        if (queued.duplicate) {
          const st = this.#inbox?.state(queued.key) ?? null;
          if (st && (st.status === "cancelled" || st.status === "expired" || st.status === "gone")) {
            const pending = this.#queued.get(queued.key);
            if (pending) this.#giveUp(queued.key, pending);
            log.warn(`answer to ${e.id} not delivered: the same message is already ${st.status} in the manager's inbox`);
            return { ok: false, problem: "not_delivered", item: this.#view(id) };
          }
          // delivered, lost or accepted: nothing new was typed. Queuing again would make the next poll mark that
          // fresh Decision delivered (review #29.5).
          if (st && (st.status === "delivered" || st.status === "lost" || st.status === "accepted")) {
            log.warn(`answer to ${e.id} not delivered: the same message is already ${st.status} in the manager's inbox`);
            return { ok: false, problem: "not_delivered", item: this.#view(id) };
          }
        }
        const q = this.#x.queue(id, choice, { endpointId: a.endpoint.id, sessionId: a.session.id }, this.#now());
        if (!q.ok) {
          if (!queued.duplicate) { try { this.#inbox?.cancel(queued.key); } catch (err) { log.error(`answer to ${e.id}: the withdrawal can't be written`, err); } }
          return { ok: false, problem: q.error, item: this.#view(id) };
        }
        this.#clearNotice(id);
        const dir = this.#inbox?.dir ?? null;
        const entry = this.#open({ escalationId: id, decision: q.value, words, dir, line, version: this.#version(e), sendKey: k });
        this.#queued.set(queued.key, entry);
        this.#store.savePending(queued.key, id, this.#pendingBody(entry));
        this.#store.saveDecision(id, q.value);
        // The same request after the seen window, or a restart, is a duplicate (review #29.4), as a typed answer's
        // done row is. Without the row, check() refuses it as already_answered.
        if (this.#store.startAnswer(k, now, { workerId: e.asker.workerId, request })) this.#store.finishQueued(k);
        this.#seen.set(key, now);
        log.info(`answer to ${e.id} queued for the manager${queued.duplicate ? " (already in its inbox)" : ""}`);
        this.#notify();
        return { ok: true, item: this.#view(id) };
      }
      if (!e.asker.workerId) {
```

with:

```ts
      if (seen !== undefined && seen !== this.#version(e)) return { ok: false, problem: "changed", item: this.#view(id) };
      if (!e.asker.workerId) {
```

In `apps/hub/src/application/escalation-service.ts` (16 of 20), replace:

```ts
      }
      // ... or of the same answer from another request. The inbox path ran these already (review #29.2).
      const inDoubt = this.#store.send(k);
```

with:

```ts
      }
      const k = answerKey(e.id, e, choice);
      // ... or of the same answer from another request.
      const inDoubt = this.#store.send(k);
```

In `apps/hub/src/application/escalation-service.ts` (17 of 20), replace:

```ts
      if (other) return other;
      // Written before the first await, as a send's is: a hub that stops while this is typed leaves it "started".
```

with:

```ts
      if (other) return other;
      const option = choice.kind === "option" ? e.options.find(o => o.key === choice.key) : undefined;
      const line = option ? tapLine(e.id, option) : wordsLine(e.id, choice.kind === "words" ? choice.text : "");
      // Written before the first await, as a send's is: a hub that stops while this is typed leaves it "started".
```

In `apps/hub/src/application/escalation-service.ts` (18 of 20), replace:

```ts
      this.#seen.set(key, this.#now());
      // Queued in the inbox, not typed: still queued. The enqueue time is not when it was delivered (round 2.7).
      if (row.outcome === "queued") return { ok: true, item: this.#view(id), queued: true };
      return { ok: true, item: this.#view(id), duplicate: true, at: row.typedAt ?? row.at };
```

with:

```ts
      this.#seen.set(key, this.#now());
      return { ok: true, item: this.#view(id), duplicate: true, at: row.typedAt ?? row.at };
```

In `apps/hub/src/application/escalation-service.ts` (19 of 20), replace:

```ts
    if (decision) this.#store.saveDecision(id, decision);
    this.#clearNotice(id);
    this.#store.record([{ ...r.value, ...(option === null ? { digest: part.slice("words:".length) } : {}) }]);
```

with:

```ts
    if (decision) this.#store.saveDecision(id, decision);
    this.#store.record([{ ...r.value, ...(option === null ? { digest: part.slice("words:".length) } : {}) }]);
```

In `apps/hub/src/application/escalation-service.ts` (20 of 20), replace:

```ts
  #delivered(a: Authenticated, id: string, choice: Choice, key: string, at?: number): AnswerResult {
    this.#clearNotice(id);
    this.#seen.set(key, this.#now());
```

with:

```ts
  #delivered(a: Authenticated, id: string, choice: Choice, key: string, at?: number): AnswerResult {
    this.#seen.set(key, this.#now());
```

The steering service: `cleanText` comes here; the inbox branch, its deadline and `withdrawOverdue` go.

In `apps/hub/src/application/steering-service.ts` (1 of 15), replace:

```ts
import type { Store } from "../adapters/store.ts";
import { SENDER, cleanText, inboxKey, type InboxState, type ManagerInbox } from "../adapters/manager-inbox.ts";
import type { Authenticated } from "./access-service.ts";
```

with:

```ts
import type { Store } from "../adapters/store.ts";
import type { Authenticated } from "./access-service.ts";
```

In `apps/hub/src/application/steering-service.ts` (2 of 15), replace:

```ts
// `at`: when the node typed it, on that node's clock, which its transcript's times are on: the app matches the echo by
// it (fleet core §3.1; before, the hub's own clock, review M2). `queued`: handed to the manager's inbox (ADR-0010),
// which types it exactly once; the echo in the conversation ends it.
export type SendResult =
  | { ok: true; at: number; queued?: true }
  | { ok: false; problem: "duplicate"; at: number; queued?: true; inbox?: string; reason?: string | null }
  | { ok: false; problem: SendProblem | AttachRefusal | SendRefused | "step_up" | "empty" | "too_long" | "uncertain" | "stale" | "too_large" | "node_offline" | "not_delivered" };

```

with:

```ts
// `at`: when the node typed it, on that node's clock, which its transcript's times are on: the app matches the echo by
// it (fleet core §3.1; before, the hub's own clock, review M2).
export type SendResult =
  | { ok: true; at: number }
  | { ok: false; problem: "duplicate"; at: number }
  | { ok: false; problem: SendProblem | AttachRefusal | SendRefused | "step_up" | "empty" | "too_long" | "uncertain" | "stale" | "too_large" | "node_offline" };

```

In `apps/hub/src/application/steering-service.ts` (3 of 15), replace:

```ts
// row, and a repeat asks the node (op.status) when there is one, else is "uncertain".
const COMMAND_BUDGET_MS = 2 * 60_000;
const BEFORE_PASTE = new Set<SendOutcome["problem"]>(["no_pane", "menu_open", "no_input_box", "draft_present", "busy", "node_offline"]);
```

with:

```ts
// row, and a repeat asks the node (op.status) when there is one, else is "uncertain".
const BEFORE_PASTE = new Set<SendOutcome["problem"]>(["no_pane", "menu_open", "no_input_box", "draft_present", "busy", "node_offline"]);
```

In `apps/hub/src/application/steering-service.ts` (4 of 15), replace:

```ts
export const nothingTyped = (problem: SendOutcome["problem"]): boolean => BEFORE_PASTE.has(problem) || REFUSED.has(problem);
// Queued or held, and never pasted. A typed command (attempts at least 1, or accepted/sent/stuck) keeps its place.
const untypedWaiting = (s: InboxState) => (s.status === "queued" || s.status === "held") && s.attempts === 0;
const pastDeadline = (inbox: ManagerInbox, key: string, now: number) => {
  const deadline = inbox.deadline(key);
  return deadline !== null && now > deadline;
};

```

with:

```ts
export const nothingTyped = (problem: SendOutcome["problem"]): boolean => BEFORE_PASTE.has(problem) || REFUSED.has(problem);
// Text with nothing left once control characters other than newline and tab go (an ESC[201~ would end a bracketed
// paste early) and it is trimmed: empty (review B9). CRLF counts as one newline.
const kept = (c: string) => { const n = c.charCodeAt(0); return n === 9 || n === 10 || (n >= 32 && n !== 127); };
export function cleanText(s: string): string {
  let out = "";
  for (const c of s.replace(/\r\n?/g, "\n")) if (kept(c)) out += c;
  return out.trim();
}

```

In `apps/hub/src/application/steering-service.ts` (5 of 15), replace:

```ts
  #status: SendStatus | null;                                // the fleet's op.status; null: the legacy hub, nobody else knows
  #manager: { isManager: (workerId: string) => boolean; inbox: ManagerInbox } | null;

```

with:

```ts
  #status: SendStatus | null;                                // the fleet's op.status; null: the legacy hub, nobody else knows

```

In `apps/hub/src/application/steering-service.ts` (6 of 15), replace:

```ts
    status: SendStatus | null = null,
    manager: { isManager: (workerId: string) => boolean; inbox: ManagerInbox } | null = null,
  ) {
    this.#status = status;
    this.#manager = manager;
    this.#nameOf = nameOf;
```

with:

```ts
    status: SendStatus | null = null,
  ) {
    this.#status = status;
    this.#nameOf = nameOf;
```

In `apps/hub/src/application/steering-service.ts` (7 of 15), replace:

```ts

  // A queued command still untyped after its deadline. The deliverer does this until a retry, which clears the
  // deadline; this withdraws the revived one even when no phone is asking (round 3.5). Answers are not here.
  withdrawOverdue() {
    const manager = this.#manager;
    if (!manager) return;
    const now = this.#now();
    for (const key of this.#store.queuedCommands()) {
      const commandKey = inboxKey(SENDER, `command:${key}`);
      const spool = manager.inbox.state(commandKey);
      if (!spool || !untypedWaiting(spool) || !pastDeadline(manager.inbox, commandKey, now)) continue;
      manager.inbox.cancel(commandKey);
    }
  }

  // `seen`: the needs-you state the principal wrote it for ("none", or a question or menu id); absent, no check.
  // `name`: the worker it was written to; a pane that now runs another agent is no longer that worker (review M2).
  async send(a: Authenticated, workerId: string, text: string, requestId: string, uploads: string[] = [], seen?: string, name?: string, createdAt?: number, retry = false): Promise<SendResult> {
    const now = this.#now();
```

with:

```ts

  // `seen`: the needs-you state the principal wrote it for ("none", or a question or menu id); absent, no check.
  // `name`: the worker it was written to; a pane that now runs another agent is no longer that worker (review M2).
  async send(a: Authenticated, workerId: string, text: string, requestId: string, uploads: string[] = [], seen?: string, name?: string): Promise<SendResult> {
    const now = this.#now();
```

In `apps/hub/src/application/steering-service.ts` (8 of 15), replace:

```ts
      const first = await typing;
      return first.ok ? { ok: false, problem: "duplicate", at: first.at, ...(first.queued ? { queued: true as const } : {}) } : first;
    }
    const known = this.#store.send(key);
    if (known?.state === "done") {
      // Where the spool left a queued command. An expired one is revived only by the owner's Retry, below.
      let spool = known.outcome === "queued" && this.#manager?.isManager(workerId)
        ? this.#manager.inbox.state(inboxKey(SENDER, `command:${key}`)) : null;
      const commandKey = inboxKey(SENDER, `command:${key}`);
      // Only the owner's Retry asks the deliverer to run an expired, lost or cancelled command again, and only
      // after the same checks as any other send. A message that is gone cannot be retried (round 2.4, 2.5).
      // The deadline starts again: the deliverer ignores notAfter once it has retried (round 3.5).
      if (retry && spool && this.#manager && (spool.status === "expired" || spool.status === "lost" || spool.status === "cancelled")) {
        const refused = this.#maySend(a, workerId, now, seen, name);
        if (refused) return refused;
        // Nobody is emptying the inbox: type it directly, as enqueue does, instead of a retry file nothing reads (round 3.6).
        // The spool copy is cancelled first, and only once that file is written: a lost or still-queued copy would be
        // typed again when the deliverer returns (round 3).
        if (!this.#manager.inbox.accepting()) {
          if (!this.#manager.inbox.cancel(commandKey)) {
            return { ok: false, problem: "duplicate", at: known.typedAt ?? known.at, queued: true, inbox: spool.status, reason: spool.reason };
          }
          const prepared = await this.#prepare(a, workerId, text, uploads, now);
          if (!prepared.ok) return prepared;
          log.info(`send to ${workerId}: the manager's inbox is not being delivered; typing directly`);
          return this.#type(key, workerId, prepared.body, () => this.#commandSent(a, workerId, prepared.body, uploads.length, now));
        }
        if (!this.#manager.inbox.renew(commandKey, now + COMMAND_BUDGET_MS)) {
          return { ok: false, problem: "duplicate", at: known.typedAt ?? known.at, queued: true, inbox: spool.status, reason: spool.reason };
        }
        this.#manager.inbox.retry(commandKey);
        return { ok: true, at: now, queued: true };
      }
      // Still untyped past its deadline. A retry sets `retried` and the deliverer then never expires it, so the hub
      // withdraws it and says expired. A command already typed is left alone.
      if (spool && this.#manager && untypedWaiting(spool) && pastDeadline(this.#manager.inbox, commandKey, now)) {
        this.#manager.inbox.cancel(commandKey);
        spool = { ...spool, status: "expired" };
      }
      // Already delivered: the owner's Retry is that fact, not a refusal that would make them type it again (round 3.4).
      if (retry && spool?.status === "delivered") return { ok: true, at: spool.deliveredAt ?? known.typedAt ?? known.at ?? now };
      if (retry && spool?.status === "gone") return { ok: false, problem: "not_delivered" };
      // The spool's own word travels with the duplicate, so the app can say accepted, sent, stuck or unconfirmed
      // instead of deciding "Not sent" from the clock (round 2.2).
      const place = spool ? { inbox: spool.status, reason: spool.reason } : {};
      return { ok: false, problem: "duplicate", at: known.typedAt ?? known.at, ...(known.outcome === "queued" ? { queued: true as const, ...place } : {}) };
    }
    // Registered before the first await (the node asked about a send in doubt, the images staged), so a repeat arriving
    // meanwhile waits for this one: two repeats of a send in doubt at once paste it at most once.
    const job = this.#judge(a, key, workerId, text, uploads, now, known?.state === "started", seen, name, createdAt);
    this.#typing.set(key, job);
```

with:

```ts
      const first = await typing;
      return first.ok ? { ok: false, problem: "duplicate", at: first.at } : first;
    }
    const known = this.#store.send(key);
    if (known?.state === "done") return { ok: false, problem: "duplicate", at: known.typedAt ?? known.at };
    // Registered before the first await (the node asked about a send in doubt, the images staged), so a repeat arriving
    // meanwhile waits for this one: two repeats of a send in doubt at once paste it at most once.
    const job = this.#judge(a, key, workerId, text, uploads, now, known?.state === "started", seen, name);
    this.#typing.set(key, job);
```

In `apps/hub/src/application/steering-service.ts` (9 of 15), replace:

```ts
  // A send in doubt is settled with its node first; then the send is judged on arrival and typed.
  async #judge(a: Authenticated, key: string, workerId: string, text: string, uploads: string[], now: number, inDoubt: boolean, seen?: string, name?: string, createdAt?: number): Promise<SendResult> {
    if (inDoubt) {
```

with:

```ts
  // A send in doubt is settled with its node first; then the send is judged on arrival and typed.
  async #judge(a: Authenticated, key: string, workerId: string, text: string, uploads: string[], now: number, inDoubt: boolean, seen?: string, name?: string): Promise<SendResult> {
    if (inDoubt) {
```

In `apps/hub/src/application/steering-service.ts` (10 of 15), replace:

```ts
    if (refused) return refused;
    return this.#stageAndType(a, key, workerId, text, uploads, now, createdAt);
  }
```

with:

```ts
    if (refused) return refused;
    return this.#stageAndType(a, key, workerId, text, uploads, now);
  }
```

In `apps/hub/src/application/steering-service.ts` (11 of 15), replace:

```ts
  // The checks every path runs before anything is typed: a recent verification, the question the command was written
  // for, and the worker that pane runs now (review M2). An explicit Retry of an expired command uses the same ones.
  #maySend(a: Authenticated, workerId: string, now: number, seen?: string, name?: string): SendResult | null {
```

with:

```ts
  // The checks every path runs before anything is typed: a recent verification, the question the command was written
  // for, and the worker that pane runs now (review M2).
  #maySend(a: Authenticated, workerId: string, now: number, seen?: string, name?: string): SendResult | null {
```

In `apps/hub/src/application/steering-service.ts` (12 of 15), replace:

```ts
    if (!row) return null;                                         // gone meanwhile: judged anew
    if (row.state === "done") return { ok: false, problem: "duplicate", at: row.typedAt ?? row.at, ...(row.outcome === "queued" ? { queued: true as const } : {}) };
    if (s.state === "done") { this.#store.finishSend(key, s.typedAt); typedThere(s.typedAt); return { ok: false, problem: "duplicate", at: s.typedAt }; }
```

with:

```ts
    if (!row) return null;                                         // gone meanwhile: judged anew
    if (row.state === "done") return { ok: false, problem: "duplicate", at: row.typedAt ?? row.at };
    if (s.state === "done") { this.#store.finishSend(key, s.typedAt); typedThere(s.typedAt); return { ok: false, problem: "duplicate", at: s.typedAt }; }
```

In `apps/hub/src/application/steering-service.ts` (13 of 15), replace:

```ts
  // A refusal from #prepare writes no row, so a retry may type it.
  async #stageAndType(a: Authenticated, key: string, workerId: string, text: string, uploads: string[], now: number, createdAt?: number): Promise<SendResult> {
    const prepared = await this.#prepare(a, workerId, text, uploads, now);
```

with:

```ts
  // A refusal from #prepare writes no row, so a retry may type it.
  async #stageAndType(a: Authenticated, key: string, workerId: string, text: string, uploads: string[], now: number): Promise<SendResult> {
    const prepared = await this.#prepare(a, workerId, text, uploads, now);
```

In `apps/hub/src/application/steering-service.ts` (14 of 15), replace:

```ts
    const audit = (): AccessEvent => this.#commandSent(a, workerId, prepared.body, uploads.length, now);
    return this.#type(key, workerId, prepared.body, audit, createdAt);
  }
```

with:

```ts
    const audit = (): AccessEvent => this.#commandSent(a, workerId, prepared.body, uploads.length, now);
    return this.#type(key, workerId, prepared.body, audit);
  }
```

In `apps/hub/src/application/steering-service.ts` (15 of 15), replace:

```ts

  async #type(key: string, workerId: string, body: string, audit: () => AccessEvent, createdAt?: number): Promise<SendResult> {
    // For the manager: into its inbox, which types it exactly once when its pane is free (no menu, no one else's text
    // in its box). Switched off (`manager-inbox disable`) or not writable: typed directly, as before.
    if (this.#manager?.isManager(workerId)) {
      let queued: { key: string; duplicate: boolean } | null = null;
      // S7: two minutes from when the command was written, not from when it arrived (review #29.6), and only while
      // that moment is still inside the two minutes. A Retry of an older command, a clock running ahead, or one
      // running more than two minutes behind, starts the two minutes from this arrival (round 2.3).
      const age = this.#now() - (typeof createdAt === "number" ? createdAt : 0);
      const written = typeof createdAt === "number" && createdAt > 0 && age >= 0 && age < COMMAND_BUDGET_MS ? createdAt : this.#now();
      try { queued = this.#manager.inbox.enqueue({ id: `command:${key}`, kind: "owner", text: body, notAfter: written + COMMAND_BUDGET_MS }); }
      catch (e) { log.error(`send to ${workerId}: the manager's inbox can't be written; typing directly`, e); }
      if (queued) {
        this.#store.finishQueued(key);
        this.#store.record([audit()]);
        log.info(`send to ${workerId} queued in the manager's inbox`);
        return { ok: true, at: this.#now(), queued: true };
      }
    }
    let outcome: SendOutcome;
```

with:

```ts

  async #type(key: string, workerId: string, body: string, audit: () => AccessEvent): Promise<SendResult> {
    let outcome: SendOutcome;
```

In `apps/hub/src/adapters/store.ts` (1 of 4), replace:

```ts
export type SendRow = {
  state: "started" | "done"; at: number; outcome: string | null; typedAt: number | null; store: string | null; storeSeq: number | null; workerId: string | null; key: string;
};
type SendRowSql = {
  key: string; state: "started" | "done"; at: number; outcome: string | null; typed_at: number | null; node_store: string | null; node_store_seq: number | null; worker_id: string | null;
};
const sendRow = (r: SendRowSql): SendRow =>
  ({ state: r.state, at: r.at, outcome: r.outcome, typedAt: r.typed_at, store: r.node_store, storeSeq: r.node_store_seq, workerId: r.worker_id, key: r.key });
const SEND_COLUMNS = "key, state, at, outcome, typed_at, node_store, node_store_seq, worker_id";

```

with:

```ts
export type SendRow = {
  state: "started" | "done"; at: number; typedAt: number | null; store: string | null; storeSeq: number | null; workerId: string | null; key: string;
};
type SendRowSql = {
  key: string; state: "started" | "done"; at: number; typed_at: number | null; node_store: string | null; node_store_seq: number | null; worker_id: string | null;
};
const sendRow = (r: SendRowSql): SendRow =>
  ({ state: r.state, at: r.at, typedAt: r.typed_at, store: r.node_store, storeSeq: r.node_store_seq, workerId: r.worker_id, key: r.key });
const SEND_COLUMNS = "key, state, at, typed_at, node_store, node_store_seq, worker_id";

```

In `apps/hub/src/adapters/store.ts` (2 of 4), replace:

```ts
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
```

with:

```ts
  }
  // Only while the stored Decision is still this one (the time it was taken): a newer answer's row is left alone (B3).
```

In `apps/hub/src/adapters/store.ts` (3 of 4), replace:

```ts
  // S5: a request id's record, written "started" before typing and "done" after; kept 24 hours. `typedAt`: the node's
  // own time of the typing (fleet core §3.1), null for a row from before it was kept. `outcome`: "typed", or "queued"
  // (handed to the manager's inbox, ADR-0010); null while started. `workerId`: the worker an answer went to (null for a
  // send, whose repeat names its worker itself).
  send(key: string): SendRow | null {
```

with:

```ts
  // S5: a request id's record, written "started" before typing and "done" after; kept 24 hours. `typedAt`: the node's
  // own time of the typing (fleet core §3.1), null for a row from before it was kept. `workerId`: the worker an answer
  // went to (null for a send, whose repeat names its worker itself).
  send(key: string): SendRow | null {
```

In `apps/hub/src/adapters/store.ts` (4 of 4), replace:

```ts
  finishSend(key: string, typedAt: number) { this.db.prepare("UPDATE sends SET state = 'done', outcome = 'typed', typed_at = ? WHERE key = ?").run(typedAt, key); }
  // Handed to the manager's inbox (ADR-0010): done, with no typedAt, because the deliverer types it.
  finishQueued(key: string) { this.db.prepare("UPDATE sends SET state = 'done', outcome = 'queued' WHERE key = ?").run(key); }
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
```

with:

```ts
  finishSend(key: string, typedAt: number) { this.db.prepare("UPDATE sends SET state = 'done', outcome = 'typed', typed_at = ? WHERE key = ?").run(typedAt, key); }
  dropSend(key: string) { this.db.prepare("DELETE FROM sends WHERE key = ?").run(key); }
```

In `apps/hub/src/config.ts` (1 of 2), replace:

```ts
  paneLock: string | null;         // a lock file the box's other typists into the manager's pane take (flock); null = none
  managerInbox: string | null;     // the manager's inbox (a queue dir, ADR-0010): answers and messages for it go there; null = typed directly
  vnc: { host: string; port: number; passwordFile: string } | null;   // the office's desktop (VNC); null = no Desktop tab
```

with:

```ts
  paneLock: string | null;         // a lock file the box's other typists into the manager's pane take (flock); null = none
  vnc: { host: string; port: number; passwordFile: string } | null;   // the office's desktop (VNC); null = no Desktop tab
```

In `apps/hub/src/config.ts` (2 of 2), replace:

```ts
    paneLock: env.MORNDO_PANE_LOCK || null,
    // A directory turns it on; unset, empty, "0" or "off" leave it off (the design report's switch is MORNDO_MANAGER_INBOX=0).
    managerInbox: env.MORNDO_MANAGER_INBOX && !/^(0|off)$/i.test(env.MORNDO_MANAGER_INBOX) ? env.MORNDO_MANAGER_INBOX : null,
    vnc: vncTarget(env),
```

with:

```ts
    paneLock: env.MORNDO_PANE_LOCK || null,
    vnc: vncTarget(env),
```

In `apps/hub/src/main.ts` (1 of 5), replace:

```ts
import { ledgerReader } from "./adapters/ledger.ts";
import { managerInbox } from "./adapters/manager-inbox.ts";
import { EscalationService, managerOf } from "./application/escalation-service.ts";
```

with:

```ts
import { ledgerReader } from "./adapters/ledger.ts";
import { EscalationService, managerOf } from "./application/escalation-service.ts";
```

In `apps/hub/src/main.ts` (2 of 5), replace:

```ts
MORNDO_CLAUDE_DIR, MORNDO_MANAGER_WINDOW (default "manager"), MORNDO_LEDGER (the manager's needs-you list),
MORNDO_PANE_LOCK (the lock file other typists into the manager's pane take), MORNDO_MANAGER_INBOX (the manager's
inbox directory: its answers and messages queue there instead of being typed), MORNDO_VNC (host:port of the desktop's
VNC server), MORNDO_VNC_PASSWORD_FILE, MORNDO_FLEET_SOCKET (the fleet service's client socket; unset, this
```

with:

```ts
MORNDO_CLAUDE_DIR, MORNDO_MANAGER_WINDOW (default "manager"), MORNDO_LEDGER (the manager's needs-you list),
MORNDO_PANE_LOCK (the lock file other typists into the manager's pane take), MORNDO_VNC (host:port of the desktop's
VNC server), MORNDO_VNC_PASSWORD_FILE, MORNDO_FLEET_SOCKET (the fleet service's client socket; unset, this
```

In `apps/hub/src/main.ts` (3 of 5), replace:

```ts
    // doubt asks the worker's node (op.status, spec §3.1).
    // The manager's inbox (ADR-0010): the manager's answers and messages queue there; one deliverer types each once.
    const queue = config.managerInbox ? managerInbox(config.managerInbox) : null;
    const steering = new SteeringService(store, typist, Date.now, () => access.policy(), inbox, id => observation.waitingOn(id),
      id => observation.nameOf(id), ports.uploads, ports.sendStatus,
      queue ? { isManager: id => id === managerPane(), inbox: queue } : null);
    const escalations = new EscalationService({
```

with:

```ts
    // doubt asks the worker's node (op.status, spec §3.1).
    const steering = new SteeringService(store, typist, Date.now, () => access.policy(), inbox, id => observation.waitingOn(id),
      id => observation.nameOf(id), ports.uploads, ports.sendStatus);
    const escalations = new EscalationService({
```

In `apps/hub/src/main.ts` (4 of 5), replace:

```ts
      settle: (key, workerId) => steering.settleInDoubt(key, workerId),
      inbox: queue,
    });
```

with:

```ts
      settle: (key, workerId) => steering.settleInDoubt(key, workerId),
    });
```

In `apps/hub/src/main.ts` (5 of 5), replace:

```ts
    escalations.start(Math.max(config.pollMs, 1000));
    // A retried command has no deadline of the deliverer's. Withdraw one still untyped after its two minutes.
    const withdrawCommands = setInterval(() => {
      try { steering.withdrawOverdue(); }
      catch (e) { log.warn("a queued command's deadline could not be checked", e); }
    }, Math.max(config.pollMs, 1000));
    log.info(`morndo hub on http://127.0.0.1:${config.port}, for ${config.origin}`);
    log.info(`hub identity ${formatFingerprint(identity.fingerprint)}`);
    const stop = async () => { clearInterval(sweepInbox); clearInterval(withdrawCommands); stopRetention(); observation.stop(); escalations.stop(); notifications.stop(); fleet?.stop(); await http.close(); store.close(); process.exit(0); };
    process.on("SIGINT", () => void stop());
```

with:

```ts
    escalations.start(Math.max(config.pollMs, 1000));
    log.info(`morndo hub on http://127.0.0.1:${config.port}, for ${config.origin}`);
    log.info(`hub identity ${formatFingerprint(identity.fingerprint)}`);
    const stop = async () => { clearInterval(sweepInbox); stopRetention(); observation.stop(); escalations.stop(); notifications.stop(); fleet?.stop(); await http.close(); store.close(); process.exit(0); };
    process.on("SIGINT", () => void stop());
```

In `apps/hub/src/adapters/http.ts`, replace:

```ts
      const body = await readBody(req, SendBody);
      const r = await steering.send(a, sendTo, body.text, body.requestId, body.uploads ?? [], body.seen, body.name, body.createdAt, body.retry === true);
      if (r.ok) return json(res, 200, r);
      if (r.problem === "duplicate") return json(res, 200, { error: "duplicate", ok: true, at: r.at, ...(r.queued ? { queued: true } : {}), ...(r.inbox !== undefined ? { inbox: r.inbox, reason: r.reason ?? null } : {}) });
      return json(res, r.problem === "step_up" ? 403 : r.problem === "no_pane" ? 404 : 409, { error: r.problem });
```

with:

```ts
      const body = await readBody(req, SendBody);
      const r = await steering.send(a, sendTo, body.text, body.requestId, body.uploads ?? [], body.seen, body.name);
      if (r.ok) return json(res, 200, r);
      if (r.problem === "duplicate") return json(res, 200, { error: "duplicate", ok: true, at: r.at });
      return json(res, r.problem === "step_up" ? 403 : r.problem === "no_pane" ? 404 : 409, { error: r.problem });
```

In `packages/protocol/src/http.ts`, replace:

```ts
  createdAt: z.exactOptional(z.number().check(z.gte(0), z.lte(Number.MAX_SAFE_INTEGER))),
  // Set only by the owner's Retry. A plain repeat of the same request id must not revive an expired command.
  retry: z.exactOptional(z.boolean()),
});
```

with:

```ts
  createdAt: z.exactOptional(z.number().check(z.gte(0), z.lte(Number.MAX_SAFE_INTEGER))),
});
```

In `packages/protocol/src/feed.ts` (1 of 2), replace:

```ts
  version: orElse(text(), ""),                                 // askVersion; a hub that doesn't say: "" (never matches)
  // While a Decision waits in the manager's inbox: where it stands there (its status and why it waits). A hub that
  // doesn't say: null.
  inbox: orElse(z.nullable(z.object({ status: text(), reason: z.nullable(text()) })), null),
  // A sentence on an open card: the answer reached the manager late, or did not reach the manager (ADR-0010 addendum).
```

with:

```ts
  version: orElse(text(), ""),                                 // askVersion; a hub that doesn't say: "" (never matches)
  // A sentence on an open card: the answer reached the manager late, or did not reach the manager (ADR-0010 addendum).
```

In `packages/protocol/src/feed.ts` (2 of 2), replace:

```ts
export type ClientFeedFrame = { [K in keyof typeof ClientFeedFrames]: z.output<(typeof ClientFeedFrames)[K]> }[keyof typeof ClientFeedFrames];
export type InboxWait = { status: string; reason: string | null };
export type DecisionItem = Escalation & { answerable: AnswerRefusal | null; version: string; inbox: InboxWait | null; notice?: string | null };
export type LedgerState = z.output<typeof LedgerStateSchema>;
```

with:

```ts
export type ClientFeedFrame = { [K in keyof typeof ClientFeedFrames]: z.output<(typeof ClientFeedFrames)[K]> }[keyof typeof ClientFeedFrames];
export type DecisionItem = Escalation & { answerable: AnswerRefusal | null; version: string; notice?: string | null };
export type LedgerState = z.output<typeof LedgerStateSchema>;
```

The cards keep #29's delivery line; its "why" comes back with the queue's reasons in Task 13.

In `apps/web/src/lib/desktop/decisions.ts` (1 of 2), replace:

```ts

// ADR-0010: a Decision for the manager waits in the manager's inbox until it reached the manager. Why it waits, in
// words (the inbox's reasons; one this app doesn't know says nothing more than "queued").
const INBOX_WAITS: Record<string, string> = {
  menu: "a menu is open in the manager's terminal; it goes in once that's answered",
  foreign_text: "the manager's input box has text that isn't from Morndo; it goes in once that's sent or cleared",
  no_manager: "the manager isn't running right now; it goes in once it's back",
  busy: "the manager is busy; it takes it when it gets to it",
  lock: "another message is being typed into the manager right now",
  unseen: "the manager's screen can't be read right now",
  unconfirmed: "it was typed, but the manager hasn't shown it yet; the box owner has been told",
  lost_in_queue: "it fell out of the manager's own queue; the box owner has been told",
};
export type DeliveryLine = { state: "queued"; why: string | null } | { state: "delivered"; at: number | null };
```

with:

```ts

// A Decision for the manager that waits until it reached the manager (E13): queued, or delivered (and when).
export type DeliveryLine = { state: "queued"; why: string | null } | { state: "delivered"; at: number | null };
```

In `apps/web/src/lib/desktop/decisions.ts` (2 of 2), replace:

```ts
  if (del.state === "delivered") return { state: "delivered", at: del.at };
  const reason = d.inbox?.reason ?? null;
  return { state: "queued", why: reason ? INBOX_WAITS[reason] ?? null : null };
}
```

with:

```ts
  if (del.state === "delivered") return { state: "delivered", at: del.at };
  return { state: "queued", why: null };
}
```

In `apps/web/src/lib/gallery/data.ts` (1 of 2), replace:

```ts
    deadline: null, blocking: false, project: "Search", askedAt: now - 40 * MIN, messageId: null, tracking: "ledger",
    status: "open", source: "open", decision: null, resolution: null, settledAt: null, askedAgain: false, answerable: null, version: `v-${id}`, inbox: null, ...over,
  });
```

with:

```ts
    deadline: null, blocking: false, project: "Search", askedAt: now - 40 * MIN, messageId: null, tracking: "ledger",
    status: "open", source: "open", decision: null, resolution: null, settledAt: null, askedAgain: false, answerable: null, version: `v-${id}`, ...over,
  });
```

In `apps/web/src/lib/gallery/data.ts` (2 of 2), replace:

```ts
    { label: "Answered here", item: d("answered", { status: "answered", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 5 * MIN, via: "here", endpointId: null, sessionId: null } }) },
    { label: "Answered, queued in the manager's inbox (its box has someone's text)", item: d("queued", { status: "answered", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 2 * MIN, via: "here", endpointId: null, sessionId: null, delivery: { state: "queued", at: null } }, inbox: { status: "held", reason: "foreign_text" } }) },
    { label: "Answered, delivered to the manager", item: d("delivered", { status: "answered", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 9 * MIN, via: "here", endpointId: null, sessionId: null, delivery: { state: "delivered", at: now - 8 * MIN } } }) },
```

with:

```ts
    { label: "Answered here", item: d("answered", { status: "answered", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 5 * MIN, via: "here", endpointId: null, sessionId: null } }) },
    { label: "Answered, queued for the manager", item: d("queued", { status: "answered", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 2 * MIN, via: "here", endpointId: null, sessionId: null, delivery: { state: "queued", at: null } } }) },
    { label: "Answered, delivered to the manager", item: d("delivered", { status: "answered", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 9 * MIN, via: "here", endpointId: null, sessionId: null, delivery: { state: "delivered", at: now - 8 * MIN } } }) },
```

In `.github/workflows/ci.yml`, replace:

```
        run: node e2e/gallery.e2e.ts
      - name: e2e inbox
        if: ${{ !cancelled() && steps.deps.outcome == 'success' && steps.tools.outcome == 'success' }}
        env: { E2E_OUT: "${{ runner.temp }}/e2e/inbox" }
        run: node e2e/inbox.e2e.ts
      # ADR-0013: the Engines page; on the engine CLI's stand-in here, as the engine layer isn't on GitHub.
```

with:

```
        run: node e2e/gallery.e2e.ts
      # ADR-0013: the Engines page; on the engine CLI's stand-in here, as the engine layer isn't on GitHub.
```

In `package.json`, replace:

```json
    "fleet": "node apps/fleet/src/main.ts",
    "e2e": "npm run build && npm run check:build && node e2e/web-endpoint.e2e.ts && node e2e/desktop.e2e.ts && node e2e/ink.e2e.ts && node e2e/signal.e2e.ts && node e2e/push.e2e.ts && node e2e/catchup.e2e.ts && node e2e/catchup-edges.e2e.ts && node e2e/horizon.e2e.ts && node e2e/readability.e2e.ts && node e2e/fleet-two-node.e2e.ts && node e2e/gallery.e2e.ts && node e2e/inbox.e2e.ts && node e2e/engines.e2e.ts && node e2e/board.e2e.ts && node e2e/home.e2e.ts",
    "lint": "oxlint --format=stylish",
```

with:

```json
    "fleet": "node apps/fleet/src/main.ts",
    "e2e": "npm run build && npm run check:build && node e2e/web-endpoint.e2e.ts && node e2e/desktop.e2e.ts && node e2e/ink.e2e.ts && node e2e/signal.e2e.ts && node e2e/push.e2e.ts && node e2e/catchup.e2e.ts && node e2e/catchup-edges.e2e.ts && node e2e/horizon.e2e.ts && node e2e/readability.e2e.ts && node e2e/fleet-two-node.e2e.ts && node e2e/gallery.e2e.ts && node e2e/engines.e2e.ts && node e2e/board.e2e.ts && node e2e/home.e2e.ts",
    "lint": "oxlint --format=stylish",
```

In each of these eight tests, the `Config` literal loses `managerInbox: null, ` (the type has no such field now): `apps/hub/test/access-idle-sweep.test.ts`, `access-policy-http.test.ts`, `desktop-control-idle.test.ts`, `fleet-two-nodes.test.ts`, `http-crash-fixture.ts`, `http.test.ts`, `inprocess-hub.ts`, `remote-revoke.test.ts`:

In `apps/hub/test/access-idle-sweep.test.ts`, replace:

```ts
    requireProxyIdentity: true, principalLogin: LOGIN, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 1000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, managerInbox: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
```

with:

```ts
    requireProxyIdentity: true, principalLogin: LOGIN, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 1000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
```

In `apps/hub/test/access-policy-http.test.ts`, replace:

```ts
    requireProxyIdentity: true, principalLogin: LOGIN, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 1000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, managerInbox: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
```

with:

```ts
    requireProxyIdentity: true, principalLogin: LOGIN, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 1000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
```

In `apps/hub/test/desktop-control-idle.test.ts`, replace:

```ts
    requireProxyIdentity: false, principalLogin: null, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: join(dir, "web"), officeName: null,
    pollMs: 1000, quietAfterMs: 1000, managerWindow: "manager", ledgerPath: null, paneLock: null, managerInbox: null, vnc: null,
    filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
```

with:

```ts
    requireProxyIdentity: false, principalLogin: null, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: join(dir, "web"), officeName: null,
    pollMs: 1000, quietAfterMs: 1000, managerWindow: "manager", ledgerPath: null, paneLock: null, vnc: null,
    filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
```

In `apps/hub/test/fleet-two-nodes.test.ts`, replace:

```ts
    tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 60_000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, managerInbox: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
    fleetSocket: rig.fleet.socketPath,
```

with:

```ts
    tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 60_000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
    fleetSocket: rig.fleet.socketPath,
```

In `apps/hub/test/http-crash-fixture.ts`, replace:

```ts
    requireProxyIdentity: true, principalLogin: LOGIN, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 1000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, managerInbox: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
```

with:

```ts
    requireProxyIdentity: true, principalLogin: LOGIN, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 1000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
```

In `apps/hub/test/http.test.ts`, replace:

```ts
    requireProxyIdentity: true, principalLogin: LOGIN, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 1000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, managerInbox: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
```

with:

```ts
    requireProxyIdentity: true, principalLogin: LOGIN, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 1000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
```

In `apps/hub/test/inprocess-hub.ts`, replace:

```ts
    requireProxyIdentity: false, principalLogin: null, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 1000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, managerInbox: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
```

with:

```ts
    requireProxyIdentity: false, principalLogin: null, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 1000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
```

In `apps/hub/test/remote-revoke.test.ts`, replace:

```ts
    requireProxyIdentity: false, principalLogin: null, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: join(dir, "web"), officeName: null,
    pollMs: 1000, quietAfterMs: 1000, managerWindow: "manager", ledgerPath: null, paneLock: null, managerInbox: null, vnc: null,
    filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
```

with:

```ts
    requireProxyIdentity: false, principalLogin: null, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: join(dir, "web"), officeName: null,
    pollMs: 1000, quietAfterMs: 1000, managerWindow: "manager", ledgerPath: null, paneLock: null, vnc: null,
    filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
```

- [ ] **Step 12.4: Run it and see it pass, then the suites, the types and the linter**

Run: `npx vitest run apps/hub/test/no-manager-inbox.test.ts`
Expected: PASS, 3 tests.

Run: `npx vitest run apps/hub packages/protocol packages/domain apps/web`
Expected: PASS, every test (175 files, 1322 tests in the scratch copy): the hub types to the manager directly, as before #29.

Run: `npm run check`
Expected: exit 0.

Run: `npm run lint`
Expected: no problems.

Run: `node scripts/negative-controls.ts --check`
Expected: `ok` for every entry: none of them named the inbox's code.

- [ ] **Step 12.5: Commit**

```bash
git add apps/hub/test/no-manager-inbox.test.ts docs/adr/0010-manager-inbox.md apps/hub/src/application/escalation-service.ts apps/hub/src/application/steering-service.ts apps/hub/src/adapters/store.ts apps/hub/src/config.ts apps/hub/src/main.ts apps/hub/src/adapters/http.ts packages/protocol/src/http.ts packages/protocol/src/feed.ts apps/web/src/lib/desktop/decisions.ts apps/web/src/lib/gallery/data.ts .github/workflows/ci.yml package.json apps/hub/test/access-idle-sweep.test.ts apps/hub/test/access-policy-http.test.ts apps/hub/test/desktop-control-idle.test.ts apps/hub/test/fleet-two-nodes.test.ts apps/hub/test/http-crash-fixture.ts apps/hub/test/http.test.ts apps/hub/test/inprocess-hub.ts apps/hub/test/remote-revoke.test.ts
```

```bash
git commit -m "refactor(hub)!: remove the manager's inbox on disk; the fleet's queue replaces it" -m "BREAKING CHANGE: MORNDO_MANAGER_INBOX is no longer read; until the next commits the manager's answers and messages are typed directly"
```

- [ ] **Step 12.6: Write the failing domain test (E13)**

Create `packages/domain/test/escalation-delivery.test.ts`. It tests #29's functions, which only #29's inbox tests covered, and `uncertain`:

```ts
// E13 (fleet-clients §9.1; ADR-0014, with ADR-0010's domain rules): a Decision for the manager handed to the fleet's
// delivery queue counts as given while queued (E8), is recorded once delivered, at the time it reached the manager;
// "uncertain" (typed, never seen taken) keeps it given and is never asked again; given up (never typed), the ask is open
// again. Only the Decision that was queued moves: a newer one, or an ask asked again since, is left alone (#29's code
// review B3), and one restored after a restart moves before its ask is sighted (B5). Synthetic asks.
import { describe, expect, it } from "vitest";
import { Escalations, answered, endpointId, escalationId, sameDecision, sessionId, type Ask, type Decision } from "../src/index.ts";

const T0 = Date.UTC(2026, 9, 8, 9);
const BY = { endpointId: endpointId("ep1"), sessionId: sessionId("s1") };
const SHIP = { kind: "option" as const, key: "ship", label: "Ship it" };          // as decided: the label is the ask's
const ask = (o: Partial<Ask> = {}): Ask => ({
  id: escalationId("ny-7"), asker: { kind: "manager", name: "Manager", workerId: null }, need: "decision", title: "Ship it tonight?",
  shortTitle: null, summary: null, minutes: null, link: null, details: null, context: null, contextKind: "markdown",
  options: [{ key: "ship", label: "Ship it", detail: null }, { key: "hold", label: "Hold", detail: null }], answerBy: "tap",
  recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null, askedAt: T0 - 60_000, messageId: "m1",
  tracking: "ledger", ...o,
});
const board = () => {
  const x = new Escalations();
  x.reconcile([{ ask: ask(), source: { kind: "open" }, answered: null }], T0, true);
  return x;
};
const queued = (x: Escalations): Decision => {
  const q = x.queue("ny-7", { kind: "option", key: "ship" }, BY, T0);
  if (!q.ok) throw new Error(`not queued: ${q.error}`);
  return q.value;
};

describe("a Decision through the delivery queue (E13)", () => {
  it("queued counts as given (E8): answered, a second answer refused, nothing recorded yet", () => {
    const x = board();
    const d = queued(x);
    expect(d).toEqual({ choice: SHIP, at: T0, via: "here", ...BY, delivery: { state: "queued", at: null } });
    expect(x.get("ny-7")).toMatchObject({ status: "answered", decision: d });
    expect(x.check("ny-7", { kind: "option", key: "hold" }, T0 + 1)).toEqual({ ok: false, error: "already_answered" });
  });

  it("delivered: recorded once, at the time it reached the manager", () => {
    const x = board();
    const d = queued(x);
    expect(x.delivered("ny-7", d, T0 + 5000)).toEqual({ type: "EscalationAnswered", escalationId: "ny-7", choice: SHIP, ...BY, at: T0 + 5000 });
    expect(x.get("ny-7")?.decision?.delivery).toEqual({ state: "delivered", at: T0 + 5000 });
    expect(x.delivered("ny-7", d, T0 + 6000)).toBeNull();                 // a second word on it records nothing
  });

  it("uncertain: still answered, never open again, and not recorded", () => {
    const x = board();
    const d = queued(x);
    expect(x.uncertain("ny-7", d)).toBe(true);
    expect(x.get("ny-7")).toMatchObject({ status: "answered", decision: { delivery: { state: "uncertain", at: null } } });
    expect(x.withdraw("ny-7", d)).toBe(false);                              // only a queued Decision is given up
    expect(x.delivered("ny-7", d, T0 + 5000)).toBeNull();
  });

  it("given up: the ask is open again, and another answer is taken", () => {
    const x = board();
    const d = queued(x);
    expect(x.withdraw("ny-7", d)).toBe(true);
    expect(x.get("ny-7")).toMatchObject({ status: "open", decision: null });
    expect(x.check("ny-7", { kind: "option", key: "hold" }, T0 + 1).ok).toBe(true);
  });

  it("asked again meanwhile: the old queued Decision moves nothing on the new ask (negative control)", () => {
    const x = board();
    const d = queued(x);
    x.reconcile([{ ask: ask({ messageId: "m2", askedAt: T0 + 1000 }), source: { kind: "open" }, answered: null }], T0 + 1000, true);
    expect(x.get("ny-7")).toMatchObject({ status: "open", decision: null, askedAgain: true });
    expect(x.delivered("ny-7", d, T0 + 2000)).toBeNull();
    expect(x.uncertain("ny-7", d)).toBe(false);
    expect(x.withdraw("ny-7", d)).toBe(false);
    expect(x.get("ny-7")).toMatchObject({ status: "open", decision: null });
  });

  it("given up, then answered again: a late word on the first Decision moves nothing on the second", () => {
    const x = board();
    const first = queued(x);
    expect(x.withdraw("ny-7", first)).toBe(true);
    const q = x.queue("ny-7", { kind: "option", key: "hold" }, BY, T0 + 1000);
    if (!q.ok) throw new Error(q.error);
    expect(x.delivered("ny-7", first, T0 + 2000)).toBeNull();
    expect(x.uncertain("ny-7", first)).toBe(false);
    expect(x.get("ny-7")?.decision).toEqual(q.value);
  });

  it("restored after a restart and not sighted yet: delivered acts on the restored Decision, which the ask then shows", () => {
    const x = new Escalations();
    const d: Decision = { choice: SHIP, at: T0, via: "here", ...BY, delivery: { state: "queued", at: null } };
    x.restore([{ id: escalationId("ny-7"), decision: d }]);
    expect(x.delivered("ny-7", d, T0 + 5000)?.at).toBe(T0 + 5000);
    x.reconcile([{ ask: ask(), source: { kind: "open" }, answered: null }], T0 + 6000, true);
    expect(x.get("ny-7")).toMatchObject({ status: "answered", decision: { delivery: { state: "delivered", at: T0 + 5000 } } });
  });

  it("restored and uncertain before it is sighted: the ask comes back answered, may have been delivered", () => {
    const x = new Escalations();
    const d: Decision = { choice: SHIP, at: T0, via: "here", ...BY, delivery: { state: "queued", at: null } };
    x.restore([{ id: escalationId("ny-7"), decision: d }]);
    expect(x.uncertain("ny-7", d)).toBe(true);
    x.reconcile([{ ask: ask(), source: { kind: "open" }, answered: null }], T0 + 6000, true);
    expect(x.get("ny-7")).toMatchObject({ status: "answered", decision: { delivery: { state: "uncertain", at: null } } });
  });

  it("restored and given up before it is sighted: the ask comes back open", () => {
    const x = new Escalations();
    const d: Decision = { choice: SHIP, at: T0, via: "here", ...BY, delivery: { state: "queued", at: null } };
    x.restore([{ id: escalationId("ny-7"), decision: d }]);
    expect(x.withdraw("ny-7", d)).toBe(true);
    x.reconcile([{ ask: ask(), source: { kind: "open" }, answered: null }], T0 + 6000, true);
    expect(x.get("ny-7")).toMatchObject({ status: "open", decision: null });
  });

  it("the same Decision: its moment, endpoint, session and choice, whatever its delivery says", () => {
    const d: Decision = { choice: SHIP, at: T0, via: "here", ...BY, delivery: { state: "queued", at: null } };
    expect(sameDecision({ ...d, delivery: { state: "delivered", at: T0 + 1 } }, d)).toBe(true);
    expect(sameDecision({ ...d, delivery: { state: "uncertain", at: null } }, d)).toBe(true);
    expect(sameDecision({ ...d, at: T0 + 1 }, d)).toBe(false);
    expect(sameDecision({ ...d, choice: { kind: "words" } }, d)).toBe(false);
    expect(sameDecision(null, d)).toBe(false);
    expect(answered(escalationId("ny-7"), { ...d, delivery: { state: "delivered", at: T0 + 9 } }).at).toBe(T0 + 9);
    expect(answered(escalationId("ny-7"), { ...d, delivery: undefined }).at).toBe(T0);
  });
});
```

- [ ] **Step 12.7: Run it and see it fail**

Run: `npx vitest run packages/domain/test/escalation-delivery.test.ts`
Expected: FAIL, 4 of 10, each `TypeError: x.uncertain is not a function`. The six others pass on #29's functions as they are: queued counts as given, delivered is recorded once, given up opens the ask again, a Decision restored and not sighted yet is delivered or given up, and the same Decision whatever its delivery says.

- [ ] **Step 12.8: Add `uncertain` to #29's delivery, and E13 in the queue's words**

In `packages/domain/src/escalation.ts` (1 of 4), replace:

```ts

// A Decision for the manager goes through its inbox (the box's queue for its terminal, ADR-0010): "queued" until the
// inbox reports it in the manager's conversation, then "delivered". Absent: it reached the asker when it was taken
// (typed directly, or seen at the asker's end).
export type Delivery = { state: "queued" | "delivered"; at: number | null };

```

with:

```ts

// A Decision for the manager goes through the fleet's delivery queue (E13; fleet-clients §9.1, ADR-0014): "queued" until
// the queue reports it in the manager's conversation, then "delivered"; "uncertain" once it was typed and never seen
// taken. Absent: it reached the asker when it was taken (typed directly, or seen at the asker's end).
export type Delivery = { state: "queued" | "delivered" | "uncertain"; at: number | null };

```

In `packages/domain/src/escalation.ts` (2 of 4), replace:

```ts

  // E13: the Decision handed to the manager's inbox. It counts as given at once (E8: a second answer is refused and shows
  // it), but is recorded, as EscalationAnswered, only once the inbox reports it at the asker (`delivered`).
  queue(id: string, choice: Choice, by: { endpointId: EndpointId; sessionId: SessionId }, now: number): Result<Decision, AnswerRefusal> {
```

with:

```ts

  // E13: the Decision handed to the manager's queue. It counts as given at once (E8: a second answer is refused and shows
  // it), but is recorded, as EscalationAnswered, only once the queue reports it at the asker (`delivered`).
  queue(id: string, choice: Choice, by: { endpointId: EndpointId; sessionId: SessionId }, now: number): Result<Decision, AnswerRefusal> {
```

In `packages/domain/src/escalation.ts` (3 of 4), replace:

```ts

  // The inbox has it in the manager's conversation: the queued Decision is delivered, and recorded from now on. Null
  // when this ask holds no longer that queued Decision (asked again, answered otherwise meanwhile: the caller records the
```

with:

```ts

  // The queue has it in the manager's conversation: the queued Decision is delivered, and recorded from now on. Null
  // when this ask holds no longer that queued Decision (asked again, answered otherwise meanwhile: the caller records the
```

In `packages/domain/src/escalation.ts` (4 of 4), replace:

```ts

  // The inbox gave the queued Decision up (it expired, or was cancelled by hand): the ask is open again. Only that
  // Decision: a newer one given meanwhile stays (code review B3).
  withdraw(id: string, expected: Decision): boolean {
```

with:

```ts

  // Typed and never seen taken: the queued Decision stays given, is never asked again, and is not recorded (it may not
  // have reached the manager; E13). Only that Decision, restored after a restart included (code review B3, B5).
  uncertain(id: string, expected: Decision): boolean {
    const e = this.#items.get(id as EscalationId);
    const d = e ? e.decision : this.#restored.get(id as EscalationId) ?? null;
    if (!d || d.delivery?.state !== "queued" || !sameDecision(d, expected)) return false;
    d.delivery = { state: "uncertain", at: null };
    return true;
  }

  // The queue gave the queued Decision up, never typed (it expired, was cancelled, or its lane went): the ask is open
  // again. Only that Decision: a newer one given meanwhile stays (code review B3).
  withdraw(id: string, expected: Decision): boolean {
```

The feed's schema follows the domain's type (the protocol checks they agree at compile time):

In `packages/protocol/src/feed.ts`, replace:

```ts
    sessionId: z.nullable(z.pipe(text(), z.transform(s => s as SessionId))),
    // ADR-0010: a Decision for the manager waits in its inbox ("queued") until it reached the manager ("delivered").
    // A state this app doesn't know reads as queued: it never claims a delivery it can't vouch for.
    delivery: z.optional(z.object({ state: orElse(z.enum(["queued", "delivered"]), "queued"), at: z.nullable(z.number()) })),
  })),
```

with:

```ts
    sessionId: z.nullable(z.pipe(text(), z.transform(s => s as SessionId))),
    // E13: a Decision for the manager waits in the fleet's delivery queue ("queued") until it reached the manager
    // ("delivered"), or was typed and never seen taken ("uncertain"). A state this app doesn't know reads as queued: it
    // never claims a delivery it can't vouch for.
    delivery: z.optional(z.object({ state: orElse(z.enum(["queued", "delivered", "uncertain"]), "queued"), at: z.nullable(z.number()) })),
  })),
```

In `docs/domain.md`, the four places that name the inbox say queue (ruling 87): E13, the paragraph under it, the `Send state` row and S5.

In `docs/domain.md` (1 of 3), replace:

```md
| E12 | An answer that names the version of the Ask it was given for (when and in which message it was asked, its wording, options and terms) is refused as changed if the Ask was restated since: it never answers a question the principal didn't see. (ADR-0009: the phone holds an answer 5 seconds.) | F2, F4 |
| E13 | A Decision for the manager goes through its inbox ([ADR-0010](adr/0010-manager-inbox.md)): Queued until the inbox reports it in the manager's conversation, then Delivered. Queued, it counts as given (E8). Given up by the inbox (expired, or cancelled by hand), the Escalation is open again and nothing is recorded. | F1, F2 |

A Decision is a Command under Access (AC7). It is recorded only after the asker has it (delivered into its pane; for the manager, Delivered by its inbox, E13), with the endpoint, session and time as provenance (A1).

```

with:

```md
| E12 | An answer that names the version of the Ask it was given for (when and in which message it was asked, its wording, options and terms) is refused as changed if the Ask was restated since: it never answers a question the principal didn't see. (ADR-0009: the phone holds an answer 5 seconds.) | F2, F4 |
| E13 | With a fleet, a Decision for the manager goes through the fleet's delivery queue (fleet-clients §9.1; [ADR-0014](adr/0014-fleet-clients-delivery-queue-and-lane-events.md), which keeps ADR-0010's rules). Queued until the queue reports it in the manager's conversation, then Delivered, and recorded then, at the time it reached the manager. Queued, it counts as given (E8). Given up, never typed (expired, cancelled, or its lane gone), it reached no one: the Escalation is open again, it says Not delivered, and nothing is recorded. Typed and never seen taken, it may have been delivered: it stays given, is never asked again or typed again, and is not recorded. Queued for an Ask that was settled, expired or asked again meanwhile, it is withdrawn; one typed anyway answers the Ask it was given for, and its echo in the conversation is never taken as an answer to the newer Ask. | F1, F2 |

A Decision is a Command under Access (AC7). It is recorded only after the asker has it (delivered into its pane; for the manager with a fleet, Delivered by the queue, E13), with the endpoint, session and time as provenance (A1).

```

In `docs/domain.md` (2 of 3), replace:

```md
| Needs-you state seen | What the worker was waiting for when the Command was written: `none`, or the id of the question or menu it showed. | Whatever the worker shows when the Command arrives. |
| Send state | Where a Command stands: Queued, Sending, Sent (the hub typed it; for the manager, the manager's inbox has it and types it once, ADR-0010), Echoed (it shows in the Conversation); or Not sent with a reason; or Uncertain (the hub stopped, or lost the worker's machine, while typing it, so it may have been typed). | A Delivery state (accepted, failed, unknown) of an Escalation. |

```

with:

```md
| Needs-you state seen | What the worker was waiting for when the Command was written: `none`, or the id of the question or menu it showed. | Whatever the worker shows when the Command arrives. |
| Send state | Where a Command stands: Queued, Sending, Sent (the hub typed it; for the manager with a fleet, the fleet's delivery queue has it and types it once, up to 24 hours later, and it can be cancelled while it waits), Echoed (it shows in the Conversation); or Not sent with a reason; or Uncertain (the hub stopped, or lost the worker's machine, while typing it, so it may have been typed). | A Delivery state (accepted, failed, unknown) of an Escalation. |

```

In `docs/domain.md` (3 of 3), replace:

```md
| S4 | A Command enters the Outbox before its first attempt, with one request id for all its attempts. Commands to one worker go in the order they were queued; different workers don't wait for each other. |
| S5 | Within 24 hours of its first attempt, the hub types a request id at most once (for the manager: hands it to the manager's inbox at most once, under the request id, ADR-0010). It records the request as started before typing and as done after, durably, and keeps the record 24 hours. A repeat of a done request answers "duplicate"; a repeat of a started one that never finished (the hub stopped while typing) answers "uncertain" and is never typed again, unless the hub can ask the worker's machine (a fleet, fleet core §3.1): typed there, it answers "duplicate"; never received there, it is typed now. |
| S6 | Every Command carries the needs-you state it saw. The hub judges it on arrival: if the worker's state differs in either direction (answered, asked again, changed, or a question or menu showing where there was none), the Command is refused as `stale` and never typed; the app says "The question changed: review before sending". With `none` and still nothing showing, it goes through, so steering a busy agent keeps working. AC7's freshness is also judged on arrival ("Not sent: verify", one tap). The check runs before the terminal adapter's own guard against typing into a menu, which stays as the last guard. |
```

with:

```md
| S4 | A Command enters the Outbox before its first attempt, with one request id for all its attempts. Commands to one worker go in the order they were queued; different workers don't wait for each other. |
| S5 | Within 24 hours of its first attempt, the hub types a request id at most once (for the manager with a fleet: hands it to the fleet's delivery queue at most once, under the request id as the delivery's id). It records the request as started before typing and as done after, durably, and keeps the record 24 hours. A repeat of a done request answers "duplicate"; a repeat of a started one that never finished (the hub stopped while typing) answers "uncertain" and is never typed again, unless the hub can ask the worker's machine (a fleet, fleet core §3.1): typed there, it answers "duplicate"; never received there, it is typed now. |
| S6 | Every Command carries the needs-you state it saw. The hub judges it on arrival: if the worker's state differs in either direction (answered, asked again, changed, or a question or menu showing where there was none), the Command is refused as `stale` and never typed; the app says "The question changed: review before sending". With `none` and still nothing showing, it goes through, so steering a busy agent keeps working. AC7's freshness is also judged on arrival ("Not sent: verify", one tap). The check runs before the terminal adapter's own guard against typing into a menu, which stays as the last guard. |
```

- [ ] **Step 12.9: Run it and see it pass, with the domain and the protocol**

Run: `npx vitest run packages/domain packages/protocol`
Expected: PASS, every test (`escalation-delivery.test.ts`: 10).

Run: `grep -n -i 'inbox' docs/domain.md || echo "no inbox"`
Expected: `no inbox`.

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 12.10: Commit**

```bash
git add packages/domain/src/escalation.ts packages/domain/test/escalation-delivery.test.ts packages/protocol/src/feed.ts docs/domain.md
```

```bash
git commit -m "feat(domain): a queued Decision may end uncertain; E13 and S5 name the fleet's queue"
```

- [ ] **Step 12.11: Write the failing feed test**

Create `packages/protocol/test/feed-deliveries.test.ts`:

```ts
// The feed's words for the manager's delivery queue (fleet-clients §9.1, Task 13): a Decision's delivery state and why it
// waits, the card's notice, and the `deliveries` frame (this device's messages to the manager, by request id). A hub from
// before says none of it, and an app reads that as before; a state this app doesn't know reads as queued, never as
// delivered (E13). Synthetic frames only.
import { describe, expect, it } from "vitest";
import { ServerFeedFrames, decode } from "../src/index.ts";

const T0 = Date.UTC(2026, 9, 8, 9);
const item = (o: Record<string, unknown> = {}) => ({
  id: "ny-7", asker: { kind: "manager", name: "Manager", workerId: "pc.aaaaaaaa.1" }, need: "decision", title: "Ship it?",
  context: null, contextKind: "markdown", options: [], answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: null,
  blocking: false, project: null, askedAt: T0, messageId: null, tracking: "ledger", status: "answered", source: "open",
  decision: { choice: { kind: "option", key: "ship", label: "Ship it" }, at: T0, via: "here", endpointId: "ep1", sessionId: "s1", delivery: { state: "queued", at: null } },
  resolution: null, settledAt: null, askedAgain: false, answerable: "already_answered", version: "v1", ...o,
});
const board = (items: unknown[]) => decode(ServerFeedFrames, JSON.stringify({ t: "decisions", items, ledger: { configured: true, ok: true, at: T0 } }));
const first = (d: ReturnType<typeof board>) => (d.kind === "ok" && d.frame.t === "decisions" ? d.frame.items[0] : undefined);

describe("a Decision's delivery in the feed", () => {
  it("carries its state, why it waits, and the card's notice", () => {
    const d = first(board([item({ waiting: "menu_open" })]));
    expect(first(board([item({ status: "open", decision: null, notice: "Not delivered: the answer never reached the manager. Answer again." })]))?.notice).toMatch(/^Not delivered/);
    expect(d?.decision?.delivery).toEqual({ state: "queued", at: null });
    expect(d?.waiting).toBe("menu_open");
    expect(first(board([item({ decision: { ...item().decision, delivery: { state: "delivered", at: T0 + 5 } } })]))?.decision?.delivery).toEqual({ state: "delivered", at: T0 + 5 });
    expect(first(board([item({ decision: { ...item().decision, delivery: { state: "uncertain", at: null } } })]))?.decision?.delivery?.state).toBe("uncertain");
  });
  it("a hub from before says neither: no delivery, no reason", () => {
    const { delivery: _gone, ...before } = item().decision;
    const d = first(board([item({ decision: before })]));
    expect(d?.decision?.delivery).toBeUndefined();
    expect(d && "waiting" in d).toBe(false);
  });
  it("a delivery state this app doesn't know reads as queued, never delivered (negative control)", () => {
    const d = first(board([item({ decision: { ...item().decision, delivery: { state: "teleported", at: T0 } } })]));
    expect(d?.decision?.delivery).toEqual({ state: "queued", at: T0 });
  });
});

describe("the deliveries frame", () => {
  it("decodes each of this device's messages to the manager by request id", () => {
    const frame = { t: "deliveries", items: [
      { requestId: "r1", state: "queued", waiting: "draft_present", why: null },
      { requestId: "r2", state: "delivered", waiting: null, why: null },
      { requestId: "r3", state: "given_up", waiting: null, why: "expired" },
    ] };
    expect(decode(ServerFeedFrames, JSON.stringify(frame))).toEqual({ kind: "ok", frame });
  });
  it("a state it doesn't know reads as queued; an item that doesn't fit is dropped, not the frame (negative control)", () => {
    const d = decode(ServerFeedFrames, JSON.stringify({ t: "deliveries", items: [
      { requestId: "r1", state: "beamed", waiting: null, why: null },
      { requestId: 7, state: "delivered", waiting: null, why: null },
    ] }));
    expect(d).toEqual({ kind: "ok", frame: { t: "deliveries", items: [{ requestId: "r1", state: "queued", waiting: null, why: null }] } });
    expect(decode(ServerFeedFrames, JSON.stringify({ t: "deliveries" })).kind).toBe("malformed");
  });
});
```

- [ ] **Step 12.12: Run it and see it fail**

Run: `npx vitest run packages/protocol/test/feed-deliveries.test.ts`
Expected: FAIL, 3 of 5: `AssertionError: expected undefined to be 'menu_open'`, and twice `AssertionError: expected { kind: 'unknown', t: 'deliveries' } to deeply equal { kind: 'ok', frame: { …(2) } }`. "a hub from before says neither" and the unknown state read as queued pass: #29's schema has them (Step 12.8 added `uncertain`).

- [ ] **Step 12.13: The feed's `waiting`, `QueuedCommand` and `deliveries`, and the app's frame switch kept exhaustive**

In `packages/protocol/src/feed.ts` (1 of 3), replace:

```ts
  version: orElse(text(), ""),                                 // askVersion; a hub that doesn't say: "" (never matches)
  // A sentence on an open card: the answer reached the manager late, or did not reach the manager (ADR-0010 addendum).
  // A hub that doesn't say: none.
  notice: z.exactOptional(z.nullable(text())),
});
export const LedgerStateSchema = z.object({ configured: z.boolean(), ok: z.boolean(), at: z.nullable(z.number()) });
```

with:

```ts
  version: orElse(text(), ""),                                 // askVersion; a hub that doesn't say: "" (never matches)
  // A sentence on an open card: the answer reached the manager late, or never reached it (E13). A hub that doesn't say:
  // none.
  notice: z.exactOptional(z.nullable(text())),
  // While a queued Decision waits: why, as the queue says (a WaitingReason, or "typed" or "held"; words in the app's
  // queue-words.ts). Absent otherwise, and from a hub from before the queue.
  waiting: z.exactOptional(text()),
});
// Where one of this device's messages to the manager stands in the fleet's delivery queue (fleet-clients §9.1), by its
// request id: "queued" (typed and held included: not in the conversation yet), with why it waits; "delivered";
// "uncertain" (typed, never seen taken: it may have reached the manager); "given_up", with why (nothing reached it). A
// state this app doesn't know reads as queued.
export const QueuedCommandSchema = z.object({
  requestId: text(),
  state: orElse(z.enum(["queued", "delivered", "uncertain", "given_up"]), "queued"),
  waiting: z.nullable(text()),
  why: z.nullable(text()),
});
export type QueuedCommand = z.output<typeof QueuedCommandSchema>;
export const LedgerStateSchema = z.object({ configured: z.boolean(), ok: z.boolean(), at: z.nullable(z.number()) });
```

In `packages/protocol/src/feed.ts` (2 of 3), replace:

```ts
  usage: UsageFrameSchema,
};
```

with:

```ts
  usage: UsageFrameSchema,
  // Fleet-clients §9.1: where this device's messages to the manager stand in the fleet's delivery queue, every one of the
  // last day after each hello, then each change. An app from before ignores it, as any frame type it doesn't know.
  deliveries: z.object({ t: z.literal("deliveries"), items: each(QueuedCommandSchema, "delivery") }),
};
```

In `packages/protocol/src/feed.ts` (3 of 3), replace:

```ts
export type ClientFeedFrame = { [K in keyof typeof ClientFeedFrames]: z.output<(typeof ClientFeedFrames)[K]> }[keyof typeof ClientFeedFrames];
export type DecisionItem = Escalation & { answerable: AnswerRefusal | null; version: string; notice?: string | null };
export type LedgerState = z.output<typeof LedgerStateSchema>;
```

with:

```ts
export type ClientFeedFrame = { [K in keyof typeof ClientFeedFrames]: z.output<(typeof ClientFeedFrames)[K]> }[keyof typeof ClientFeedFrames];
export type DecisionItem = Escalation & { answerable: AnswerRefusal | null; version: string; notice?: string | null; waiting?: string };
export type LedgerState = z.output<typeof LedgerStateSchema>;
```

The app decodes every frame and its switch over `ServerFeedFrame` ends in `unreachable`: without its case, a `deliveries` frame throws there (`TypeError: Unhandled case: {"t":"deliveries",…}`) and `svelte-check` fails. Task 13 makes the outbox use it.

In `apps/web/src/lib/feed.svelte.ts` (1 of 3), replace:

```ts
import { unreachable, type FeedEvent, type Message, type RosterEntry } from "@morndo/domain";
import { ServerFeedFrames, decode, decodeEvent, onDropped, type CatchUpConversationWire, type ServerFeedFrame, type SessionInfoWire } from "@morndo/protocol";
import type { DecisionItem, LedgerState } from "./desktop/decisions.ts";
```

with:

```ts
import { unreachable, type FeedEvent, type Message, type RosterEntry } from "@morndo/domain";
import { ServerFeedFrames, decode, decodeEvent, onDropped, type CatchUpConversationWire, type QueuedCommand, type ServerFeedFrame, type SessionInfoWire } from "@morndo/protocol";
import type { DecisionItem, LedgerState } from "./desktop/decisions.ts";
```

In `apps/web/src/lib/feed.svelte.ts` (2 of 3), replace:

```ts
  fleetAvailable = $state(true);
  // Catch-up (ADR-0009): what each unmuted conversation brought since its Read mark (C5), by conversation name, as the
```

with:

```ts
  fleetAvailable = $state(true);
  // Fleet-clients §9.1: where this device's messages to the manager stand in the fleet's queue, by request id, as the
  // hub last said (every one of the last day after a hello, then each change). The outbox applies them.
  deliveries = $state<QueuedCommand[]>([]);
  // Catch-up (ADR-0009): what each unmuted conversation brought since its Read mark (C5), by conversation name, as the
```

In `apps/web/src/lib/feed.svelte.ts` (3 of 3), replace:

```ts
        break;
      case "older": {
```

with:

```ts
        break;
      case "deliveries": {
        const named = new Set(m.items.map(i => i.requestId));
        this.deliveries = [...this.deliveries.filter(d => !named.has(d.requestId)), ...m.items].slice(-500);
        break;
      }
      case "older": {
```

- [ ] **Step 12.14: Run it and see it pass**

Run: `npx vitest run packages/protocol apps/web/test/feed-frames.test.ts`
Expected: PASS for `feed-deliveries.test.ts` (5 tests) and every protocol and feed-frame suite.

Run: `npm run check -w @morndo/web`
Expected: no error in `feed.svelte.ts`.

- [ ] **Step 12.15: Commit**

```bash
git add packages/protocol/src/feed.ts packages/protocol/test/feed-deliveries.test.ts apps/web/src/lib/feed.svelte.ts
```

```bash
git commit -m "feat(protocol): the feed's deliveries frame and why a queued Decision waits"
```

- [ ] **Step 12.16: Write the failing store test (migration 16)**

Create `apps/hub/test/manager-deliveries-store.test.ts`:

```ts
// Migration 16 (fleet-clients §9.1, plan.md Databases; 13 to 15 are the board, Home's usage and #29's pending_answers,
// which stays, unused): manager_deliveries, one row per delivery of an answer or a message to the manager, so a hub
// restart keeps following it; never the text. And the decisions row of a queued answer, changed or dropped only while it
// is still the Decision that was queued (a newer answer's row is left alone; #29's code review B3). Real SQLite files in
// a temp dir.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "../src/adapters/migrations.ts";
import { Store, type ManagerDeliveryRow } from "../src/adapters/store.ts";

const T0 = Date.UTC(2026, 9, 8, 9);
let dir: string;
let store: Store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-mgr-deliveries-")); store = new Store(dir); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const row = (o: Partial<ManagerDeliveryRow> = {}): ManagerDeliveryRow => ({
  deliveryId: "hub:answer:ny-7:m1:option:ship", kind: "answer", escalationId: "ny-7", ask: "m1",
  choice: JSON.stringify({ kind: "option", key: "ship", label: "Ship it" }), endpointId: "ep1", sessionId: "s1", requestId: "r1",
  queuedAt: T0, state: "sending", updatedAt: T0, ...o,
});

describe("migration 16", () => {
  it("gives a database at 15 manager_deliveries, keeps its rows, and changes nothing run again", () => {
    const db = new Database(join(dir, "other.db"));
    migrate(db, MIGRATIONS.slice(0, 15));
    db.prepare("INSERT INTO decisions (escalation_id, at, body) VALUES ('ny-7', 5, '{}')").run();
    expect(migrate(db, MIGRATIONS.slice(0, 16))).toEqual({ from: 15, to: 16 });
    const cols = (db.prepare("PRAGMA table_info(manager_deliveries)").all() as { name: string }[]).map(c => c.name);
    expect(cols).toEqual(["delivery_id", "kind", "escalation_id", "ask", "choice", "endpoint_id", "session_id", "request_id", "queued_at", "state", "updated_at"]);
    expect(db.prepare("SELECT escalation_id FROM decisions").all()).toEqual([{ escalation_id: "ny-7" }]);
    expect(() => MIGRATIONS[15]?.up(db)).not.toThrow();
    db.close();
  });
  it("refuses a state or a kind it doesn't know (negative control)", () => {
    expect(() => store.saveManagerDelivery(row({ state: "teleported" as never }))).toThrow(/CHECK/);
    expect(() => store.saveManagerDelivery(row({ kind: "note" as never }))).toThrow(/CHECK/);
  });
});

describe("the manager's deliveries", () => {
  it("a row is written once, read back whole, and moves through its states", () => {
    store.saveManagerDelivery(row());
    store.saveManagerDelivery(row({ state: "queued" }));                        // a second write of the same id changes nothing
    expect(store.managerDelivery("hub:answer:ny-7:m1:option:ship")).toEqual(row());
    store.setManagerDeliveryState("hub:answer:ny-7:m1:option:ship", "typed", T0 + 5);
    expect(store.managerDelivery("hub:answer:ny-7:m1:option:ship")).toMatchObject({ state: "typed", updatedAt: T0 + 5 });
    expect(store.openManagerDeliveries().map(r => r.deliveryId)).toEqual(["hub:answer:ny-7:m1:option:ship"]);
    store.setManagerDeliveryState("hub:answer:ny-7:m1:option:ship", "delivered", T0 + 9);
    expect(store.openManagerDeliveries()).toEqual([]);
  });
  it("finds a request's row, an answer's row by its Decision, and a key's attempts in order", () => {
    store.saveManagerDelivery(row({ state: "given_up" }));
    store.saveManagerDelivery(row({ deliveryId: "hub:answer:ny-7:m1:option:ship~2", requestId: "r2", queuedAt: T0 + 10, state: "queued" }));
    store.saveManagerDelivery(row({ deliveryId: "hub:answer:ny-7:m1:option:shipping", requestId: "r3", queuedAt: T0 + 20 }));
    store.saveManagerDelivery(row({ deliveryId: "hub:ep1:r9", kind: "command", escalationId: null, ask: null, choice: null, requestId: "r9", queuedAt: T0 + 30 }));
    expect(store.managerDeliveryOfRequest("ep1", "r2")?.deliveryId).toBe("hub:answer:ny-7:m1:option:ship~2");
    expect(store.managerDeliveryOfRequest("ep2", "r2")).toBeNull();
    expect(store.answerDelivery("ny-7", T0 + 10)?.deliveryId).toBe("hub:answer:ny-7:m1:option:ship~2");
    expect(store.managerDeliveryAttempts("hub:answer:ny-7:m1:option:ship").map(r => r.deliveryId))
      .toEqual(["hub:answer:ny-7:m1:option:ship", "hub:answer:ny-7:m1:option:ship~2"]);   // never another key that starts so
    expect(store.managerDeliveriesWithPrefix("hub:answer:ny-7:m1:").map(r => r.deliveryId)).toHaveLength(3);
    expect(store.commandDeliveriesOf("ep1", T0).map(r => r.deliveryId)).toEqual(["hub:ep1:r9"]);
  });
  it("prunes what changed before a time; drops one row", () => {
    store.saveManagerDelivery(row({ state: "delivered", updatedAt: T0 }));
    store.saveManagerDelivery(row({ deliveryId: "hub:ep1:r9", kind: "command", requestId: "r9", updatedAt: T0 + 100 }));
    expect(store.pruneManagerDeliveries(T0 + 50)).toBe(1);
    store.dropManagerDelivery("hub:ep1:r9");
    expect(store.openManagerDeliveries()).toEqual([]);
  });
});

describe("a queued answer's decisions row", () => {
  it("is replaced or dropped only while it is the Decision taken at that time", () => {
    store.saveDecision("ny-7", { at: T0, choice: { kind: "words" } });
    store.replaceDecisionIf("ny-7", T0 + 1, { at: T0 + 1, replaced: true });          // another answer's time: untouched
    store.dropDecisionIf("ny-7", T0 + 1);
    expect(store.decisions()).toEqual([{ id: "ny-7", decision: { at: T0, choice: { kind: "words" } } }]);
    store.replaceDecisionIf("ny-7", T0, { at: T0, choice: { kind: "words" }, delivery: { state: "delivered", at: T0 + 5 } });
    expect(store.decisions()[0]?.decision).toMatchObject({ delivery: { state: "delivered", at: T0 + 5 } });
    store.dropDecisionIf("ny-7", T0);
    expect(store.decisions()).toEqual([]);
  });
});
```

- [ ] **Step 12.17: Run it and see it fail**

Run: `npx vitest run apps/hub/test/manager-deliveries-store.test.ts`
Expected: FAIL, 5 of 6: `AssertionError: expected { from: 15, to: 15 } to deeply equal { from: 15, to: 16 }`, `AssertionError: expected [Function] to throw error matching /CHECK/ but got 'store.saveManagerDelivery is not a fu…'`, and three `TypeError: store.saveManagerDelivery is not a function`. The decisions-row test passes: `replaceDecisionIf` and `dropDecisionIf` are #29's, kept.

- [ ] **Step 12.18: Migration 16 and the store's rows**

Migration 16 (ruling 84; 13 to 15 are the board, Home's usage and #29's `pending_answers`):

In `apps/hub/src/adapters/migrations.ts`, replace:

```ts
  },
];
```

with:

```ts
  },
  {
    version: 16,
    name: "manager_deliveries (migration 16): the manager's answers and messages in the fleet's delivery queue, followed across hub restarts (fleet-clients §9.1)",
    up: db => {
      db.exec(`CREATE TABLE IF NOT EXISTS manager_deliveries (
        delivery_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('answer', 'command')),
        escalation_id TEXT, ask TEXT, choice TEXT, endpoint_id TEXT NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL,
        queued_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('sending', 'queued', 'typed', 'held', 'delivered', 'uncertain', 'given_up')),
        updated_at INTEGER NOT NULL)`);
      db.exec("CREATE INDEX IF NOT EXISTS manager_deliveries_request ON manager_deliveries (endpoint_id, request_id)");
      db.exec("CREATE INDEX IF NOT EXISTS manager_deliveries_answer ON manager_deliveries (escalation_id, queued_at)");
    },
  },
];
```

In `apps/hub/src/adapters/store.ts` (1 of 3), replace:

```ts
import { migrate } from "./migrations.ts";
import {
```

with:

```ts
import { migrate } from "./migrations.ts";
import type { DeliveryState } from "@morndo/protocol";
import {
```

In `apps/hub/src/adapters/store.ts` (2 of 3), replace:

```ts
export const READ_MARKS_KEPT = 500;

```

with:

```ts
export const READ_MARKS_KEPT = 500;

// One delivery of an answer or a message to the manager through the fleet's queue (fleet-clients §9.1; migration 16).
// `state` "sending": the fleet was asked and hasn't answered yet (or never did); otherwise the delivery's own state as the
// hub last heard it. An answer's `choice` is JSON (escalation-service.ts StoredChoice: its option, or its words' length
// and digest, never the words); `ask` the ask it answered (its message, or its time); `queuedAt` the hub's time, which
// is the queued Decision's own. A message's are null. Never the text.
export type ManagerDeliveryState = "sending" | DeliveryState;
export type ManagerDeliveryRow = {
  deliveryId: string; kind: "answer" | "command"; escalationId: string | null; ask: string | null; choice: string | null;
  endpointId: string; sessionId: string; requestId: string; queuedAt: number; state: ManagerDeliveryState; updatedAt: number;
};
type ManagerDeliverySql = {
  delivery_id: string; kind: "answer" | "command"; escalation_id: string | null; ask: string | null; choice: string | null;
  endpoint_id: string; session_id: string; request_id: string; queued_at: number; state: ManagerDeliveryState; updated_at: number;
};
const managerDeliveryRow = (r: ManagerDeliverySql): ManagerDeliveryRow => ({
  deliveryId: r.delivery_id, kind: r.kind, escalationId: r.escalation_id, ask: r.ask, choice: r.choice, endpointId: r.endpoint_id,
  sessionId: r.session_id, requestId: r.request_id, queuedAt: r.queued_at, state: r.state, updatedAt: r.updated_at,
});
const OPEN_STATES = "('sending', 'queued', 'typed', 'held')";

```

In `apps/hub/src/adapters/store.ts` (3 of 3), replace:

```ts
      .map(r => ({ id: r.escalation_id as string, decision: JSON.parse(r.body as string) as unknown }));
  }
```

with:

```ts
      .map(r => ({ id: r.escalation_id as string, decision: JSON.parse(r.body as string) as unknown }));
  }

  // The manager's deliveries (fleet-clients §9.1, migration 16), written before the fleet is asked, so a hub that stops
  // then still follows what it may have queued. NORMAL like every hub table (plan.md, Databases): a row a power loss
  // takes back is a delivery the hub stops following, which the node still delivers once. A second write of an id
  // changes nothing: the row of its first attempt stands.
  saveManagerDelivery(r: ManagerDeliveryRow) {
    // ON CONFLICT, not OR IGNORE: that would also swallow a CHECK on a kind or a state this table doesn't know.
    this.db.prepare(`INSERT INTO manager_deliveries (delivery_id, kind, escalation_id, ask, choice, endpoint_id, session_id, request_id, queued_at, state, updated_at)
      VALUES (@deliveryId, @kind, @escalationId, @ask, @choice, @endpointId, @sessionId, @requestId, @queuedAt, @state, @updatedAt)
      ON CONFLICT(delivery_id) DO NOTHING`).run(r);
  }
  managerDelivery(id: string): ManagerDeliveryRow | null {
    const r = this.db.prepare("SELECT * FROM manager_deliveries WHERE delivery_id = ?").get(id) as ManagerDeliverySql | undefined;
    return r ? managerDeliveryRow(r) : null;
  }
  // The latest delivery a request made (an answer, or a message).
  managerDeliveryOfRequest(endpointId: string, requestId: string): ManagerDeliveryRow | null {
    const r = this.db.prepare("SELECT * FROM manager_deliveries WHERE endpoint_id = ? AND request_id = ? ORDER BY queued_at DESC, delivery_id DESC LIMIT 1")
      .get(endpointId, requestId) as ManagerDeliverySql | undefined;
    return r ? managerDeliveryRow(r) : null;
  }
  // The delivery of the answer whose Decision was taken at `queuedAt`.
  answerDelivery(escalationId: string, queuedAt: number): ManagerDeliveryRow | null {
    const r = this.db.prepare("SELECT * FROM manager_deliveries WHERE kind = 'answer' AND escalation_id = ? AND queued_at = ? ORDER BY delivery_id DESC LIMIT 1")
      .get(escalationId, queuedAt) as ManagerDeliverySql | undefined;
    return r ? managerDeliveryRow(r) : null;
  }
  // Every delivery under one key: the key itself, then "<key>~2", "<key>~3" … (manager-queue.ts idFor), oldest first.
  // SQLite's substr counts characters, so the prefix is counted in code points.
  managerDeliveryAttempts(base: string): ManagerDeliveryRow[] {
    const again = `${base}~`;
    return (this.db.prepare("SELECT * FROM manager_deliveries WHERE delivery_id = ? OR substr(delivery_id, 1, ?) = ? ORDER BY queued_at, delivery_id")
      // oxlint-disable-next-line typescript/no-misused-spread -- code points on purpose: SQLite's substr counts them (above)
      .all(base, [...again].length, again) as ManagerDeliverySql[]).map(managerDeliveryRow);
  }
  // Every delivery whose id starts with `prefix` (the answers to one ask: "hub:answer:<id>:<ask>:"), oldest first.
  managerDeliveriesWithPrefix(prefix: string): ManagerDeliveryRow[] {
    return (this.db.prepare("SELECT * FROM manager_deliveries WHERE substr(delivery_id, 1, ?) = ? ORDER BY queued_at, delivery_id")
      // oxlint-disable-next-line typescript/no-misused-spread -- code points on purpose: SQLite's substr counts them (above)
      .all([...prefix].length, prefix) as ManagerDeliverySql[]).map(managerDeliveryRow);
  }
  // The deliveries not final yet: still to be followed.
  openManagerDeliveries(): ManagerDeliveryRow[] {
    return (this.db.prepare(`SELECT * FROM manager_deliveries WHERE state IN ${OPEN_STATES} ORDER BY queued_at, delivery_id`).all() as ManagerDeliverySql[])
      .map(managerDeliveryRow);
  }
  // One device's messages to the manager changed since `since`, oldest first.
  commandDeliveriesOf(endpointId: string, since: number): ManagerDeliveryRow[] {
    return (this.db.prepare("SELECT * FROM manager_deliveries WHERE kind = 'command' AND endpoint_id = ? AND updated_at >= ? ORDER BY queued_at, delivery_id")
      .all(endpointId, since) as ManagerDeliverySql[]).map(managerDeliveryRow);
  }
  setManagerDeliveryState(id: string, state: ManagerDeliveryState, at: number) {
    this.db.prepare("UPDATE manager_deliveries SET state = ?, updated_at = ? WHERE delivery_id = ?").run(state, at, id);
  }
  dropManagerDelivery(id: string) { this.db.prepare("DELETE FROM manager_deliveries WHERE delivery_id = ?").run(id); }
  // Rows last changed before `before` (the node keeps a final delivery 7 days, spec §4.3; the hub keeps its row as long).
  pruneManagerDeliveries(before: number): number {
    return this.db.prepare("DELETE FROM manager_deliveries WHERE updated_at < ?").run(before).changes;
  }
```

#29's test of migration 15 migrated "to the latest"; it now names 15 (the test of migration 16 is the one above):

In `apps/hub/test/migrations.test.ts`, replace:

```ts
    expect(tables(db)).not.toContain("pending_answers");
    expect(migrate(db)).toEqual({ from: 14, to: 15 });
    expect(tables(db)).toContain("pending_answers");
```

with:

```ts
    expect(tables(db)).not.toContain("pending_answers");
    expect(migrate(db, MIGRATIONS.slice(0, 15))).toEqual({ from: 14, to: 15 });
    expect(tables(db)).toContain("pending_answers");
```

- [ ] **Step 12.19: Run it and see it pass**

Run: `npx vitest run apps/hub/test/manager-deliveries-store.test.ts apps/hub/test/migrations.test.ts apps/hub/test/store-durability.test.ts`
Expected: PASS, every test.

- [ ] **Step 12.20: Commit**

```bash
git add apps/hub/src/adapters/migrations.ts apps/hub/src/adapters/store.ts apps/hub/test/manager-deliveries-store.test.ts apps/hub/test/migrations.test.ts
```

```bash
git commit -m "feat(hub): migration 16, the manager's deliveries in the fleet's queue"
```

- [ ] **Step 12.21: Write the failing config test**

Create `apps/hub/test/config-manager-queue.test.ts`:

```ts
// MORNDO_MANAGER_QUEUE (fleet-clients §9.1, plan.md Config): with a fleet, the manager's answers and messages go through
// the fleet's delivery queue unless it says "off" or "0"; without a fleet there is no queue, whatever it says. It is the
// only switch: #29's MORNDO_MANAGER_INBOX is gone (ruling 81), and set, it changes nothing.
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const FLEET = { MORNDO_FLEET_SOCKET: "/home/o/.local/state/morndo-fleet/fleet.sock" };

describe("MORNDO_MANAGER_QUEUE", () => {
  it("on by default with a fleet", () => {
    expect(loadConfig(FLEET).managerQueue).toBe(true);
    expect(loadConfig({ ...FLEET, MORNDO_MANAGER_QUEUE: "" }).managerQueue).toBe(true);
    expect(loadConfig({ ...FLEET, MORNDO_MANAGER_QUEUE: "on" }).managerQueue).toBe(true);
  });
  it("off and 0 turn it off, in any case (the rollback of step 2, spec §13)", () => {
    for (const off of ["off", "0", "OFF", "Off"]) expect(loadConfig({ ...FLEET, MORNDO_MANAGER_QUEUE: off }).managerQueue, off).toBe(false);
  });
  it("the only switch: MORNDO_MANAGER_INBOX, set, changes nothing either way (ruling 81)", () => {
    expect(loadConfig({ ...FLEET, MORNDO_MANAGER_INBOX: "/home/o/kira/inbox" }).managerQueue).toBe(true);
    expect(loadConfig({ ...FLEET, MORNDO_MANAGER_INBOX: "/home/o/kira/inbox", MORNDO_MANAGER_QUEUE: "off" }).managerQueue).toBe(false);
  });
  it("without a fleet there is no queue, whatever it says (negative control)", () => {
    expect(loadConfig({}).managerQueue).toBe(false);
    expect(loadConfig({ MORNDO_MANAGER_QUEUE: "on" }).managerQueue).toBe(false);
  });
});
```

- [ ] **Step 12.22: Run it and see it fail**

Run: `npx vitest run apps/hub/test/config-manager-queue.test.ts`
Expected: FAIL, 4 of 4: `AssertionError: expected undefined to be true` (twice), `AssertionError: off: expected undefined to be false`, `AssertionError: expected undefined to be false`.

- [ ] **Step 12.23: Implement `MORNDO_MANAGER_QUEUE`, the only switch**

In `apps/hub/src/config.ts` (1 of 2), replace:

```ts
  fleetSocket?: string | null;
  // MORNDO_ENGINE_SESSIONS: the engine-lane registry directory on this machine. Unset, empty, `0` or `off`: the hub
```

with:

```ts
  fleetSocket?: string | null;
  // MORNDO_MANAGER_QUEUE (fleet-clients §9.1): the manager's answers and messages through the fleet's delivery queue. On
  // by default with a fleet; "off" or "0" types them directly, as before (step 2's rollback, §13). Never without a fleet.
  managerQueue?: boolean;
  // MORNDO_ENGINE_SESSIONS: the engine-lane registry directory on this machine. Unset, empty, `0` or `off`: the hub
```

In `apps/hub/src/config.ts` (2 of 2), replace:

```ts
    fleetSocket: fleetSocket(env),
    engineSessions: engineSessions(env),
```

with:

```ts
    fleetSocket: fleetSocket(env),
    managerQueue: fleetSocket(env) !== null && !/^(off|0)$/i.test(env.MORNDO_MANAGER_QUEUE ?? ""),
    engineSessions: engineSessions(env),
```

- [ ] **Step 12.24: Run it and see it pass**

Run: `npx vitest run apps/hub/test/config-manager-queue.test.ts apps/hub/test/no-manager-inbox.test.ts apps/hub/test/config-fleet.test.ts`
Expected: PASS, every test.

- [ ] **Step 12.25: Commit**

```bash
git add apps/hub/src/config.ts apps/hub/test/config-manager-queue.test.ts
```

```bash
git commit -m "feat(hub): MORNDO_MANAGER_QUEUE, on by default with a fleet"
```

- [ ] **Step 12.26: Give the fake fleet deliveries**

This is test infrastructure: Steps 12.27 to 12.56 and Task 14 use it. It keeps each delivery and never types it; a test moves one on as a node's deliverer would (`moveDelivery`), and every subscriber hears each change as a `delivery` event. It also answers `pane.capture` and `pane.keys` by name, reports each pane's session `status`, `pid`, `topic` and `lastPrompt`, keeps lane events, and lists `stickyLanes` in `GET /v1/caps`. Its delivery routes answer as ruling 3 says: a refusal is 200 `{ ok: false, error }` (executed "no"); `GET /v1/deliveries/<id>` and a cancel of an id it doesn't know are 404 `{ error: "no_such_delivery" }` (part 03: "a cancel of an id the fleet doesn't know is 404"); the list is the newest 1000 of the last 7 days.

The blocks apply after Task 1's and Task 2's lines in this file (part 01: `status: null, pid: s?.pid ?? null,` in the inventory, `status: null` in `byPane`), and replace them with the backend's values.

In `apps/hub/test/helpers/fake-fleet.ts` (1 of 18), replace:

```ts
// on the owner), and routing by a name in conflict is lane_conflict. A test can take a node offline, announce an
// inventory, and put itself in front of any op (to drop an answer after the paste, say). Synthetic data only.
import { randomUUID } from "node:crypto";
```

with:

```ts
// on the owner), and routing by a name in conflict is lane_conflict. A test can take a node offline, announce an
// inventory, and put itself in front of any op (to drop an answer after the paste, say). Deliveries (fleet-clients §4,
// §8): the fleet keeps each one and never types it; a test moves it on as a node's deliverer would (moveDelivery), and
// every subscriber hears each change as a `delivery` event. Synthetic data only.
import { randomUUID } from "node:crypto";
```

In `apps/hub/test/helpers/fake-fleet.ts` (2 of 18), replace:

```ts
import { WebSocketServer, type WebSocket } from "ws";
import { CLIENT_API, ERROR_EXECUTED, LIMITS, formatWorkerId, parseWorkerId, type Alert, type ErrorCode, type OpError, type Pane } from "@morndo/protocol";
import type { SendProblem, SessionInfo, Terminal } from "@morndo/node-ops";
```

with:

```ts
import { WebSocketServer, type WebSocket } from "ws";
import {
  CLIENT_API, ERROR_EXECUTED, LIMITS, formatWorkerId, parseWorkerId,
  type Alert, type Delivery, type ErrorCode, type LaneEvent, type OpError, type Pane, type SessionStatus,
} from "@morndo/protocol";
import type { SendProblem, SessionInfo, Terminal } from "@morndo/node-ops";
```

In `apps/hub/test/helpers/fake-fleet.ts` (3 of 18), replace:

```ts
  inboxDir?: string;
};
```

with:

```ts
  inboxDir?: string;
  keyNames?: (pane: string, names: string[]) => Promise<boolean>;      // pane.keys by key name (fleet-clients §5)
  // The session's title and last prompt (its transcript's `ai-title` and `last-prompt`; reconciliation ruling 13).
  topicOf?: (pane: string) => { topic?: string; lastPrompt?: string } | undefined;
};
```

In `apps/hub/test/helpers/fake-fleet.ts` (4 of 18), replace:

```ts
      const s = sessions.get(w.id);
      return [{
```

with:

```ts
      const s = sessions.get(w.id);
      const t = b.topicOf?.(w.id);
      return [{
```

In `apps/hub/test/helpers/fake-fleet.ts` (5 of 18), replace:

```ts
        ...(s ? { sessionId: s.sessionId } : {}), ...(s?.name ? { sessionName: s.name } : {}), ...(s?.version ? { claudeVersion: s.version } : {}),
        status: null, pid: s?.pid ?? null,
      }];
```

with:

```ts
        ...(s ? { sessionId: s.sessionId } : {}), ...(s?.name ? { sessionName: s.name } : {}), ...(s?.version ? { claudeVersion: s.version } : {}),
        status: s?.status ?? null, pid: s ? s.pid : null,
        ...(t?.topic !== undefined ? { topic: t.topic } : {}), ...(t?.lastPrompt !== undefined ? { lastPrompt: t.lastPrompt } : {}),
      }];
```

In `apps/hub/test/helpers/fake-fleet.ts` (6 of 18), replace:

```ts
        if (p === null) return refusal("no_pane");
        return ok({ ok: b.terminal ? await b.terminal.keys(p, str("data")) : false });
      }
```

with:

```ts
        if (p === null) return refusal("no_pane");
        if (Array.isArray(a.names)) return ok({ ok: b.keyNames ? await b.keyNames(p, a.names.filter((x): x is string => typeof x === "string")) : false });
        return ok({ ok: b.terminal ? await b.terminal.keys(p, str("data")) : false });
      }
      case "pane.capture": {
        const p = paneOf(str("workerId"));
        const screen = p === null ? null : await b.tmux.capture(p);
        return ok({ text: screen === null ? null : screen.split("\n").slice(-Math.max(1, num("lines"))).join("\n"), truncated: false });
      }
```

In `apps/hub/test/helpers/fake-fleet.ts` (7 of 18), replace:

```ts
// the paste, or "not_submitted" after it). `hold()` makes the next send wait in the pane after its paste until released.
export type MemoryPane = { name: string; cwd: string; screen: string; sessionId?: string; problem?: SendProblem | null };
export type MemoryBackend = NodeBackend & {
```

with:

```ts
// the paste, or "not_submitted" after it). `hold()` makes the next send wait in the pane after its paste until released.
export type MemoryPane = {
  name: string; cwd: string; screen: string; sessionId?: string; problem?: SendProblem | null;
  status?: SessionStatus; pid?: number;                    // its session's, with a session (default "idle", 1)
  topic?: string; lastPrompt?: string;                      // its session's title and last prompt
};
export type MemoryBackend = NodeBackend & {
```

In `apps/hub/test/helpers/fake-fleet.ts` (8 of 18), replace:

```ts
  keysTyped: { pane: string; data: string }[];
  typedAt: number | null;                                   // the node's clock for typedAt; null: Date.now()
```

with:

```ts
  keysTyped: { pane: string; data: string }[];
  keyNamesTyped: { pane: string; names: string[] }[];
  typedAt: number | null;                                   // the node's clock for typedAt; null: Date.now()
```

In `apps/hub/test/helpers/fake-fleet.ts` (9 of 18), replace:

```ts
  const b: MemoryBackend = {
    panes, typed: [], keysTyped: [], typedAt: null,
    hold() {
```

with:

```ts
  const b: MemoryBackend = {
    panes, typed: [], keysTyped: [], keyNamesTyped: [], typedAt: null,
    hold() {
```

In `apps/hub/test/helpers/fake-fleet.ts` (10 of 18), replace:

```ts
    },
    sessions: {
```

with:

```ts
    },
    topicOf: id => {
      const p = b.panes[id];
      return p ? { ...(p.topic !== undefined ? { topic: p.topic } : {}), ...(p.lastPrompt !== undefined ? { lastPrompt: p.lastPrompt } : {}) } : undefined;
    },
    keyNames: async (id, names) => {
      if (!b.panes[id]) return false;
      b.keyNamesTyped.push({ pane: id, names });
      return true;
    },
    sessions: {
```

In `apps/hub/test/helpers/fake-fleet.ts` (11 of 18), replace:

```ts
        for (const [id, p] of Object.entries(b.panes)) {
          if (p.sessionId !== undefined) out.set(id, { sessionId: p.sessionId, name: null, pane: id, cwd: p.cwd, version: null, pid: 1, status: null });
        }
```

with:

```ts
        for (const [id, p] of Object.entries(b.panes)) {
          if (p.sessionId !== undefined) out.set(id, { sessionId: p.sessionId, name: null, pane: id, cwd: p.cwd, version: null, pid: p.pid ?? 1, status: p.status ?? "idle" });
        }
```

In `apps/hub/test/helpers/fake-fleet.ts` (12 of 18), replace:

```ts
  intercept(op: string, f: Intercept | null): void;
  close(): Promise<void>;
```

with:

```ts
  intercept(op: string, f: Intercept | null): void;
  // Deliveries (fleet-clients §4, §8): what each one is and carries, every POST /v1/deliveries in order, every cancel.
  readonly deliveries: ReadonlyMap<string, { delivery: Delivery; text: string }>;
  readonly deliveryCalls: { id: string; lane: string | null; workerId: string | null; text: string }[];
  readonly cancels: string[];
  moveDelivery(id: string, change: Partial<Delivery>): Delivery;   // as the node's deliverer would; a `delivery` event
  quietDeliveries(quiet: boolean): void;                    // true: no `delivery` events (one sent while unsubscribed)
  loseDeliveryAnswers(n: number): void;                     // the next n deliveries are stored, and their answer lost
  laneEvent(e: LaneEvent): void;                            // kept for GET /v1/lane-events, and sent as a `lane` event
  close(): Promise<void>;
```

In `apps/hub/test/helpers/fake-fleet.ts` (13 of 18), replace:

```ts

export async function startFakeFleet(o: { nodes: FakeNode[]; api?: number[]; socketPath?: string }): Promise<FakeFleet> {
  const dir = o.socketPath === undefined ? mkdtempSync(join(tmpdir(), "mf-")) : null;
```

with:

```ts

// `stickyLanes`: the fleet's sticky lane names (default ["manager"]), which GET /v1/caps lists (fleet-clients §4.6, §8).
export async function startFakeFleet(o: { nodes: FakeNode[]; api?: number[]; socketPath?: string; stickyLanes?: string[] }): Promise<FakeFleet> {
  const dir = o.socketPath === undefined ? mkdtempSync(join(tmpdir(), "mf-")) : null;
```

In `apps/hub/test/helpers/fake-fleet.ts` (14 of 18), replace:

```ts
  const alerts: Alert[] = [];

```

with:

```ts
  const alerts: Alert[] = [];
  const sticky = o.stickyLanes ?? ["manager"];
  const lastNodeOf = new Map<string, string>();             // a sticky name → the node that last had it (spec §4.6)

```

In `apps/hub/test/helpers/fake-fleet.ts` (15 of 18), replace:

```ts
      owners.set(name, owner);
      const owned = mine.filter(c => c.node === owner);
```

with:

```ts
      owners.set(name, owner);
      if (sticky.includes(name)) lastNodeOf.set(name, owner);
      const owned = mine.filter(c => c.node === owner);
```

In `apps/hub/test/helpers/fake-fleet.ts` (16 of 18), replace:

```ts

  async function handle(req: IncomingMessage, res: ServerResponse) {
```

with:

```ts

  // Deliveries (fleet-clients §4, §8; plan.md Contracts, "Client API routes"; reconciliation ruling 3): stored here, never
  // typed. A delivery to a sticky name whose window is gone goes to the node that last had it. A refusal is 200
  // { ok: false, error } (the client API's mapping for op refusals); an id the fleet doesn't know is 404 no_such_delivery.
  const deliveries = new Map<string, { delivery: Delivery; text: string }>();
  const deliveryCalls: { id: string; lane: string | null; workerId: string | null; text: string }[] = [];
  const cancels: string[] = [];
  const laneEvents: LaneEvent[] = [];
  let quiet = false;
  let lose = 0;
  const stale = (d: Delivery) => status.get(d.node) !== "online";
  const deliveryEvent = (d: Delivery) => { if (!quiet) broadcast({ t: "delivery", node: d.node, body: { ...d, stale: stale(d) } }); };
  const refused = (code: ErrorCode, message: string = code) => ({ status: 200, body: { ok: false, error: { code, executed: ERROR_EXECUTED[code], message } } });
  const unknownDelivery = { status: 404, body: { error: "no_such_delivery" } };
  const withoutWaiting = (d: Delivery): Delivery => { const { waiting: _w, ...rest } = d; return rest; };
  // null: stored, and its answer is to be lost.
  async function deliver(b: Record<string, unknown>): Promise<{ status: number; body: unknown } | null> {
    const id = typeof b.id === "string" ? b.id : "";
    const text = typeof b.text === "string" ? b.text : "";
    const lane = typeof b.lane === "string" ? b.lane : null;
    const workerId = typeof b.workerId === "string" ? b.workerId : null;
    if (!/^[a-z]+:/.test(id) || id.length > LIMITS.maxDeliveryId || !text || text.length > LIMITS.maxSendText || (lane === null) === (workerId === null)) return refused("bad_args");
    deliveryCalls.push({ id, lane, workerId, text });
    const target = lane !== null ? { lane } : { workerId: workerId ?? "" };
    const known = deliveries.get(id);
    if (known) {
      const same = known.text === text && JSON.stringify(known.delivery.target) === JSON.stringify(target);
      return same ? { status: 200, body: { ok: true, delivery: known.delivery } } : refused("id_conflict", "this id names another delivery");
    }
    let node: string | null = null;
    if (lane !== null) {
      const row = (await lanes()).find(l => l.name === lane);
      if (row?.conflict) return refused("lane_conflict", "two windows claim this lane");
      node = row?.node ?? (sticky.includes(lane) ? lastNodeOf.get(lane) ?? null : null);
    } else node = parseWorkerId(workerId ?? "")?.node ?? null;
    if (node === null || !nodes.has(node)) return refused("no_pane", "no such lane");
    if (status.get(node) !== "online") return refused("node_offline", "the node is not online");
    const at = Date.now();
    const delivery: Delivery = { id, node, target, state: "queued", queuedAt: at, notAfter: at + (typeof b.ttlMs === "number" ? b.ttlMs : LIMITS.deliveryTtlMs) };
    deliveries.set(id, { delivery, text });
    deliveryEvent(delivery);
    if (lose > 0) { lose--; return null; }
    return { status: 200, body: { ok: true, delivery } };
  }
  function cancel(id: string): { status: number; body: unknown } {
    cancels.push(id);
    const d = deliveries.get(id);
    if (!d) return unknownDelivery;
    if (stale(d.delivery)) return refused("node_offline", "the node is not online");
    if (d.delivery.state !== "queued") return refused("already_typed", "it was typed already");
    d.delivery = { ...withoutWaiting(d.delivery), state: "given_up", why: "cancelled" };
    deliveryEvent(d.delivery);
    return { status: 200, body: { ok: true, delivery: d.delivery } };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
```

In `apps/hub/test/helpers/fake-fleet.ts` (17 of 18), replace:

```ts
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && url.pathname === "/v1/caps") return json(200, { api: o.api ?? [CLIENT_API] });
    if (req.method === "GET" && url.pathname === "/v1/nodes") {
```

with:

```ts
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const body = async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
    };
    if (req.method === "GET" && url.pathname === "/v1/caps") return json(200, { api: o.api ?? [CLIENT_API], stickyLanes: sticky });
    if (req.method === "POST" && url.pathname === "/v1/deliveries") {
      const r = await deliver(await body());
      // Stored, and the answer lost on its way: as a fleet that stops after it published the change (its event first).
      if (r === null) { setTimeout(() => req.socket.destroy(), 50); return; }
      return json(r.status, r.body);
    }
    if (req.method === "GET" && url.pathname === "/v1/deliveries") {
      const lane = url.searchParams.get("lane");
      const state = url.searchParams.get("state");
      const since = Date.now() - LIMITS.deliveryKeepMs;          // the newest 1000 of the last 7 days
      const all = [...deliveries.values()].map(d => d.delivery)
        .filter(d => d.queuedAt >= since && (lane === null || ("lane" in d.target && d.target.lane === lane)) && (state === null || d.state === state))
        .sort((a, b) => b.queuedAt - a.queuedAt).slice(0, 1000).reverse();   // the newest 1000, oldest first, as the real fleet answers
      return json(200, { deliveries: all.map(d => ({ ...d, stale: stale(d) })) });
    }
    const one = /^\/v1\/deliveries\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (one && req.method === "GET" && one[2] === undefined) {
      const d = deliveries.get(decodeURIComponent(one[1] ?? ""));
      return d ? json(200, { delivery: d.delivery, stale: stale(d.delivery) }) : json(unknownDelivery.status, unknownDelivery.body);
    }
    if (one && req.method === "POST" && one[2] !== undefined) {
      const r = cancel(decodeURIComponent(one[1] ?? ""));
      return json(r.status, r.body);
    }
    if (req.method === "GET" && url.pathname === "/v1/lane-events") {
      const since = Number(url.searchParams.get("since") ?? 0);
      return json(200, { events: laneEvents.filter(e => e.seq > since).slice(0, 1000) });
    }
    if (req.method === "GET" && url.pathname === "/v1/nodes") {
```

In `apps/hub/test/helpers/fake-fleet.ts` (18 of 18), replace:

```ts
    intercept(opName, f) { if (f) intercepts.set(opName, f); else intercepts.delete(opName); },
    async close() {
```

with:

```ts
    intercept(opName, f) { if (f) intercepts.set(opName, f); else intercepts.delete(opName); },
    deliveries, deliveryCalls, cancels,
    moveDelivery(id, change) {
      const d = deliveries.get(id);
      if (!d) throw new Error(`no delivery ${id}`);
      const moved = { ...d.delivery, ...change };
      d.delivery = change.state !== undefined && change.state !== "queued" && change.waiting === undefined ? withoutWaiting(moved) : moved;
      deliveryEvent(d.delivery);
      return d.delivery;
    },
    quietDeliveries(q) { quiet = q; },
    loseDeliveryAnswers(n) { lose = n; },
    laneEvent(e) { laneEvents.push(e); broadcast({ t: "lane", node: e.node, body: e }); },
    async close() {
```

Two tests read what the fake now reports (ruling 53): a session's status defaults to `"idle"` (it was `null`), and `GET /v1/caps` lists the default sticky lane `manager` (it listed none). Without these two changes they fail: `fleet-adapters.test.ts` "sessions come from the inventory …" with `AssertionError: expected [ [ 'pc.aaaaaaaa.1', …(1) ] ] to deeply equal [ [ 'pc.aaaaaaaa.1', …(1) ] ]`, and Task 3's `fleet-client.test.ts` "reads the capabilities, the nodes and the lanes" with `AssertionError: expected { api: [ 1 ], stickyLanes: [] } to deeply equal { api: [ 1 ], …(1) }`.

In `apps/hub/test/fleet-adapters.test.ts`, replace:

```ts
    await ports.tmux.listWorkers();
    expect([...(await ports.sessions.byPane())]).toEqual([[PC1, { sessionId: "s-alpha", name: null, pane: PC1, cwd: "/w/alpha", version: null, pid: 0, status: null }]]);
    expect(await ports.transcripts.size("s-alpha")).toBe(TRANSCRIPT.length);
```

with:

```ts
    await ports.tmux.listWorkers();
    expect([...(await ports.sessions.byPane())]).toEqual([[PC1, { sessionId: "s-alpha", name: null, pane: PC1, cwd: "/w/alpha", version: null, pid: 0, status: "idle" }]]);   // the fake fleet's session default (Step 12.21)
    expect(await ports.transcripts.size("s-alpha")).toBe(TRANSCRIPT.length);
```

In `packages/fleet-client/test/fleet-client.test.ts`, replace:

```ts
    const c = new FleetClient(fleet.socketPath);
    expect(await c.caps()).toEqual({ api: [1], stickyLanes: [] });                 // the fake fleet sends no sticky lanes
    expect(await checkFleet(c)).toBe("ok");
```

with:

```ts
    const c = new FleetClient(fleet.socketPath);
    expect(await c.caps()).toEqual({ api: [1], stickyLanes: ["manager"] });        // the fake fleet's default sticky lane (Task 12)
    expect(await checkFleet(c)).toBe("ok");
```

Run: `npx vitest run apps/hub/test/fleet-adapters.test.ts packages/fleet-client/test/fleet-client.test.ts apps/hub/test/fleet-steering.test.ts apps/hub/test/escalation-answer-keys.test.ts`
Expected: PASS, 4 files, 81 tests.

```bash
git add apps/hub/test/helpers/fake-fleet.ts apps/hub/test/fleet-adapters.test.ts packages/fleet-client/test/fleet-client.test.ts
```

```bash
git commit -m "test(hub): the fake fleet keeps deliveries, sticky names, captures, keys by name and lane events"
```

- [ ] **Step 12.27: Write the failing test of the hub's port onto the queue**

Create `apps/hub/test/fleet-deliveries.test.ts`:

```ts
// The hub's port onto the fleet's delivery queue (fleet-clients §4, §8, §9.1), over the fake fleet on a real Unix socket:
// a delivery queued, the same id again (its state now, nothing queued twice), the fleet's refusals (nothing queued),
// a fleet that can't be reached (node_offline: nothing queued, §10) and one that took it and never answered (in doubt),
// a delivery read back, cancelled, followed by its events, and the fleet's sticky names. Synthetic panes only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS, type Delivery } from "@morndo/protocol";
import { FleetClient } from "@morndo/fleet-client";
import { fleetDeliveries } from "../src/adapters/fleet-deliveries.ts";
import type { Deliveries } from "../src/application/ports.ts";
import { localNode, memoryBackend, startFakeFleet, until, type FakeFleet } from "./helpers/fake-fleet.ts";

let fleet: FakeFleet;
let port: Deliveries;
let stops: (() => void)[] = [];
const panes = () => ({ "%0": { name: "manager", cwd: "/w/manager", screen: "❯ ", sessionId: "s-manager" }, "%1": { name: "alpha", cwd: "/w/alpha", screen: "❯ " } });
beforeEach(async () => {
  fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", memoryBackend(panes()))] });
  port = fleetDeliveries(new FleetClient(fleet.socketPath));
});
afterEach(async () => { for (const s of stops.splice(0)) s(); await fleet.close(); });

describe("the fleet's delivery queue, as the hub's port", () => {
  it("queues a delivery to a lane by name; the same id again answers its state and queues nothing", async () => {
    const r = await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "status please" });
    expect(r).toMatchObject({ ok: true, delivery: { id: "hub:ep1:r1", node: "pc", target: { lane: "manager" }, state: "queued" } });
    fleet.moveDelivery("hub:ep1:r1", { state: "typed", typedAt: 5 });
    expect(await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "status please" })).toMatchObject({ ok: true, delivery: { state: "typed" } });
    expect(fleet.deliveries.size).toBe(1);
    expect(fleet.clients.every(c => c === "hub")).toBe(true);
  });

  it("asks for how long it may wait: the fleet's 24 hours, or the ttlMs it is given", async () => {
    const wait = (r: Awaited<ReturnType<Deliveries["deliver"]>>) => (r.ok ? r.delivery.notAfter - r.delivery.queuedAt : null);
    expect(wait(await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "now or tomorrow" }))).toBe(LIMITS.deliveryTtlMs);
    expect(wait(await port.deliver({ id: "hub:ep1:r2", lane: "manager", text: "within the hour", ttlMs: 3_600_000 }))).toBe(3_600_000);
  });

  it("the fleet's refusals queue nothing, and say so", async () => {
    await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "one" });
    expect(await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "another" })).toEqual({ ok: false, refused: "id_conflict" });
    expect(await port.deliver({ id: "hub:ep1:r2", lane: "nobody", text: "x" })).toEqual({ ok: false, refused: "no_pane" });
    await fleet.setStatus("pc", "offline");
    expect(await port.deliver({ id: "hub:ep1:r3", lane: "manager", text: "x" })).toEqual({ ok: false, refused: "node_offline" });
    expect(fleet.deliveries.size).toBe(1);
  });

  it("a fleet that can't be reached is node_offline (nothing queued); one that took it and never answered is in doubt", async () => {
    fleet.loseDeliveryAnswers(1);
    expect(await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "lost" })).toEqual({ ok: false, inDoubt: true });
    expect(fleet.deliveries.has("hub:ep1:r1")).toBe(true);                          // it was queued after all
    await fleet.close();
    expect(await port.deliver({ id: "hub:ep1:r2", lane: "manager", text: "x" })).toEqual({ ok: false, refused: "node_offline" });
    expect(await port.get("hub:ep1:r1")).toBe("unavailable");
    expect(await port.stickyLanes()).toBeNull();
    fleet = await startFakeFleet({ nodes: [] });                                     // for afterEach
  });

  it("reads a delivery back, or null for one the fleet doesn't know (negative control)", async () => {
    await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "x" });
    fleet.moveDelivery("hub:ep1:r1", { state: "queued", waiting: { reason: "menu_open", since: 7 } });
    expect(await port.get("hub:ep1:r1")).toMatchObject({ id: "hub:ep1:r1", state: "queued", waiting: { reason: "menu_open" } });
    expect(await port.get("hub:ep1:nope")).toBeNull();
  });

  it("cancels a queued delivery; one typed already is refused already_typed; one the fleet doesn't know is unknown (ruling 56)", async () => {
    await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "x" });
    await port.deliver({ id: "hub:ep1:r2", lane: "manager", text: "y" });
    fleet.moveDelivery("hub:ep1:r2", { state: "typed", typedAt: 5 });
    expect(await port.cancel("hub:ep1:r1")).toMatchObject({ ok: true, delivery: { state: "given_up", why: "cancelled" } });
    expect(await port.cancel("hub:ep1:r2")).toEqual({ ok: false, refused: "already_typed" });
    expect(await port.cancel("hub:ep1:nope")).toEqual({ ok: false, unknown: true });
  });

  it("follows each delivery's changes as events, and says when its subscription opens", async () => {
    const seen: Delivery[] = [];
    let opened = 0;
    stops.push(port.subscribe(d => seen.push(d), () => { opened++; }));
    await until(() => opened === 1);
    await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "x" });
    fleet.moveDelivery("hub:ep1:r1", { state: "delivered", deliveredAt: 9 });
    await until(() => seen.some(d => d.state === "delivered"));
    expect(seen.map(d => d.state)).toEqual(["queued", "delivered"]);
  });

  it("names the fleet's sticky lanes", async () => {
    expect(await port.stickyLanes()).toEqual(["manager"]);
  });
});
```

- [ ] **Step 12.28: Run it and see it fail**

Run: `npx vitest run apps/hub/test/fleet-deliveries.test.ts`
Expected: FAIL: `Error: Cannot find module '../src/adapters/fleet-deliveries.ts' imported from …/apps/hub/test/fleet-deliveries.test.ts`; no tests run.

- [ ] **Step 12.29: Implement the port and its fleet adapter**

In `apps/hub/src/application/ports.ts` (1 of 2), replace:

```ts
import type { Frame, SendProblem, SessionInfo, Terminal as PaneTerminal } from "@morndo/node-ops";
import type { ErrorCode } from "@morndo/protocol";

```

with:

```ts
import type { Frame, SendProblem, SessionInfo, Terminal as PaneTerminal } from "@morndo/node-ops";
import type { Delivery, ErrorCode } from "@morndo/protocol";

```

In `apps/hub/src/application/ports.ts` (2 of 2), replace:

```ts
  files: RemoteFiles; uploads: UploadSink; sendStatus: SendStatus | null; nodeStates: NodeStates | null;
};
```

with:

```ts
  files: RemoteFiles; uploads: UploadSink; sendStatus: SendStatus | null; nodeStates: NodeStates | null;
};

// The fleet's delivery queue (fleet-clients §4, §8; ADR-0014), as the hub uses it for the manager (§9.1). Fleet only.
// `refused`: nothing was queued (the fleet's or the node's code, executed "no"; "node_offline" when the request never
// reached the fleet, §10). `inDoubt`: the fleet took the request and never answered, so it may have been queued.
export type DeliverAnswer = { ok: true; delivery: Delivery } | { ok: false; refused: ErrorCode } | { ok: false; inDoubt: true };
// A cancel's answer, or `unknown`: the fleet has no delivery of that id (404 no_such_delivery; ruling 56).
export type CancelAnswer = DeliverAnswer | { ok: false; unknown: true };
export type Deliveries = {
  // ttlMs: how long it may wait to be typed (the fleet's own 24 hours when absent, LIMITS.deliveryTtlMs).
  deliver(d: { id: string; lane: string; text: string; ttlMs?: number }): Promise<DeliverAnswer>;
  cancel(id: string): Promise<CancelAnswer>;
  get(id: string): Promise<Delivery | null | "unavailable">;          // null: the fleet knows no such delivery
  subscribe(on: (d: Delivery) => void, onOpen: () => void): () => void;
  stickyLanes(): Promise<string[] | null>;                              // null: the fleet can't be asked now
};
```

Create `apps/hub/src/adapters/fleet-deliveries.ts`:

```ts
// The hub's port onto the fleet's delivery queue (fleet-clients §4, §8, §9.1; ADR-0014), over @morndo/fleet-client.
// - A refusal (FleetOpFailed with executed "no") queued nothing: its code. One with executed "maybe" is in doubt.
// - A request that never reached the fleet (FleetUnavailable, reached false: no socket, refused) queued nothing either:
//   "node_offline", as the fleet's own refusal while a node is away reads (spec §10: "new ones are refused").
// - One the fleet took and never answered (FleetUnavailable reached, or an answer that isn't the client API's) may have
//   been queued: in doubt. The same id again (spec §4.1) answers what became of it.
// - A cancel of an id the fleet doesn't know (cancelDelivery's null, its 404; ruling 56) is `unknown`, nothing in doubt.
// - Events: the fleet's `delivery` messages, each the latest state of one delivery (spec §4.4); `onOpen` after every
//   (re)subscription, since one sent meanwhile isn't replayed.
import { FleetMismatch, FleetOpFailed, FleetUnavailable, type FleetClient } from "@morndo/fleet-client";
import type { Delivery } from "@morndo/protocol";
import type { CancelAnswer, DeliverAnswer, Deliveries } from "../application/ports.ts";

const STATES = new Set<string>(["queued", "typed", "held", "delivered", "uncertain", "given_up"]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// A delivery's shape, as far as the hub reads it; anything else in an event is never guessed at.
export const isDelivery = (v: unknown): v is Delivery =>
  isRecord(v) && typeof v.id === "string" && typeof v.node === "string" && typeof v.state === "string" && STATES.has(v.state)
  && typeof v.queuedAt === "number" && typeof v.notAfter === "number";

// What a deliver's or a cancel's failure says: refused (nothing happened), or in doubt.
function failed(e: unknown): DeliverAnswer {
  if (e instanceof FleetOpFailed) return e.error.executed === "no" ? { ok: false, refused: e.error.code } : { ok: false, inDoubt: true };
  if (e instanceof FleetUnavailable) return e.reached ? { ok: false, inDoubt: true } : { ok: false, refused: "node_offline" };
  if (e instanceof FleetMismatch) return { ok: false, inDoubt: true };
  throw e;
}
const answered = (d: unknown): DeliverAnswer => (isDelivery(d) ? { ok: true, delivery: d } : { ok: false, inDoubt: true });

export function fleetDeliveries(client: FleetClient): Deliveries {
  return {
    async deliver(d) {
      try { return answered(await client.deliver({ id: d.id, lane: d.lane, text: d.text, ...(d.ttlMs === undefined ? {} : { ttlMs: d.ttlMs }) })); }
      catch (e) { return failed(e); }
    },
    async cancel(id): Promise<CancelAnswer> {
      try {
        const d = await client.cancelDelivery(id);
        return d === null ? { ok: false, unknown: true } : answered(d);
      } catch (e) { return failed(e); }
    },
    async get(id) {
      try {
        const d = await client.delivery(id);
        return d === null ? null : isDelivery(d) ? d : "unavailable";
      } catch { return "unavailable"; }
    },
    subscribe(on, onOpen) {
      return client.events(e => { if (e.t === "delivery" && isDelivery(e.body)) on(e.body); }, { onOpen });
    },
    async stickyLanes() {
      try { return (await client.caps()).stickyLanes; } catch { return null; }
    },
  };
}
```

- [ ] **Step 12.30: Run it and see it pass**

Run: `npx vitest run apps/hub/test/fleet-deliveries.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 12.31: Commit**

```bash
git add apps/hub/src/application/ports.ts apps/hub/src/adapters/fleet-deliveries.ts apps/hub/test/fleet-deliveries.test.ts
```

```bash
git commit -m "feat(hub): the port onto the fleet's delivery queue"
```

- [ ] **Step 12.32: Write the failing test of the manager's queue**

Create `apps/hub/test/manager-queue.test.ts`:

```ts
// The manager's deliveries (fleet-clients §9.1): each one's row written before the fleet is asked, then followed to its
// end from the fleet's events and by asking (an event sent while the hub wasn't listening isn't replayed), across hub
// restarts; each change heard once, with the row's new state in the same transaction. The switch off cancels what is
// still queued first and follows the rest; and the hub says once, at start, when the fleet's sticky names don't include
// the manager's window (plan.md Review Focus 5). Over the fake fleet on a real Unix socket and a real Store.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetClient } from "@morndo/fleet-client";
import { Store } from "../src/adapters/store.ts";
import { log } from "../src/adapters/log.ts";
import { fleetDeliveries } from "../src/adapters/fleet-deliveries.ts";
import { ManagerQueue, type NewDelivery, type QueueChange } from "../src/application/manager-queue.ts";
import { localNode, memoryBackend, startFakeFleet, until, type FakeFleet } from "./helpers/fake-fleet.ts";

const T0 = Date.UTC(2026, 9, 8, 9);
let dir: string;
let store: Store;
let fleet: FakeFleet;
let queues: ManagerQueue[] = [];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-manager-queue-"));
  store = new Store(dir);
  fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", memoryBackend({ "%0": { name: "manager", cwd: "/w/m", screen: "❯ ", sessionId: "s-m" } }))] });
});
afterEach(async () => {
  for (const q of queues.splice(0)) q.stop();
  vi.restoreAllMocks();
  await fleet.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// A queue as main.ts builds one; `heard` collects every change its listeners hear.
function queue(o: { on?: boolean; lane?: string; pollMs?: number } = {}) {
  const q = new ManagerQueue({ store, deliveries: fleetDeliveries(new FleetClient(fleet.socketPath)), lane: o.lane ?? "manager", on: o.on ?? true, now: () => T0, pollMs: o.pollMs ?? 60_000 });
  const heard: QueueChange[] = [];
  q.subscribe(c => { heard.push(c); });
  queues.push(q);
  return { q, heard };
}
const command = (request: string): NewDelivery => ({
  deliveryId: `hub:ep1:${request}`, kind: "command", escalationId: null, ask: null, choice: null, endpointId: "ep1", sessionId: "s1", requestId: request, queuedAt: T0,
});
const states = (heard: QueueChange[]) => heard.map(c => c.view.state);

describe("putting a delivery", () => {
  it("writes its row, asks the fleet, and keeps the fleet's state; the same id again queues nothing", async () => {
    const { q } = queue();
    const r = await q.put(command("r1"), "status please");
    expect(r).toMatchObject({ ok: true, row: { deliveryId: "hub:ep1:r1", state: "queued" }, view: { state: "queued", reason: null } });
    expect(fleet.deliveryCalls).toEqual([{ id: "hub:ep1:r1", lane: "manager", workerId: null, text: "status please" }]);
    expect(await q.put(command("r1"), "status please")).toMatchObject({ ok: true });
    expect(fleet.deliveries.size).toBe(1);
  });

  it("waits as long as it is told (a message's 24 hours from when it was written), else the fleet's 24 hours", async () => {
    const { q } = queue();
    await q.put(command("r1"), "now");
    await q.put(command("r2"), "written an hour ago", 23 * 3_600_000);
    const wait = (id: string) => { const d = fleet.deliveries.get(id)?.delivery; return d ? d.notAfter - d.queuedAt : null; };
    expect([wait("hub:ep1:r1"), wait("hub:ep1:r2")]).toEqual([24 * 3_600_000, 23 * 3_600_000]);
  });

  it("a refusal queues nothing and leaves no row", async () => {
    const { q } = queue();
    await q.put(command("r0"), "the fleet now knows the manager's node");
    await fleet.setStatus("pc", "offline");
    expect(await q.put(command("r1"), "x")).toEqual({ ok: false, problem: "node_offline" });
    expect(store.managerDelivery("hub:ep1:r1")).toBeNull();
  });

  it("an answer lost after the fleet stored it: uncertain, its row kept 'sending'; the same id again finds it, once", async () => {
    const { q } = queue();
    fleet.loseDeliveryAnswers(1);
    expect(await q.put(command("r1"), "x")).toEqual({ ok: false, problem: "uncertain" });
    expect(store.managerDelivery("hub:ep1:r1")?.state).toBe("sending");
    expect(await q.put(command("r1"), "x")).toMatchObject({ ok: true, row: { state: "queued" } });
    expect(fleet.deliveries.size).toBe(1);
  });

  it("an answer lost, but the fleet's event said it is queued: it is", async () => {
    const { q } = queue();
    await q.start();
    fleet.loseDeliveryAnswers(1);
    expect(await q.put(command("r1"), "x")).toMatchObject({ ok: true, row: { state: "queued" }, view: { state: "queued" } });
  });

  it("a row kept from an earlier attempt stays when a later one is refused: it may be queued (negative control)", async () => {
    const { q } = queue();
    fleet.loseDeliveryAnswers(1);
    await q.put(command("r1"), "x");
    await fleet.close();                                                    // the repeat never reaches the fleet
    expect(await q.put(command("r1"), "x")).toEqual({ ok: false, problem: "node_offline" });
    expect(store.managerDelivery("hub:ep1:r1")?.state).toBe("sending");
    fleet = await startFakeFleet({ nodes: [] });                             // for afterEach
  });
});

describe("following deliveries", () => {
  it("hears each change once, from the fleet's events, and keeps the row's state", async () => {
    const { q, heard } = queue();
    await q.start();
    await q.put(command("r1"), "x");
    fleet.moveDelivery("hub:ep1:r1", { waiting: { reason: "menu_open", since: T0 } });
    await until(() => heard.some(c => c.view.reason === "menu_open"));
    fleet.moveDelivery("hub:ep1:r1", { state: "typed", typedAt: T0 + 5 });
    fleet.moveDelivery("hub:ep1:r1", { state: "delivered", deliveredAt: T0 + 9 });
    await until(() => heard.some(c => c.view.state === "delivered"));
    // The fleet's event of its queueing may come before the answer to put(): heard as any change.
    expect(heard.map(c => [c.view.state, c.view.reason]).filter(([s, r]) => s !== "queued" || r !== null))
      .toEqual([["queued", "menu_open"], ["typed", null], ["delivered", null]]);
    expect(heard.at(-1)?.view.at).toBe(T0 + 9);
    expect(store.managerDelivery("hub:ep1:r1")?.state).toBe("delivered");
    const count = heard.length;
    await q.poll();                                                          // asked again: nothing new to hear
    expect(heard).toHaveLength(count);
  });

  it("an event missed (sent while the hub wasn't listening) is found by asking", async () => {
    const { q, heard } = queue({ pollMs: 50 });
    await q.start();
    await q.put(command("r1"), "x");
    fleet.quietDeliveries(true);
    fleet.moveDelivery("hub:ep1:r1", { state: "delivered", deliveredAt: T0 + 9 });
    await until(() => heard.some(c => c.view.state === "delivered"));
    expect(heard.at(-1)?.view).toMatchObject({ state: "delivered", at: T0 + 9 });
  });

  it("an older word never moves a delivery back (negative control)", async () => {
    const { q, heard } = queue();
    await q.start();
    await q.put(command("r1"), "x");
    fleet.moveDelivery("hub:ep1:r1", { state: "delivered", deliveredAt: T0 + 9 });
    await until(() => heard.some(c => c.view.state === "delivered"));
    fleet.moveDelivery("hub:ep1:r1", { state: "typed", typedAt: T0 + 5 });  // a stale event, after the final one
    await new Promise(r => setTimeout(r, 100));
    expect(states(heard).filter(s => s !== "queued")).toEqual(["delivered"]);
    expect(store.managerDelivery("hub:ep1:r1")?.state).toBe("delivered");
  });

  it("a listener that fails leaves the row as it was, and the next round hears it again", async () => {
    const { q } = queue();
    let fail = true;
    const heard: string[] = [];
    q.subscribe(c => { if (fail) throw new Error("the board's store is busy"); heard.push(c.view.state); });
    vi.spyOn(log, "error").mockImplementation(() => {});
    await q.put(command("r1"), "x");
    fleet.quietDeliveries(true);
    fleet.moveDelivery("hub:ep1:r1", { state: "delivered", deliveredAt: T0 + 9 });
    await q.poll();
    expect(store.managerDelivery("hub:ep1:r1")?.state).toBe("queued");
    fail = false;
    await q.poll();
    expect(heard).toEqual(["delivered"]);
    expect(store.managerDelivery("hub:ep1:r1")?.state).toBe("delivered");
  });

  it("a hub restart follows what it had queued: a change made while it was down is heard at start", async () => {
    const first = queue();
    await first.q.put(command("r1"), "x");
    first.q.stop();
    fleet.moveDelivery("hub:ep1:r1", { state: "delivered", deliveredAt: T0 + 9 });
    const second = queue();
    await second.q.start();
    expect(states(second.heard)).toEqual(["delivered"]);
    expect(second.q.view("hub:ep1:r1")).toMatchObject({ state: "delivered" });
  });
});

describe("an answer's id", () => {
  const answer = (id: string): NewDelivery => ({ ...command("r9"), deliveryId: id, kind: "answer", escalationId: "ny-7" });
  it("is its key; again after a given-up one, the key with ~2, ~3; never a new one while one may be queued", async () => {
    const { q } = queue();
    const key = "answer:ny-7:m1:option:ship";
    expect(q.idFor(key)).toBe(`hub:${key}`);
    await q.put(answer(`hub:${key}`), "[tap ny-7] ship (Ship it)");
    expect(q.idFor(key)).toBe(`hub:${key}`);
    fleet.moveDelivery(`hub:${key}`, { state: "given_up", why: "expired" });
    await q.poll();
    expect(q.idFor(key)).toBe(`hub:${key}~2`);
    await q.put(answer(`hub:${key}~2`), "[tap ny-7] ship (Ship it)");
    fleet.moveDelivery(`hub:${key}~2`, { state: "given_up", why: "expired" });
    await q.poll();
    expect(q.idFor(key)).toBe(`hub:${key}~3`);
  });
});

describe("cancelling one (the principal's cancel of a waiting message, ruling 83; a withdrawn answer)", () => {
  it("withdraws one still queued: given up, cancelled; one typed already goes on; one the fleet never had is unknown", async () => {
    const { q, heard } = queue();
    await q.put(command("r1"), "one");
    await q.put(command("r2"), "two");
    fleet.moveDelivery("hub:ep1:r2", { state: "typed", typedAt: T0 + 5 });
    expect(await q.cancel("hub:ep1:r1")).toMatchObject({ ok: true, view: { state: "given_up", reason: null, why: "cancelled" } });
    expect(heard.map(c => [c.row.deliveryId, c.view.state])).toContainEqual(["hub:ep1:r1", "given_up"]);
    expect(await q.cancel("hub:ep1:r2")).toEqual({ ok: false, problem: "already_typed" });
    expect(fleet.deliveries.get("hub:ep1:r2")?.delivery.state).toBe("typed");
    expect(await q.cancel("hub:ep1:r9")).toEqual({ ok: false, problem: "unknown" });
  });
});

describe("the switch off (spec §9.1; step 2's rollback, §13)", () => {
  it("cancels what is still queued, first, and follows what was typed already to its end", async () => {
    const on = queue();
    await on.q.put(command("r1"), "one");
    await on.q.put(command("r2"), "two");
    fleet.moveDelivery("hub:ep1:r2", { state: "typed", typedAt: T0 + 5 });
    on.q.stop();
    const off = queue({ on: false });
    await off.q.start();
    // Both rows still said queued (the typing happened while no hub listened): the one typed is refused already_typed.
    expect(fleet.cancels).toEqual(["hub:ep1:r1", "hub:ep1:r2"]);
    expect(fleet.deliveries.get("hub:ep1:r1")?.delivery).toMatchObject({ state: "given_up", why: "cancelled" });
    expect(fleet.deliveries.get("hub:ep1:r2")?.delivery).toMatchObject({ state: "typed" });
    expect(off.heard.map(c => [c.row.deliveryId, c.view.state])).toEqual(expect.arrayContaining([["hub:ep1:r1", "given_up"], ["hub:ep1:r2", "typed"]]));
    fleet.moveDelivery("hub:ep1:r2", { state: "delivered", deliveredAt: T0 + 9 });
    await until(() => off.heard.some(c => c.row.deliveryId === "hub:ep1:r2" && c.view.state === "delivered"));
  });

  it("a row still 'sending' whose delivery the fleet never had is dropped (its cancel is 404, ruling 56)", async () => {
    store.saveManagerDelivery({ ...command("r9"), state: "sending", updatedAt: T0 });
    await queue({ on: false }).q.start();
    expect(fleet.cancels).toEqual(["hub:ep1:r9"]);
    expect(store.managerDelivery("hub:ep1:r9")).toBeNull();
  });

  it("on, nothing is cancelled at start (negative control)", async () => {
    const first = queue();
    await first.q.put(command("r1"), "one");
    first.q.stop();
    await queue({ on: true }).q.start();
    expect(fleet.cancels).toEqual([]);
  });
});

describe("the manager's window and the fleet's sticky names (Review Focus 5)", () => {
  const warnings = () => {
    const said: string[] = [];
    vi.spyOn(log, "warn").mockImplementation(m => { said.push(m); });
    return said;
  };
  it("a window the fleet doesn't keep sticky is said once at start, and still delivered", async () => {
    await fleet.close();
    fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", memoryBackend({ "%0": { name: "boss", cwd: "/w/m", screen: "❯ " } }))], stickyLanes: ["manager"] });
    const said = warnings();
    const { q } = queue({ lane: "boss" });
    await q.start();
    await q.poll();
    expect(said.filter(m => m.includes("stickyLanes"))).toHaveLength(1);
    expect(said[0]).toContain('"boss"');
    expect(await q.put(command("r1"), "x")).toMatchObject({ ok: true });
  });
  it("a sticky window, or a fleet that can't be asked, says nothing (negative control)", async () => {
    const said = warnings();
    await queue().q.start();
    expect(said.filter(m => m.includes("stickyLanes"))).toEqual([]);
  });
});
```

- [ ] **Step 12.33: Run it and see it fail**

Run: `npx vitest run apps/hub/test/manager-queue.test.ts`
Expected: FAIL: `Error: Cannot find module '../src/application/manager-queue.ts' imported from …/apps/hub/test/manager-queue.test.ts`; no tests run.

- [ ] **Step 12.34: Implement the manager's queue**

The queue as the drift map ran it on `main` (ruling 85), with two additions for the messages (ruling 83): `put` takes how long a delivery may wait (`ttlMs`), and `cancel` answers what it came to (`CancelResult`), for the principal's Cancel. Its row is migration 16's.

Create `apps/hub/src/application/manager-queue.ts`:

```ts
// The manager's answers and messages through the fleet's delivery queue (fleet-clients spec §9.1; ADR-0014; ADR-0010's
// domain rules). Each goes to the manager's lane by name (a sticky name: it waits on its node through a manager restart,
// spec §4.6), under the key the hub would type it under (`hub:<key>`), so the switch never types one twice. Each has a
// row (manager_deliveries, migration 16), written before the fleet is asked, so a hub restart keeps following it; and
// each is followed to its end from the fleet's `delivery` events, and by asking every few seconds (an event sent while
// the hub wasn't subscribed is not replayed). Listeners hear every change of state or of the reason it waits, once, in
// one transaction with the row's new state: a change acted on (an answer recorded, an ask opened again) is acted on once
// across restarts, and one whose listener failed is heard again on the next round.
// The switch (MORNDO_MANAGER_QUEUE): on, new answers and messages for the manager come here; off, none do, what is still
// queued is cancelled first (so a direct retry types it once), and the rest is followed to its end.
import type { Delivery, DeliveryState, ErrorCode, GiveUpReason, QueuedCommand, WaitingReason } from "@morndo/protocol";
import type { ManagerDeliveryRow, Store } from "../adapters/store.ts";
import { log } from "../adapters/log.ts";
import type { Deliveries } from "./ports.ts";

// Where a delivery stands, as the hub shows it. `at`: delivered, when it reached the manager; else when it was typed or
// queued (the node's clock, which the manager's transcript is on).
export type QueueView = { state: DeliveryState; reason: WaitingReason | null; why: GiveUpReason | null; at: number | null };
export type QueueChange = { row: ManagerDeliveryRow; view: QueueView };
export type NewDelivery = Omit<ManagerDeliveryRow, "state" | "updatedAt">;
// put()'s answer: queued (or found: the same id again), with its row and where it stands; or nothing queued, by the
// fleet's or the node's code ("node_offline" when the fleet couldn't be reached at all, spec §10); or "uncertain": the
// fleet took it and never answered, so it may be queued: its row stays "sending", and the same id again asks again.
export type PutResult = { ok: true; row: ManagerDeliveryRow; view: QueueView; delivery: Delivery } | { ok: false; problem: ErrorCode };
// cancel()'s answer: withdrawn (given up, "cancelled"), or not: "already_typed" (it goes on to its end), "unknown" (the
// fleet never had it), "uncertain" (the fleet took the cancel and never answered), or the fleet's refusal.
export type CancelResult = { ok: true; view: QueueView } | { ok: false; problem: ErrorCode | "unknown" };

export const QUEUE_POLL_MS = 5000;
const KEEP_MS = 7 * 24 * 3_600_000;              // the node keeps a final delivery 7 days (spec §4.3); the hub its row as long
const COMMANDS_SHOWN_MS = 24 * 3_600_000;         // a device's messages the feed lists after its hello: the outbox's day
// How far a state is on: an older word (an event that crossed a newer answer) never moves a delivery back.
const RANK: Record<DeliveryState, number> = { queued: 0, typed: 1, held: 2, delivered: 3, uncertain: 3, given_up: 3 };
const FINAL = new Set<string>(["delivered", "uncertain", "given_up"]);
export const isFinal = (state: string): boolean => FINAL.has(state);

export function viewOf(d: Delivery): QueueView {
  return {
    state: d.state, reason: d.state === "queued" ? d.waiting?.reason ?? null : null, why: d.state === "given_up" ? d.why ?? null : null,
    at: d.deliveredAt ?? d.typedAt ?? d.queuedAt,
  };
}
// A message's delivery as the app reads it (feed `deliveries`): typed and held are still "queued" (not in the
// conversation yet), each with its own words for why.
export function queuedCommand(row: ManagerDeliveryRow, view: QueueView): QueuedCommand {
  const waiting = view.state === "queued" ? view.reason : view.state === "typed" || view.state === "held" ? view.state : null;
  const state = view.state === "typed" || view.state === "held" ? "queued" : view.state;
  return { requestId: row.requestId, state, waiting, why: view.why };
}

export class ManagerQueue {
  readonly lane: string;
  readonly on: boolean;
  #store: Store;
  #deliveries: Deliveries;
  #now: () => number;
  #pollMs: number;
  #views = new Map<string, QueueView>();
  #latest = new Map<string, Delivery>();          // the fleet's latest word on each delivery this process heard of
  #listeners = new Set<(c: QueueChange) => void>();
  #timer: NodeJS.Timeout | null = null;
  #unsubscribe: () => void = () => {};
  #polling: Promise<void> | null = null;

  constructor(p: { store: Store; deliveries: Deliveries; lane: string; on: boolean; now?: () => number; pollMs?: number }) {
    this.#store = p.store;
    this.#deliveries = p.deliveries;
    this.lane = p.lane;
    this.on = p.on;
    this.#now = p.now ?? Date.now;
    this.#pollMs = p.pollMs ?? QUEUE_POLL_MS;
  }

  subscribe(fn: (c: QueueChange) => void): () => void { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }

  // The delivery id of an answer under its key: `hub:<key>`, the key a direct send types it under (spec §9.1). Once every
  // delivery under that key was given up (nothing of it was typed: expired, cancelled), the key with "~2", "~3" …: an id
  // names one delivery for its 7 days (spec §4.1), and the same answer must be able to go again. While the last one is
  // anything else, its own id: the same id again answers what became of it.
  idFor(key: string): string {
    const base = `hub:${key}`;
    const rows = this.#store.managerDeliveryAttempts(base);
    const last = rows.at(-1);
    if (!last) return base;
    return last.state === "given_up" ? `${base}~${rows.length + 1}` : last.deliveryId;
  }

  // A new answer or message for the manager: its row written first (a hub that stops now still follows it), then the
  // fleet asked. The same id again (a repeat) asks again: the fleet answers its current state and queues nothing (§4.1).
  // put()'s own answer is no change heard by the listeners: the caller acts on it (a change an event brought meanwhile is
  // heard as usual, and view() has the latest). `ttlMs`: how long it may wait to be typed (absent: the fleet's 24 hours).
  async put(d: NewDelivery, text: string, ttlMs?: number): Promise<PutResult> {
    const known = this.#store.managerDelivery(d.deliveryId);
    if (!known) this.#store.saveManagerDelivery({ ...d, state: "sending", updatedAt: this.#now() });
    const r = await this.#deliveries.deliver({ id: d.deliveryId, lane: this.lane, text, ...(ttlMs === undefined ? {} : { ttlMs }) });
    if (r.ok) {
      this.#apply(r.delivery, false);
      const row = this.#store.managerDelivery(d.deliveryId);
      if (!row) return { ok: false, problem: "internal" };                          // pruned meanwhile: never in practice
      return { ok: true, row, view: this.view(d.deliveryId) ?? viewOf(r.delivery), delivery: r.delivery };
    }
    if ("inDoubt" in r) {
      // The fleet's own event may have said meanwhile that it is queued: then it is.
      const heard = this.#latest.get(d.deliveryId);
      const row = this.#store.managerDelivery(d.deliveryId);
      if (heard && row && row.state !== "sending") return { ok: true, row, view: this.view(d.deliveryId) ?? viewOf(heard), delivery: heard };
      log.warn(`${d.deliveryId}: the fleet took it and never answered; it may be queued, and a repeat asks again`);
      return { ok: false, problem: "uncertain" };
    }
    // Nothing queued now. A row from an earlier attempt stays: that one may be queued (it was in doubt).
    if (!known) this.#store.dropManagerDelivery(d.deliveryId);
    log.warn(`${d.deliveryId}: not queued for ${this.lane}: ${r.refused}`);
    return { ok: false, problem: r.refused };
  }

  // Where a delivery stands now; null when the hub has no row of it, or its row is still "sending".
  view(id: string): QueueView | null {
    const v = this.#views.get(id);
    if (v) return v;
    const row = this.#store.managerDelivery(id);
    return !row || row.state === "sending" ? null : { state: row.state, reason: null, why: null, at: null };
  }
  row(id: string): ManagerDeliveryRow | null { return this.#store.managerDelivery(id); }
  byRequest(endpointId: string, requestId: string): ManagerDeliveryRow | null { return this.#store.managerDeliveryOfRequest(endpointId, requestId); }
  answerRow(escalationId: string, queuedAt: number): ManagerDeliveryRow | null { return this.#store.answerDelivery(escalationId, queuedAt); }
  // The answers to one ask still in doubt (`prefix`: "hub:answer:<id>:<ask>:").
  sendingOf(prefix: string): ManagerDeliveryRow[] { return this.#store.managerDeliveriesWithPrefix(prefix).filter(r => r.state === "sending"); }
  openAnswers(): ManagerDeliveryRow[] { return this.#store.openManagerDeliveries().filter(r => r.kind === "answer"); }
  // Every answer to one escalation id through the queue, oldest first, whatever its ask.
  answersTo(escalationId: string): ManagerDeliveryRow[] { return this.#store.managerDeliveriesWithPrefix(`hub:answer:${escalationId}:`).filter(r => r.kind === "answer"); }
  // One device's messages to the manager of the last day, as the feed lists them after a hello.
  commandsOf(endpointId: string): QueuedCommand[] {
    return this.#store.commandDeliveriesOf(endpointId, this.#now() - COMMANDS_SHOWN_MS).flatMap(row => {
      const view = this.view(row.deliveryId);
      return view ? [queuedCommand(row, view)] : [];
    });
  }
  // A message's row given up while the switch is off: the hub types it directly now (nothing of it was typed).
  forget(id: string) { this.#store.dropManagerDelivery(id); this.#views.delete(id); this.#latest.delete(id); }

  // Withdraws a delivery still queued (spec §4.3 delivery.cancel). One typed already can't be (already_typed): it is
  // followed to its end. A row still "sending" whose delivery the fleet doesn't know (its cancel answered 404
  // no_such_delivery: cancelDelivery's null, rulings 3 and 56) was never queued: it goes.
  async cancel(id: string): Promise<CancelResult> {
    const r = await this.#deliveries.cancel(id);
    if (r.ok) { this.#safeApply(r.delivery); return { ok: true, view: this.view(id) ?? viewOf(r.delivery) }; }
    if ("unknown" in r) {
      if (this.#store.managerDelivery(id)?.state === "sending") this.#store.dropManagerDelivery(id);
      else log.warn(`${id}: the fleet knows no such delivery; it is followed until its row is pruned`);
      return { ok: false, problem: "unknown" };
    }
    if ("inDoubt" in r) {
      log.warn(`${id}: cancelling it went unanswered; it is followed, and the next start tries again`);
      return { ok: false, problem: "uncertain" };
    }
    if (r.refused === "already_typed") { log.info(`${id} was typed already: it is followed to its end`); return { ok: false, problem: "already_typed" }; }
    if (this.#store.managerDelivery(id)?.state === "sending" && r.refused !== "node_offline" && r.refused !== "timeout") {
      this.#store.dropManagerDelivery(id);
      return { ok: false, problem: r.refused };
    }
    log.warn(`${id}: cancelling it was refused (${r.refused}); it is followed, and may still be delivered`);
    return { ok: false, problem: r.refused };
  }

  // Asks the fleet about every delivery not final yet; one round at a time.
  poll(): Promise<void> {
    this.#polling ??= (async () => {
      for (const row of this.#store.openManagerDeliveries()) {
        const d = await this.#deliveries.get(row.deliveryId);
        if (d === "unavailable") return;                                 // the fleet can't be asked now: the next round
        if (d !== null) this.#safeApply(d);
      }
    })().finally(() => { this.#polling = null; });
    return this.#polling;
  }

  async start(): Promise<void> {
    const pruned = this.#store.pruneManagerDeliveries(this.#now() - KEEP_MS);
    if (pruned) log.info(`manager deliveries: pruned ${pruned} rows older than 7 days`);
    this.#unsubscribe = this.#deliveries.subscribe(d => this.#safeApply(d), () => { void this.poll(); });
    if (this.on) await this.#checkSticky();
    else await this.#cancelQueued();
    await this.poll();
    this.#timer = setInterval(() => { void this.poll(); }, this.#pollMs);
    this.#timer.unref();
  }
  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = null; this.#unsubscribe(); }

  // Review Focus 5: the manager's window under a name the fleet doesn't keep sticky (MORNDO_MANAGER_WINDOW renamed, the
  // fleet's stickyLanes not) still gets its deliveries, but not through a manager restart. Said once, at start.
  async #checkSticky() {
    const sticky = await this.#deliveries.stickyLanes();
    if (sticky === null || sticky.includes(this.lane)) return;
    log.warn(`the manager's window is "${this.lane}" (MORNDO_MANAGER_WINDOW), but the fleet's stickyLanes is ${JSON.stringify(sticky)}: answers and messages to it are delivered, but not through a restart of the manager (one queued then is given up, one sent while its window is gone is refused). Add "${this.lane}" to stickyLanes in the fleet's config.json.`);
  }

  // The switch off (spec §9.1): every delivery still queued is cancelled first, so it is never typed after the hub has
  // begun typing directly; a row still "sending" too (its delivery may be queued).
  async #cancelQueued() {
    for (const row of this.#store.openManagerDeliveries()) {
      if (row.state === "queued" || row.state === "sending") await this.cancel(row.deliveryId);
    }
  }

  #safeApply(d: Delivery) {
    try { this.#apply(d, true); }
    catch (e) { log.error(`${d.id}: acting on its change failed; the next round tries again`, e); }
  }

  // The fleet's word on one delivery. Not one of this hub's (no row): ignored. Older than what was applied: ignored. A
  // change: the row's new state and every listener, in one transaction; the view is kept only once that committed.
  #apply(d: Delivery, notify: boolean) {
    const row = this.#store.managerDelivery(d.id);
    if (!row) return;
    const before = this.view(d.id);
    if (before && RANK[d.state] < RANK[before.state]) return;
    this.#latest.set(d.id, d);
    const view = viewOf(d);
    if (before && before.state === view.state && before.reason === view.reason) { this.#views.set(d.id, view); return; }
    const now = { ...row, state: d.state, updatedAt: this.#now() };
    this.#store.transaction(() => {
      this.#store.setManagerDeliveryState(d.id, d.state, now.updatedAt);
      if (notify) for (const l of this.#listeners) l({ row: now, view });
    });
    this.#views.set(d.id, view);
  }
}
```

- [ ] **Step 12.35: Run it and see it pass**

Run: `npx vitest run apps/hub/test/manager-queue.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 12.36: Commit**

```bash
git add apps/hub/src/application/manager-queue.ts apps/hub/test/manager-queue.test.ts
```

```bash
git commit -m "feat(hub): the manager's queue: rows first, followed to their end, the switch off cancels first"
```

- [ ] **Step 12.37: Write the failing test: the manager's answers through the queue**

Create `apps/hub/test/escalation-queue.test.ts`. Its last three groups are #29's review cases on the queue (B3, B5, B7, B8, B9), its notices, and what #29's inbox left behind:

```ts
// The manager's answers through the fleet's delivery queue (fleet-clients §9.1; ADR-0010's domain rules; E13): the
// delivery id is the answer's key, so the switch never types one twice; queued, it counts as given (E8) and the card
// says why it waits; delivered, it is recorded once at its time; uncertain, it stays given and is never opened again;
// given up, the ask opens again and the same answer can go again. A hub restart keeps following it; a manager mid-
// restart is no refusal (its sticky name waits); an answer whose ask closed or was asked again is withdrawn. Off, the
// answer is typed directly under the same key, and what was still queued is cancelled first. Over the fake fleet on a
// real Unix socket; a synthetic list and conversation.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId, type Message } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { fleetDeliveries } from "../src/adapters/fleet-deliveries.ts";
import { EscalationService, type Watch } from "../src/application/escalation-service.ts";
import { ManagerQueue } from "../src/application/manager-queue.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { localNode, memoryBackend, until, type MemoryBackend } from "./helpers/fake-fleet.ts";
import { fleetRig, type FleetRig } from "./helpers/hub-mode.ts";

const T0 = Date.UTC(2026, 9, 8, 9);
const MANAGER = "pc.aaaaaaaa.0";
const KEY = "answer:ny-7:m1:option:ship";
const ID = `hub:${KEY}`;
let dir: string;
let store: Store;
let ledgerPath: string;
let backend: MemoryBackend;
let rig: FleetRig;
let clock: number;
let manager: Message[];
let running: { queue: ManagerQueue; svc: EscalationService }[] = [];

const auth: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: T0, lastSeenAt: T0, verifiedAt: T0 + 1e9, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: T0, revokedAt: null },
};
const buttons = (id: string, at: number): Message => ({ id, at, author: { kind: "agent", name: "manager" }, kind: "text", text: "Ready to ship.\n\n[buttons ny-7] ship=Ship it | hold=Hold for a day" });
const tap = (id: string, at: number): Message => ({ id, at, author: { kind: "principal", name: "You" }, kind: "text", text: "[tap ny-7] ship (Ship it)" });
const watch: Watch = {
  workers: () => (backend.panes["%0"] ? [{ id: MANAGER, name: "manager" }] : []),
  history: id => (id === MANAGER ? manager : []),
  openQuestions: () => [],
  screen: () => undefined,
};

beforeEach(async () => {
  clock = T0;
  dir = mkdtempSync(join(tmpdir(), "morndo-escalation-queue-"));
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-7", kind: "tap", question: "Ship the demo release tonight?",
    options: [{ key: "ship", label: "Ship it" }, { key: "hold", label: "Hold for a day" }] }], needsYouClosed: [] }));
  manager = [buttons("m1", T0 - 60_000)];
  backend = memoryBackend({ "%0": { name: "manager", cwd: "/w/manager", screen: "❯ ", sessionId: "s-manager" } });
  rig = await fleetRig([localNode("pc", "aaaaaaaa", backend)]);
});
afterEach(async () => {
  for (const r of running.splice(0)) { r.queue.stop(); r.svc.stop(); }
  await rig.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// A hub start, as main.ts builds one with a fleet: the queue (on, unless the switch is off), then the escalations on it.
async function start(o: { on?: boolean } = {}) {
  const queue = new ManagerQueue({ store, deliveries: fleetDeliveries(rig.client), lane: "manager", on: o.on ?? true, now: () => clock, pollMs: 60_000 });
  const svc = new EscalationService({
    watch, ledger: ledgerReader(ledgerPath, () => clock), store, managerName: "manager", now: () => clock,
    send: (pane, text, key) => rig.ports.tmux.send(pane, text, key), queue,
  });
  await queue.start();
  svc.poll();
  running.push({ queue, svc });
  return svc;
}
const item = (svc: EscalationService, id = "ny-7") => svc.board().items.find(i => i.id === id);
const answers = () => store.audit(50).filter(a => a.type === "EscalationAnswered").map(a => a.body);
const ship = (svc: EscalationService, request = "r1") => svc.answer(auth, "ny-7", { kind: "option", key: "ship" }, request);

describe("an answer to the manager through the queue (spec §9.1)", () => {
  it("is queued under its answer key, counts as given (E8), and waits with its reason; nothing is typed by the hub", async () => {
    const svc = await start();
    expect(await ship(svc)).toMatchObject({ ok: true, item: { status: "answered", decision: { choice: { key: "ship" }, delivery: { state: "queued", at: null } } } });
    expect(rig.fleet.deliveryCalls).toEqual([{ id: ID, lane: "manager", workerId: null, text: "[tap ny-7] ship (Ship it)" }]);
    expect(backend.typed).toEqual([]);
    expect(answers()).toEqual([]);                                             // recorded only once delivered (E13)
    rig.fleet.moveDelivery(ID, { waiting: { reason: "menu_open", since: T0 } });
    await until(() => item(svc)?.waiting === "menu_open");
    rig.fleet.moveDelivery(ID, { state: "typed", typedAt: T0 + 5 });
    await until(() => item(svc)?.waiting === "typed");
    expect(await svc.answer(auth, "ny-7", { kind: "option", key: "hold" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
    expect(await ship(svc)).toMatchObject({ ok: true });                       // the same request again: what became of it
    expect(rig.fleet.deliveryCalls).toHaveLength(1);
  });

  it("delivered: recorded once, at the time it reached the manager (E13)", async () => {
    const svc = await start();
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "delivered", deliveredAt: T0 + 9000 });
    await until(() => answers().length === 1);
    expect(answers()[0]).toMatchObject({ escalationId: "ny-7", choice: { kind: "option", key: "ship", label: "Ship it" }, endpointId: "ep1", sessionId: "s1", at: T0 + 9000 });
    expect(item(svc)).toMatchObject({ status: "answered", decision: { delivery: { state: "delivered", at: T0 + 9000 } } });
    expect(item(svc)?.waiting).toBeUndefined();
    await running[0]?.queue.poll();
    expect(answers()).toHaveLength(1);
  });

  it("words are recorded by their length and digest, never the words", async () => {
    const svc = await start();
    expect(await svc.answer(auth, "ny-7", { kind: "words", text: "Ship it after the smoke test" }, "r1")).toMatchObject({ ok: true });
    const id = rig.fleet.deliveryCalls[0]?.id ?? "";
    expect(rig.fleet.deliveryCalls[0]?.text).toBe("About ny-7: Ship it after the smoke test");
    rig.fleet.moveDelivery(id, { state: "delivered", deliveredAt: T0 + 9000 });
    await until(() => answers().length === 1);
    expect(answers()[0]).toMatchObject({ choice: { kind: "words" }, length: 28, digest: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(JSON.stringify(store.audit(50))).not.toContain("smoke test");
  });

  it("uncertain: 'may have been delivered', still answered, never opened again, and not recorded", async () => {
    const svc = await start();
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "uncertain", note: "typed, never seen taken" });
    await until(() => item(svc)?.decision?.delivery?.state === "uncertain");
    svc.poll();
    expect(item(svc)).toMatchObject({ status: "answered" });
    expect(answers()).toEqual([]);
    expect(await svc.answer(auth, "ny-7", { kind: "option", key: "hold" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
  });

  it("given up: the ask is open again, nothing recorded; the same answer goes again under a new id", async () => {
    const svc = await start();
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "given_up", why: "expired" });
    await until(() => item(svc)?.status === "open");
    expect(item(svc)?.decision).toBeNull();
    expect(answers()).toEqual([]);
    expect(await ship(svc, "r2")).toMatchObject({ ok: true });
    expect(rig.fleet.deliveryCalls.map(c => c.id)).toEqual([ID, `${ID}~2`]);
  });

  it("in doubt (the fleet took it and never answered): uncertain, another answer refused meanwhile; its repeat takes it once", async () => {
    const svc = await start();
    rig.fleet.loseDeliveryAnswers(1);
    rig.fleet.quietDeliveries(true);
    expect(await ship(svc)).toMatchObject({ ok: false, problem: "uncertain", item: { status: "open" } });
    rig.fleet.quietDeliveries(false);
    expect(await svc.answer(auth, "ny-7", { kind: "option", key: "hold" }, "r2")).toMatchObject({ ok: false, problem: "answer_in_doubt" });
    expect(await ship(svc)).toMatchObject({ ok: true, item: { status: "answered", decision: { delivery: { state: "queued" } } } });
    expect(rig.fleet.deliveries.size).toBe(1);
  });

  it("a hub restart keeps following it: delivered while the hub was down, recorded once at start", async () => {
    const before = await start();
    await ship(before);
    running[0]?.queue.stop();
    rig.fleet.moveDelivery(ID, { state: "delivered", deliveredAt: T0 + 9000 });
    const after = await start();
    await until(() => answers().length === 1);
    expect(item(after)).toMatchObject({ status: "answered", decision: { delivery: { state: "delivered", at: T0 + 9000 } } });
  });

  it("a manager mid-restart is no refusal: its sticky name waits on its node", async () => {
    const svc = await start();
    await rig.client.lanes();                                                  // the fleet saw the manager's window
    delete backend.panes["%0"];
    svc.poll();
    expect(await svc.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: true });
    expect(rig.fleet.deliveryCalls[0]).toMatchObject({ lane: "manager" });
  });

  it("asked again while queued: its delivery is withdrawn, and the new ask is open", async () => {
    const svc = await start();
    await ship(svc);
    clock = T0 + 60_000;
    manager = [buttons("m1", T0 - 60_000), buttons("m2", T0 + 30_000)];
    svc.poll();
    await until(() => rig.fleet.cancels.includes(ID));
    await until(() => rig.fleet.deliveries.get(ID)?.delivery.state === "given_up");
    expect(item(svc)).toMatchObject({ status: "open", askedAgain: true });
  });

  it("asked again after it was typed: delivered, it answers the ask it was given for; its echo never answers the new one (ADR-0010 H1)", async () => {
    const svc = await start();
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "typed", typedAt: T0 + 5 });
    await until(() => item(svc)?.waiting === "typed");
    clock = T0 + 60_000;
    manager = [buttons("m1", T0 - 60_000), buttons("m2", T0 + 30_000), tap("e1", T0 + 40_000)];   // the typed line's echo
    svc.poll();
    rig.fleet.moveDelivery(ID, { state: "delivered", deliveredAt: T0 + 40_000 });
    await until(() => answers().length === 1);
    expect(answers()[0]).toMatchObject({ escalationId: "ny-7", at: T0 + 40_000 });
    svc.poll();
    expect(item(svc)).toMatchObject({ status: "open", decision: null, askedAgain: true });
    manager = [...manager, tap("e2", T0 + 50_000)];                                              // the same tap again: a new answer
    svc.poll();
    expect(item(svc)).toMatchObject({ status: "answered", decision: { via: "elsewhere", choice: { key: "ship" } } });
  });

  it("the fleet down: nothing counts as given, and the ask stays open (spec §10)", async () => {
    const svc = await start();
    await rig.fleet.setStatus("pc", "offline");
    expect(await ship(svc)).toMatchObject({ ok: false, problem: "node_offline" });
    expect(item(svc)).toMatchObject({ status: "open", decision: null });
    expect(store.managerDelivery(ID)).toBeNull();
  });
});

describe("the switch off", () => {
  it("types the answer directly, under the same key the queue would use (negative control)", async () => {
    const svc = await start({ on: false });
    expect(await ship(svc)).toMatchObject({ ok: true });
    expect(rig.fleet.deliveryCalls).toEqual([]);
    expect(backend.typed).toEqual([{ pane: "%0", text: "[tap ny-7] ship (Ship it)", key: ID }]);
  });

  it("an answer still in doubt is never typed directly: its repeat is uncertain, another answer answer_in_doubt (ruling 49)", async () => {
    const svc = await start({ on: false });
    // In doubt: its cancel at start went unanswered, so its row is still "sending".
    store.saveManagerDelivery({ deliveryId: ID, kind: "answer", escalationId: "ny-7", ask: "m1", choice: JSON.stringify({ kind: "option", key: "ship", label: "Ship it" }),
      endpointId: "ep1", sessionId: "s1", requestId: "r1", queuedAt: T0, state: "sending", updatedAt: T0 });
    expect(await ship(svc)).toMatchObject({ ok: false, problem: "uncertain" });
    expect(await svc.answer(auth, "ny-7", { kind: "option", key: "hold" }, "r2")).toMatchObject({ ok: false, problem: "answer_in_doubt" });
    expect(backend.typed).toEqual([]);
  });

  it("a queued answer is cancelled first, its ask opens again, and a direct answer types it once", async () => {
    const on = await start();
    await ship(on);
    running[0]?.queue.stop();
    const off = await start({ on: false });
    await until(() => item(off)?.status === "open");
    expect(rig.fleet.cancels).toEqual([ID]);
    expect(await ship(off, "r2")).toMatchObject({ ok: true });
    expect(backend.typed.map(t => t.key)).toEqual([ID]);
  });
});

// #29's review cases (its tests went with its inbox; ruling 81), on the queue: each failed there before its fix.
describe("#29's review cases, on the queue", () => {
  const restart = async (o: { on?: boolean } = {}) => { for (const r of running.splice(0)) { r.queue.stop(); r.svc.stop(); } return start(o); };
  const hold = (svc: EscalationService, request = "r2") => svc.answer(auth, "ny-7", { kind: "option", key: "hold" }, request);
  // A typed, so not withdrawn; the ask asked again (m2) and answered anew with B, queued.
  const answeredAnew = async () => {
    const svc = await start();
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "typed", typedAt: T0 + 5 });
    await until(() => item(svc)?.waiting === "typed");
    clock = T0 + 60_000;
    manager = [buttons("m1", T0 - 60_000), buttons("m2", T0 + 30_000)];
    svc.poll();
    expect(await hold(svc)).toMatchObject({ ok: true, item: { decision: { choice: { key: "hold" } } } });
    return svc;
  };

  it("B3: an older answer that ends after the ask was answered anew leaves the newer Decision, across a restart", async () => {
    const svc = await answeredAnew();
    rig.fleet.moveDelivery(ID, { state: "delivered", deliveredAt: T0 + 61_000 });
    await until(() => answers().length === 1);
    expect(item(svc)).toMatchObject({ status: "answered", decision: { choice: { key: "hold" }, delivery: { state: "queued" } } });
    const after = await restart();
    expect(item(after)).toMatchObject({ status: "answered", decision: { choice: { key: "hold" }, delivery: { state: "queued" } } });
  });

  it("B7: two answers to one ask, asked again in between: each is recorded once delivered, with its own choice and time", async () => {
    const svc = await answeredAnew();
    rig.fleet.moveDelivery(ID, { state: "delivered", deliveredAt: T0 + 61_000 });
    const second = rig.fleet.deliveryCalls[1]?.id ?? "";
    rig.fleet.moveDelivery(second, { state: "delivered", deliveredAt: T0 + 62_000 });
    await until(() => answers().length === 2);
    const recorded = answers().map(a => [(a as { choice: { key: string } }).choice.key, (a as { at: number }).at]);
    expect(recorded.sort((x, y) => Number(x[1]) - Number(y[1]))).toEqual([["ship", T0 + 61_000], ["hold", T0 + 62_000]]);
    expect(item(svc)).toMatchObject({ status: "answered", decision: { choice: { key: "hold" }, delivery: { state: "delivered", at: T0 + 62_000 } } });
  });

  describe("B5: the queue's word after a restart, before the ask is sighted again", () => {
    // An ask from a button message alone (not on the list): sighted only while the manager's conversation can be read.
    const go = (svc: EscalationService) => svc.answer(auth, "ship-1", { kind: "option", key: "go" }, "r1");
    const away = async () => {
      manager = [{ id: "m1", at: T0 - 60_000, author: { kind: "agent", name: "manager" }, kind: "text", text: "Ship the hotfix?\n\n[buttons ship-1] go=Go | hold=Hold" }];
      const svc = await start();
      expect(await go(svc)).toMatchObject({ ok: true });
      for (const r of running.splice(0)) { r.queue.stop(); r.svc.stop(); }
      delete backend.panes["%0"];                                                // the hub restarts while the manager isn't running
      return rig.fleet.deliveryCalls[0]?.id ?? "";
    };
    const back = (svc: EscalationService) => {
      backend.panes["%0"] = { name: "manager", cwd: "/w/manager", screen: "❯ ", sessionId: "s-manager" };
      svc.poll();
      return item(svc, "ship-1");
    };

    it("delivered: recorded at once, and the ask, sighted again, shows it delivered", async () => {
      const id = await away();
      rig.fleet.moveDelivery(id, { state: "delivered", deliveredAt: T0 + 1000 });
      const svc = await start();
      await until(() => answers().length === 1);
      expect(item(svc, "ship-1")).toBeUndefined();
      expect(back(svc)).toMatchObject({ status: "answered", decision: { delivery: { state: "delivered", at: T0 + 1000 } } });
    });

    it("given up: the ask, sighted again, is open, and nothing is recorded", async () => {
      const id = await away();
      rig.fleet.moveDelivery(id, { state: "given_up", why: "expired" });
      const svc = await start();
      await until(() => store.managerDelivery(id)?.state === "given_up");
      expect(back(svc)).toMatchObject({ status: "open", decision: null });
      expect(answers()).toEqual([]);
    });
  });

  it("B8: after restarts, a card's Decision carries only the Decision's own fields", async () => {
    const declared = ["at", "choice", "delivery", "endpointId", "sessionId", "via"];
    await ship(await start());
    let svc = await restart();
    expect(Object.keys(item(svc)?.decision ?? {}).sort()).toEqual(declared);
    rig.fleet.moveDelivery(ID, { state: "delivered", deliveredAt: T0 + 9000 });
    await until(() => answers().length === 1);
    svc = await restart();
    expect(Object.keys(item(svc)?.decision ?? {}).sort()).toEqual(declared);
  });

  it("B9: words that are empty once control characters go are refused, and nothing is queued", async () => {
    const svc = await start();
    expect(await svc.answer(auth, "ny-7", { kind: "words", text: " \u001b\u0007\u0000\r\n " }, "r1")).toMatchObject({ ok: false, problem: "empty" });
    expect(rig.fleet.deliveryCalls).toEqual([]);
  });
});

describe("the card's notice (#29's notices, on the queue)", () => {
  it("given up: Not delivered on the open card, still after a restart; answering again clears it", async () => {
    let svc = await start();
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "given_up", why: "expired" });
    await until(() => item(svc)?.status === "open");
    expect(item(svc)?.notice).toBe("Not delivered: the answer never reached the manager. Answer again.");
    for (const r of running.splice(0)) { r.queue.stop(); r.svc.stop(); }
    svc = await start();
    expect(item(svc)?.notice).toMatch(/^Not delivered/);
    expect(await ship(svc, "r2")).toMatchObject({ ok: true });
    expect(item(svc)?.notice).toBeUndefined();
  });

  it("the same request again after it was given up: not delivered, nothing queued again", async () => {
    const svc = await start();
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "given_up", why: "cancelled" });
    await until(() => item(svc)?.status === "open");
    expect(await ship(svc)).toMatchObject({ ok: false, problem: "not_delivered", item: { status: "open" } });
    expect(rig.fleet.deliveryCalls).toHaveLength(1);
  });

  it("delivered late, for the ask before it was asked again: the new ask's card says so (negative control: a new ask after a delivery says nothing)", async () => {
    const svc = await start();
    await ship(svc);
    rig.fleet.moveDelivery(ID, { state: "typed", typedAt: T0 + 5 });
    await until(() => item(svc)?.waiting === "typed");
    clock = T0 + 60_000;
    manager = [buttons("m1", T0 - 60_000), buttons("m2", T0 + 30_000)];
    svc.poll();
    rig.fleet.moveDelivery(ID, { state: "delivered", deliveredAt: T0 + 61_000 });
    await until(() => answers().length === 1);
    expect(item(svc)).toMatchObject({ status: "open", notice: "This reached the manager late, as an answer to the earlier version of the question." });
    clock = T0 + 120_000;
    manager = [...manager, buttons("m3", T0 + 120_000)];                       // asked again after that delivery
    svc.poll();
    expect(item(svc)?.notice).toBeUndefined();
  });

  it("a given-up answer for an earlier ask says nothing on the new ask", async () => {
    const svc = await start();
    await ship(svc);
    clock = T0 + 60_000;
    manager = [buttons("m1", T0 - 60_000), buttons("m2", T0 + 30_000)];
    svc.poll();
    await until(() => rig.fleet.deliveries.get(ID)?.delivery.state === "given_up");
    await until(() => store.managerDelivery(ID)?.state === "given_up");
    expect(item(svc)).toMatchObject({ status: "open", askedAgain: true });
    expect(item(svc)?.notice).toBeUndefined();
  });
});

describe("an answer #29's inbox left queued (no delivery row here)", () => {
  it("may have been delivered: it stays answered, is never asked again, and nothing is typed or queued (ruling 82)", async () => {
    store.saveDecision("ny-7", { choice: { kind: "option", key: "ship", label: "Ship it" }, at: T0 - 5000, via: "here", endpointId: "ep1", sessionId: "s1", delivery: { state: "queued", at: null } });
    const svc = await start();
    expect(item(svc)).toMatchObject({ status: "answered", decision: { delivery: { state: "uncertain", at: null } } });
    expect(store.decisions()[0]?.decision).toMatchObject({ delivery: { state: "uncertain" } });
    expect(await svc.answer(auth, "ny-7", { kind: "option", key: "hold" }, "r2")).toMatchObject({ ok: false, problem: "already_answered" });
    expect(rig.fleet.deliveryCalls).toEqual([]);
    expect(backend.typed).toEqual([]);
  });
});
```

- [ ] **Step 12.38: Run it and see it fail**

Run: `npx vitest run apps/hub/test/escalation-queue.test.ts`
Expected: FAIL, 22 of 25 (the service takes no `queue` yet, so every answer is typed directly): `Error: no delivery hub:answer:ny-7:m1:option:ship` in most; `AssertionError: expected { ok: true, …(1) } to match object { ok: true, item: { …(2) } }`; `AssertionError: expected undefined to be 'About ny-7: Ship it after the smoke t…'`; `AssertionError: expected { ok: false, problem: 'no_pane', …(1) } to match object { ok: true }` (the manager mid-restart); `AssertionError: expected { ok: true, …(1) } to match object { ok: false, problem: 'uncertain' }` (an answer in doubt, and one in doubt once off); `Error: not within 5000 ms` (nothing to withdraw or cancel); `AssertionError: expected [ 'at', 'choice', 'endpointId', …(2) ] to deeply equal [ 'at', 'choice', 'delivery', …(3) ]` (B8); and `AssertionError: expected { id: 'ny-7', asker: { …(3) }, …(27) } to match object { status: 'answered', …(1) }` (#29's leftover). The fleet down, the switch-off direct answer and B9 pass already.

- [ ] **Step 12.39: Implement the answers through the queue**

On the direct path that Step 12.3 left as it was before #29: the queue's answers (`#queueAnswer`), why they wait (`#waiting`), their notices read from the rows (`#notice`, #29's sentences), the withdrawal of a stale one, the H1 echo rule, the switch-off rules (ruling 49), `not_delivered` for a repeat of a given-up answer, and a Decision #29's inbox left queued read as uncertain at start. The answer is queued with #29's `Escalations.queue`, which takes the request's `Choice` and labels it from the ask. A restored queued Decision with no delivery row reads "May have been delivered": the safe default, though on the PC none exists (ruling 89).

In `apps/hub/src/application/escalation-service.ts` (1 of 19), replace:

```ts
import {
  DEFAULT_POLICY, Escalations, askVersion, escalationId, mayCommand, refusal,
  type AccessPolicy, type AnswerRefusal, type Ask, type Choice, type Decision, type DecidedChoice, type Escalation, type Message, type Sighting,
```

with:

```ts
import {
  DEFAULT_POLICY, Escalations, answered, askVersion, endpointId, escalationId, mayCommand, refusal, sameDecision, sessionId,
  type AccessPolicy, type AnswerRefusal, type Ask, type Choice, type Decision, type DecidedChoice, type Escalation, type Message, type Sighting,
```

In `apps/hub/src/application/escalation-service.ts` (2 of 19), replace:

```ts
import { isLedgerId, parseAnswer, parseTap, tapLine, wordsLine, type ButtonOption } from "../adapters/manager-protocol.ts";
import type { SendRow, Store } from "../adapters/store.ts";
import { menuIdentity, menuOnScreen, type SendProblem } from "@morndo/node-ops";
```

with:

```ts
import { isLedgerId, parseAnswer, parseTap, tapLine, wordsLine, type ButtonOption } from "../adapters/manager-protocol.ts";
import type { ManagerDeliveryRow, SendRow, Store } from "../adapters/store.ts";
import { menuIdentity, menuOnScreen, type SendProblem } from "@morndo/node-ops";
```

In `apps/hub/src/application/escalation-service.ts` (3 of 19), replace:

```ts
import { cleanText, keepInDoubt, settleOutcome, type SendResult } from "./steering-service.ts";
import { log } from "../adapters/log.ts";
```

with:

```ts
import { cleanText, keepInDoubt, settleOutcome, type SendResult } from "./steering-service.ts";
import type { ManagerQueue, QueueView } from "./manager-queue.ts";
import { log } from "../adapters/log.ts";
```

In `apps/hub/src/application/escalation-service.ts` (4 of 19), replace:

```ts

export type EscalationView = Escalation & { answerable: AnswerRefusal | null; version: string };
type ButtonMessage = { message: Message; body: string; options: ButtonOption[] };
```

with:

```ts

// `waiting`: while a Decision for the manager waits in the fleet's queue, why (a WaitingReason, or "typed", "held").
// `notice`: a sentence on an open card: its answer through the queue never reached the manager, or reached it late.
export type EscalationView = Escalation & { answerable: AnswerRefusal | null; version: string; waiting?: string; notice?: string };
type ButtonMessage = { message: Message; body: string; options: ButtonOption[] };
```

In `apps/hub/src/application/escalation-service.ts` (5 of 19), replace:

```ts
const REQUEST_TTL_MS = 10 * 60_000;
const SETTLED_LEDGER_MS = 3 * 24 * 3_600_000;        // closed list items shown under "Decided" for three days

const digest = (words: string) => createHash("sha256").update(words.trim()).digest("hex").slice(0, 16);
// The key an answer carries to the asker's node (fleet core §3.1): one choice for one ask is one key, so a repeat after a
```

with:

```ts
const REQUEST_TTL_MS = 10 * 60_000;
const ECHO_SLACK_MS = 5000;                           // an echo is no older than its answer's queueing, less this (clocks)
const SETTLED_LEDGER_MS = 3 * 24 * 3_600_000;        // closed list items shown under "Decided" for three days
const NOT_DELIVERED = "Not delivered: the answer never reached the manager. Answer again.";
const LATE_ANSWER = "This reached the manager late, as an answer to the earlier version of the question.";

const digest = (words: string) => createHash("sha256").update(words.trim()).digest("hex").slice(0, 16);
// An answer's choice in its queue row (manager_deliveries.choice): its option as decided, or its words' length and digest
// (E9: never the words).
type StoredChoice = { kind: "option"; key: string; label: string } | { kind: "words"; length: number; digest: string };
// The Decision an answer's row was queued as (A1: who answered, when, with what): what the queue's word on it moves.
function decisionOf(row: ManagerDeliveryRow): Decision {
  const c = JSON.parse(row.choice ?? "{}") as StoredChoice;
  return {
    choice: c.kind === "option" ? { kind: "option", key: c.key, label: c.label } : { kind: "words" }, at: row.queuedAt, via: "here",
    endpointId: endpointId(row.endpointId), sessionId: sessionId(row.sessionId), delivery: { state: "queued", at: null },
  };
}
const wordsOf = (row: ManagerDeliveryRow) => {
  const c = JSON.parse(row.choice ?? "{}") as StoredChoice;
  return c.kind === "words" ? { length: c.length, digest: c.digest } : {};
};
// The key an answer carries to the asker's node (fleet core §3.1): one choice for one ask is one key, so a repeat after a
```

In `apps/hub/src/application/escalation-service.ts` (6 of 19), replace:

```ts
  #timer: NodeJS.Timeout | null = null;

```

with:

```ts
  #timer: NodeJS.Timeout | null = null;
  // The fleet's delivery queue for the manager (fleet-clients §9.1), null without a fleet; `on` from MORNDO_MANAGER_QUEUE.
  #queue: ManagerQueue | null;
  #cancelling = new Set<string>();                    // deliveries being withdrawn (#withdrawStale), once each

```

In `apps/hub/src/application/escalation-service.ts` (7 of 19), replace:

```ts
    settle?: SettleInDoubt;
  }) {
    this.#watch = p.watch;
```

with:

```ts
    settle?: SettleInDoubt;
    // The manager's queue (spec §9.1). Off or absent: answers to the manager are typed directly; one queued before the
    // switch went off is still followed (and was cancelled at start if it hadn't been typed).
    queue?: ManagerQueue | null;
  }) {
    this.#queue = p.queue ?? null;
    this.#queue?.subscribe(c => this.#onDelivery(c.row, c.view));
    this.#watch = p.watch;
```

In `apps/hub/src/application/escalation-service.ts` (8 of 19), replace:

```ts
    this.#x.restore(saved.map(d => ({ id: escalationId(d.id), decision: d.decision })));
  }
```

with:

```ts
    this.#x.restore(saved.map(d => ({ id: escalationId(d.id), decision: d.decision })));
    // A Decision #29's manager inbox left queued has no delivery row here: that inbox may still type it, so it may have
    // been delivered. It stays given and is never asked again (E13, ruling 82), and the hub never types it.
    for (const d of saved) {
      if (d.decision.delivery?.state !== "queued" || this.#store.answerDelivery(d.id, d.decision.at)) continue;
      this.#x.uncertain(d.id, d.decision);
      this.#store.replaceDecisionIf(d.id, d.decision.at, { ...d.decision, delivery: { state: "uncertain", at: null } });
      log.warn(`answer to ${d.id} was queued before the fleet's queue and isn't followed here: it may have been delivered`);
    }
  }
```

In `apps/hub/src/application/escalation-service.ts` (9 of 19), replace:

```ts
    return {
      items: this.#x.list().map(e => ({ ...e, answerable: refusal(e, now), version: this.#version(e) })),
      ledger: { configured: this.#ledger !== null, ok: l?.ok ?? false, at: l?.at ?? null },
```

with:

```ts
    return {
      items: this.#x.list().map(e => ({ ...e, answerable: refusal(e, now), version: this.#version(e), ...this.#waiting(e), ...this.#notice(e) })),
      ledger: { configured: this.#ledger !== null, ok: l?.ok ?? false, at: l?.at ?? null },
```

In `apps/hub/src/application/escalation-service.ts` (10 of 19), replace:

```ts
    const e = this.#x.get(id);
    return e ? { ...e, answerable: refusal(e, this.#now()), version: this.#version(e) } : null;
  }
```

with:

```ts
    const e = this.#x.get(id);
    return e ? { ...e, answerable: refusal(e, this.#now()), version: this.#version(e), ...this.#waiting(e), ...this.#notice(e) } : null;
  }
  // A sentence on an open card (E13), from the latest answer to it through the queue: given up for this ask (never typed,
  // so it reached no one) says Not delivered; delivered after the ask was asked anew, for the earlier one, says so. Read
  // from the rows, so a restart still says it; it goes once he answers again or the ask closes (#29's notices).
  #notice(e: Escalation): { notice?: string } {
    if (!this.#queue || e.status !== "open" || e.asker.kind !== "manager") return {};
    const last = this.#queue.answersTo(e.id).at(-1);
    if (!last) return {};
    const ask = e.messageId ?? `t${e.askedAt}`;
    if (last.state === "given_up" && last.ask === ask) return { notice: NOT_DELIVERED };
    if (last.state === "delivered" && last.ask !== ask && last.updatedAt >= e.askedAt) return { notice: LATE_ANSWER };
    return {};
  }
  // Why a Decision queued for the manager still waits, as the queue says it (fleet-clients §9.1): its reason while queued,
  // "typed" or "held" once typed.
  #waiting(e: Escalation): { waiting?: string } {
    if (!this.#queue || e.decision?.delivery?.state !== "queued") return {};
    const row = this.#queue.answerRow(e.id, e.decision.at);
    const v = row ? this.#queue.view(row.deliveryId) : null;
    const w = v?.state === "queued" ? v.reason : v?.state === "typed" || v?.state === "held" ? v.state : null;
    return w ? { waiting: w } : {};
  }
```

In `apps/hub/src/application/escalation-service.ts` (11 of 19), replace:

```ts
    for (const id of this.#buttons.keys()) if (!this.#x.get(id)) this.#buttons.delete(id);   // kept as long as its ask
    if (changed) this.#notify();
```

with:

```ts
    for (const id of this.#buttons.keys()) if (!this.#x.get(id)) this.#buttons.delete(id);   // kept as long as its ask
    this.#withdrawStale();
    if (changed) this.#notify();
```

In `apps/hub/src/application/escalation-service.ts` (12 of 19), replace:

```ts

  #notify() { const b = this.board(); for (const l of this.#listeners) l(b); }
```

with:

```ts

  // A queued answer whose ask closed (settled, expired) or was asked again meanwhile answers a question the principal no
  // longer has (E11, E12; ADR-0010 B1, H2): its delivery is withdrawn, once. One typed already can't be: it is followed
  // to its end, and its record (once delivered) keeps its own Decision.
  #withdrawStale() {
    if (!this.#queue) return;
    for (const row of this.#queue.openAnswers()) {
      const id = row.escalationId;
      if (id === null || row.state !== "queued" || this.#inFlight.has(id) || this.#cancelling.has(row.deliveryId)) continue;
      const e = this.#x.get(id);
      if (!e) continue;                                  // not sighted since a restart: nothing to judge it by yet
      const closed = e.status === "settled" || e.status === "expired";
      if (!closed && sameDecision(e.decision, decisionOf(row))) continue;
      this.#cancelling.add(row.deliveryId);
      log.info(`answer to ${id} withdrawn from the manager's queue: the ask ${closed ? "closed" : "changed"} since`);
      void this.#queue.cancel(row.deliveryId).finally(() => this.#cancelling.delete(row.deliveryId));
    }
  }

  // The queue's word on an answer (fleet-clients §9.1, E13). While that answer is still being given, the answer itself
  // acts on the latest word once it has its Decision (#queueAnswer).
  #onDelivery(row: ManagerDeliveryRow, view: QueueView) {
    if (row.kind !== "answer" || row.escalationId === null || this.#inFlight.has(row.escalationId)) return;
    this.#applyDelivery(row, view);
    this.#notify();
  }
  // Delivered: recorded (EscalationAnswered at the time it reached the manager, with the row's own provenance, A1), even
  // when the ask holds that Decision no more (asked again since: the manager has the answer all the same). Uncertain: it
  // stays given, never opened again, not recorded. Given up: nothing reached the manager, so the ask is open again. The
  // decisions row follows, only while it is still that Decision.
  #applyDelivery(row: ManagerDeliveryRow, view: QueueView) {
    const id = row.escalationId;
    if (id === null || row.choice === null) return;
    const expected = decisionOf(row);
    if (view.state === "delivered") {
      const at = view.at ?? this.#now();
      const event = this.#x.delivered(id, expected, at) ?? answered(escalationId(id), { ...expected, delivery: { state: "delivered", at } });
      this.#store.replaceDecisionIf(id, expected.at, { ...expected, delivery: { state: "delivered", at } });
      this.#store.record([{ ...event, ...wordsOf(row) }]);
      log.info(`answer to ${id} delivered to the manager`);
    } else if (view.state === "uncertain") {
      this.#x.uncertain(id, expected);
      this.#store.replaceDecisionIf(id, expected.at, { ...expected, delivery: { state: "uncertain", at: null } });
      log.warn(`answer to ${id} may have reached the manager (typed, never seen taken): it stays answered and is never typed again`);
    } else if (view.state === "given_up") {
      this.#x.withdraw(id, expected);
      this.#store.dropDecisionIf(id, expected.at);
      log.warn(`answer to ${id} not delivered (${view.why ?? "given up"}): the ask is open again`);
    }
  }
  #notify() { const b = this.board(); for (const l of this.#listeners) l(b); }
```

In `apps/hub/src/application/escalation-service.ts` (13 of 19), replace:

```ts
    for (const m of messages) {
      if (m.author.kind === "agent" && m.kind === "text") {
        const a = parseAnswer(m.text);
        if (a.buttons) buttons.set(a.buttons.id, { message: m, body: a.body, options: a.buttons.options });   // the latest wins
      } else if (m.author.kind === "principal") {
        const t = parseTap(m.text);
        if (t) taps.set(t.id, { key: t.key, label: t.label, at: m.at });
      }
    }
```

with:

```ts
    for (const m of messages) {
      if (m.author.kind !== "agent" || m.kind !== "text") continue;
      const a = parseAnswer(m.text);
      if (a.buttons) buttons.set(a.buttons.id, { message: m, body: a.body, options: a.buttons.options });   // the latest wins
    }
    // ADR-0010 H1 (reconciliation ruling 27): an answer queued for an older ask of the same id, typed before its
    // withdrawal could stop it, answers that ask: its echo is never a tap on the newer one.
    const echoes = this.#echoesOfOlderAsks(messages, buttons);
    for (const m of messages) {
      if (m.author.kind !== "principal" || echoes.has(m.id)) continue;
      const t = parseTap(m.text);
      if (t) taps.set(t.id, { key: t.key, label: t.label, at: m.at });
    }
```

In `apps/hub/src/application/escalation-service.ts` (14 of 19), replace:

```ts
      out.push({ ask, source, answered: taps.get(id) ?? null });
    }
```

with:

```ts
      out.push({ ask, source, answered: taps.get(id) ?? null });
    }
    return out;
  }

  // The echoes of answers queued for an ask asked again since (their row's ask isn't the id's newest button message),
  // unless given up: each takes one, the first of its own tap line from its queueing on (ADR-0010 H1: another tap with
  // the same line is a new answer). An answer in words is no tap, so it has no echo to take.
  #echoesOfOlderAsks(messages: readonly Message[], buttons: ReadonlyMap<string, ButtonMessage>): Set<string> {
    const out = new Set<string>();
    if (!this.#queue) return out;
    for (const [id, b] of buttons) {
      for (const row of this.#queue.answersTo(id)) {
        if (row.ask === b.message.id || row.state === "given_up" || row.choice === null) continue;
        const c = JSON.parse(row.choice) as StoredChoice;
        if (c.kind !== "option") continue;
        const line = tapLine(id, { key: c.key, label: c.label });
        const echo = messages.find(m => m.author.kind === "principal" && !out.has(m.id) && m.at >= row.queuedAt - ECHO_SLACK_MS && m.text.trim() === line);
        if (echo) out.add(echo.id);
      }
    }
```

In `apps/hub/src/application/escalation-service.ts` (15 of 19), replace:

```ts
    const key = `${a.session.id}:${requestId}`;
    if (this.#seen.has(key)) return { ok: true, item: this.#view(id) };
```

with:

```ts
    const key = `${a.session.id}:${requestId}`;
    // A repeat of an answer the queue gave up, never typed: it reached no one, and its ask is open again (E13). Answering
    // again is a new request (#29's not_delivered; ruling 82).
    const givenUp = this.#queue?.byRequest(a.endpoint.id, requestId) ?? null;
    if (givenUp?.kind === "answer" && givenUp.escalationId === id && givenUp.state === "given_up") return { ok: false, problem: "not_delivered", item: this.#view(id) };
    if (this.#seen.has(key)) return { ok: true, item: this.#view(id) };
```

In `apps/hub/src/application/escalation-service.ts` (16 of 19), replace:

```ts
      this.poll();                                       // the list may have closed it a moment ago
      const c = this.#x.check(id, choice, this.#now());
```

with:

```ts
      this.poll();                                       // the list may have closed it a moment ago
      // A repeat of this request's answer through the manager's queue (spec §9.1): it reached the manager, may have, or
      // is queued as this ask's Decision: so it is, whatever the switch says now. Anything else (in doubt, given up, or
      // queued while its Decision was never taken: the fleet's event came, its answer didn't) is judged again below.
      const queued = this.#queue?.byRequest(a.endpoint.id, requestId) ?? null;
      if (queued?.kind === "answer" && queued.escalationId === id) {
        const held = sameDecision(this.#x.get(id)?.decision, decisionOf(queued));
        if (queued.state === "delivered" || queued.state === "uncertain" || (held && queued.state !== "sending" && queued.state !== "given_up")) {
          this.#seen.set(key, this.#now());
          return { ok: true, item: this.#view(id) };
        }
        // Still in doubt while the switch is off: it may be queued, so it is never typed by hand (ruling 49).
        if (queued.state === "sending" && this.#queue && !this.#queue.on) return { ok: false, problem: "uncertain", item: this.#view(id) };
      }
      const c = this.#x.check(id, choice, this.#now());
```

In `apps/hub/src/application/escalation-service.ts` (17 of 19), replace:

```ts
      if (seen !== undefined && seen !== this.#version(e)) return { ok: false, problem: "changed", item: this.#view(id) };
      if (!e.asker.workerId) {
```

with:

```ts
      if (seen !== undefined && seen !== this.#version(e)) return { ok: false, problem: "changed", item: this.#view(id) };
      if (this.#queue?.on && e.asker.kind === "manager") return await this.#queueAnswer(a, e, choice, requestId, key);
      if (!e.asker.workerId) {
```

In `apps/hub/src/application/escalation-service.ts` (18 of 19), replace:

```ts
      if (other) return other;
      const option = choice.kind === "option" ? e.options.find(o => o.key === choice.key) : undefined;
```

with:

```ts
      if (other) return other;
      // ... and one queued for the manager before the switch went off, still in doubt: it may be queued (E8, ruling 49).
      if (this.#queue?.sendingOf(`hub:${askPrefix(e.id, e)}`).length) {
        log.warn(`answer to ${id} refused: an answer to it through the manager's queue is in doubt; nothing is typed directly`);
        return { ok: false, problem: "answer_in_doubt", item: this.#view(id) };
      }
      const option = choice.kind === "option" ? e.options.find(o => o.key === choice.key) : undefined;
```

In `apps/hub/src/application/escalation-service.ts` (19 of 19), replace:

```ts
      this.#inFlight.delete(id);
    }
  }

```

with:

```ts
      this.#inFlight.delete(id);
    }
  }

  // The manager's answer through the fleet's queue (spec §9.1, E13): queued, it counts as given (E8) and the card says
  // so, with why it waits; the queue's later word moves it on (#onDelivery). Its id is its key (`hub:<key>`), so the
  // switch never types it twice. A manager mid-restart is no refusal: its sticky name waits on its node (spec §4.6).
  async #queueAnswer(a: Authenticated, e: Escalation, choice: Choice, requestId: string, key: string): Promise<AnswerResult> {
    const queue = this.#queue as ManagerQueue;
    const id = e.id as string;
    const k = answerKey(e.id, e, choice);
    // An answer typed directly before the queue was on, still in doubt, is settled with its node first, as below.
    const inDoubt = this.#store.send(k);
    if (inDoubt) {
      const settled = await this.#settleAnswer(a, id, choice, inDoubt, key);
      if (settled) return settled;
    }
    const other = await this.#otherAnswer(a, id, askPrefix(e.id, e), k);
    if (other) return other;
    // Another answer to this ask whose delivery is in doubt (the fleet took it and never answered) may be queued (E8).
    const deliveryId = queue.idFor(k);
    if (queue.sendingOf(`hub:${askPrefix(e.id, e)}`).some(r => r.deliveryId !== deliveryId)) {
      log.warn(`answer to ${id} refused: another answer to it may be queued for the manager (its delivery is in doubt)`);
      return { ok: false, problem: "answer_in_doubt", item: this.#view(id) };
    }
    const option = choice.kind === "option" ? e.options.find(o => o.key === choice.key) : undefined;
    const line = option ? tapLine(e.id, option) : wordsLine(e.id, choice.kind === "words" ? choice.text : "");
    const stored: StoredChoice = option ? { kind: "option", key: option.key, label: option.label }
      : { kind: "words", length: choice.kind === "words" ? choice.text.trim().length : 0, digest: digest(choice.kind === "words" ? choice.text : "") };
    const r = await queue.put({
      deliveryId, kind: "answer", escalationId: id, ask: e.messageId ?? `t${e.askedAt}`, choice: JSON.stringify(stored),
      endpointId: a.endpoint.id, sessionId: a.session.id, requestId, queuedAt: this.#now(),
    }, line);
    if (!r.ok) {
      log.warn(`answer to ${id} not queued for the manager: ${r.problem}`);
      return { ok: false, problem: r.problem === "timeout" ? "busy" : r.problem, item: this.#view(id) };
    }
    // The Decision as its row has it: a repeat in doubt keeps its first attempt's time and provenance.
    const expected = decisionOf(r.row);
    const q = this.#x.queue(id, choice, { endpointId: endpointId(r.row.endpointId), sessionId: sessionId(r.row.sessionId) }, expected.at);
    if (!q.ok) {                       // closed or asked again while it was queued: the next poll withdraws it
      log.warn(`answer to ${id} queued, but its ask no longer takes it (${q.error}); its delivery is withdrawn`);
      return { ok: false, problem: q.error, item: this.#view(id) };
    }
    this.#store.saveDecision(id, q.value);
    this.#seen.set(key, this.#now());
    log.info(`answer to ${id} queued for the manager`);
    this.#applyDelivery(r.row, queue.view(deliveryId) ?? r.view);   // the latest word: a repeat may find it delivered already
    this.#notify();
    return { ok: true, item: this.#view(id) };
  }

```

The fleet core's two `t5-answer-key-*` controls find `answerKey(e.id, e, choice)`, which the queued answer above has too: they now find the direct answer's line (ruling 51), so each is still found once.

In `scripts/negative-controls.ts`, replace:

```ts
  { id: "t5-answer-key-random", task: "5", file: "apps/hub/src/application/escalation-service.ts",
    find: "answerKey(e.id, e, choice)",
    replace: "`${answerKey(e.id, e, choice)}:${Math.random()}`",
    run: ["apps/hub/test/escalation-answer-keys.test.ts"], expect: "to deeply equal [ { pane: '%0', …(2) } ]" },
  { id: "t5-answer-key-without-ask", task: "5", file: "apps/hub/src/application/escalation-service.ts",
    find: "answerKey(e.id, e, choice)",
    replace: "answerKey(e.id, { messageId: null, askedAt: 0 }, choice)",
    run: ["apps/hub/test/escalation-answer-keys.test.ts"], expect: "expected [ 'answer:ny-7:t0:option:ship' ]" },
```

with:

```ts
  { id: "t5-answer-key-random", task: "5", file: "apps/hub/src/application/escalation-service.ts",
    find: "      const k = answerKey(e.id, e, choice);",                   // the direct answer's (fleet-clients Task 12 adds a queued one)
    replace: "      const k = `${answerKey(e.id, e, choice)}:${Math.random()}`;",
    run: ["apps/hub/test/escalation-answer-keys.test.ts"], expect: "to deeply equal [ { pane: '%0', …(2) } ]" },
  { id: "t5-answer-key-without-ask", task: "5", file: "apps/hub/src/application/escalation-service.ts",
    find: "      const k = answerKey(e.id, e, choice);",
    replace: "      const k = answerKey(e.id, { messageId: null, askedAt: 0 }, choice);",
    run: ["apps/hub/test/escalation-answer-keys.test.ts"], expect: "expected [ 'answer:ny-7:t0:option:ship' ]" },
```

- [ ] **Step 12.40: Run it and see it pass, with the escalation suites**

Run: `npx vitest run apps/hub/test/escalation-queue.test.ts`
Expected: PASS, 25 tests.

Run: `npx vitest run apps/hub/test/escalation-service.test.ts apps/hub/test/escalation-answer-keys.test.ts apps/hub/test/escalation-in-doubt.test.ts apps/hub/test/escalation-restore-age.test.ts apps/hub/test/escalation-window.test.ts apps/hub/test/escalation-menu-ids.test.ts`
Expected: PASS, every test: with no queue the service is as before.

Run: `node scripts/negative-controls.ts --check`
Expected: `ok` for `t5-answer-key-random` and `t5-answer-key-without-ask` (`found 1 time in apps/hub/src/application/escalation-service.ts`), and every other entry.

- [ ] **Step 12.41: Commit**

```bash
git add apps/hub/src/application/escalation-service.ts apps/hub/test/escalation-queue.test.ts scripts/negative-controls.ts
```

```bash
git commit -m "feat(hub): the manager's answers through the fleet's queue (E13), with its notices"
```

- [ ] **Step 12.42: Write the failing test: the manager's messages through the queue**

Create `apps/hub/test/steering-queue.test.ts`. Its last groups are ruling 83 (24 hours, and Cancel) and #29's B9 and B10 on the queue:

```ts
// The principal's messages to the manager through the fleet's delivery queue (fleet-clients §9.1): queued under the key
// a direct send types under (`hub:<endpoint>:<request>`), audited once, answered with where it stands; a repeat answers
// what became of it and queues nothing; one in doubt is asked again under its own id. Messages to other lanes stay typed
// directly. Off, the manager's are typed directly too, and one given up while off is typed then (nothing of it was typed).
// Over the fake fleet on a real Unix socket.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { fleetDeliveries } from "../src/adapters/fleet-deliveries.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import { ManagerQueue } from "../src/application/manager-queue.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { localNode, memoryBackend, type MemoryBackend } from "./helpers/fake-fleet.ts";
import { fleetRig, type FleetRig } from "./helpers/hub-mode.ts";

const T0 = Date.UTC(2026, 9, 8, 9);
const MANAGER = "pc.aaaaaaaa.0";
const ALPHA = "pc.aaaaaaaa.1";
let dir: string;
let store: Store;
let backend: MemoryBackend;
let rig: FleetRig;
let queues: ManagerQueue[] = [];
const auth: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: T0, lastSeenAt: T0, verifiedAt: T0, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: T0, revokedAt: null },
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-steering-queue-"));
  store = new Store(dir);
  backend = memoryBackend({ "%0": { name: "manager", cwd: "/w/manager", screen: "❯ ", sessionId: "s-m" }, "%1": { name: "alpha", cwd: "/w/alpha", screen: "❯ ", sessionId: "s-a" } });
  rig = await fleetRig([localNode("pc", "aaaaaaaa", backend)]);
});
afterEach(async () => { for (const q of queues.splice(0)) q.stop(); await rig.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

// SteeringService as main.ts builds it with a fleet: the manager's pane goes through the queue while it is on.
async function steering(o: { on?: boolean } = {}) {
  const queue = new ManagerQueue({ store, deliveries: fleetDeliveries(rig.client), lane: "manager", on: o.on ?? true, now: () => T0, pollMs: 60_000 });
  await queue.start();
  queues.push(queue);
  const svc = new SteeringService(store, rig.ports.tmux, () => T0, undefined, null, () => "none", () => null, rig.ports.uploads, rig.ports.sendStatus,
    { queue, isManager: id => id === MANAGER });
  return { svc, queue };
}
const commandsSent = () => store.audit(50).filter(a => a.type === "CommandSent");

describe("a message to the manager through the queue", () => {
  it("is queued under the key a direct send would use, audited once, and answered with where it stands", async () => {
    const { svc } = await steering();
    const r = await svc.send(auth, MANAGER, "status please", "r1");
    expect(r).toEqual({ ok: true, at: expect.any(Number), delivery: { requestId: "r1", state: "queued", waiting: null, why: null } });
    expect(rig.fleet.deliveryCalls).toEqual([{ id: "hub:ep1:r1", lane: "manager", workerId: null, text: "status please" }]);
    expect(backend.typed).toEqual([]);
    expect(commandsSent()).toHaveLength(1);
  });

  it("a repeat answers what became of it, and queues nothing", async () => {
    const { svc, queue } = await steering();
    await svc.send(auth, MANAGER, "status please", "r1");
    rig.fleet.moveDelivery("hub:ep1:r1", { state: "delivered", deliveredAt: T0 + 9 });
    await queue.poll();
    expect(await svc.send(auth, MANAGER, "status please", "r1")).toEqual({ ok: false, problem: "duplicate", at: T0 + 9, delivery: { requestId: "r1", state: "delivered", waiting: null, why: null } });
    expect(rig.fleet.deliveryCalls).toHaveLength(1);
    expect(commandsSent()).toHaveLength(1);
  });

  it("one in doubt (the fleet never answered, nor told) is uncertain; its repeat finds it, once", async () => {
    const { svc } = await steering();
    rig.fleet.loseDeliveryAnswers(1);
    rig.fleet.quietDeliveries(true);
    expect(await svc.send(auth, MANAGER, "status please", "r1")).toEqual({ ok: false, problem: "uncertain" });
    expect(commandsSent()).toHaveLength(1);                                    // recorded when the hub queued it (ruling 28)
    expect(await svc.send(auth, MANAGER, "status please", "r1")).toMatchObject({ ok: true, delivery: { state: "queued" } });
    expect(rig.fleet.deliveries.size).toBe(1);
    expect(commandsSent()).toHaveLength(1);
  });

  it("a refusal says why, and nothing is queued or audited", async () => {
    const { svc } = await steering();
    await rig.client.lanes();
    await rig.fleet.setStatus("pc", "offline");
    expect(await svc.send(auth, MANAGER, "status please", "r1")).toEqual({ ok: false, problem: "node_offline" });
    expect(commandsSent()).toEqual([]);
  });

  it("a message to another lane is typed directly, as before", async () => {
    const { svc } = await steering();
    expect(await svc.send(auth, ALPHA, "carry on", "r1")).toMatchObject({ ok: true });
    expect(backend.typed).toEqual([{ pane: "%1", text: "carry on", key: "hub:ep1:r1" }]);
    expect(rig.fleet.deliveryCalls).toEqual([]);
  });
});

describe("the switch off", () => {
  it("the manager's messages are typed directly, under the same key (negative control)", async () => {
    const { svc } = await steering({ on: false });
    expect(await svc.send(auth, MANAGER, "status please", "r1")).toMatchObject({ ok: true });
    expect(backend.typed).toEqual([{ pane: "%0", text: "status please", key: "hub:ep1:r1" }]);
    expect(rig.fleet.deliveryCalls).toEqual([]);
  });

  it("a message still in doubt is never typed directly on its repeat (ruling 49)", async () => {
    const { svc } = await steering({ on: false });
    // In doubt: its cancel at start went unanswered, so its row is still "sending".
    store.saveManagerDelivery({ deliveryId: "hub:ep1:r1", kind: "command", escalationId: null, ask: null, choice: null, endpointId: "ep1", sessionId: "s1", requestId: "r1", queuedAt: T0, state: "sending", updatedAt: T0 });
    expect(await svc.send(auth, MANAGER, "status please", "r1")).toEqual({ ok: false, problem: "uncertain" });
    expect(backend.typed).toEqual([]);
  });

  it("one given up while the switch is off is typed directly on its repeat; while on, the repeat says given up", async () => {
    const on = await steering();
    await on.svc.send(auth, MANAGER, "status please", "r1");
    rig.fleet.moveDelivery("hub:ep1:r1", { state: "given_up", why: "expired" });
    await on.queue.poll();
    expect(await on.svc.send(auth, MANAGER, "status please", "r1")).toMatchObject({ ok: false, problem: "duplicate", delivery: { state: "given_up", why: "expired" } });
    on.queue.stop();
    const off = await steering({ on: false });
    expect(await off.svc.send(auth, MANAGER, "status please", "r1")).toMatchObject({ ok: true });
    expect(backend.typed).toEqual([{ pane: "%0", text: "status please", key: "hub:ep1:r1" }]);
  });
});

describe("waiting, and the principal's cancel (ruling 83: up to 24 hours, with why it waits and a cancel; no two-minute deadline, no Retry)", () => {
  const HOUR = 3_600_000;
  const waits = (id: string) => { const d = rig.fleet.deliveries.get(id)?.delivery; return d ? d.notAfter - d.queuedAt : null; };

  it("waits up to 24 hours from when it was written; a time that can't be right counts from its arrival", async () => {
    const { svc } = await steering();
    await svc.send(auth, MANAGER, "written an hour ago", "r1", [], undefined, undefined, T0 - HOUR);
    await svc.send(auth, MANAGER, "no time given", "r2");
    await svc.send(auth, MANAGER, "a clock ahead", "r3", [], undefined, undefined, T0 + HOUR);
    await svc.send(auth, MANAGER, "two days old", "r4", [], undefined, undefined, T0 - 48 * HOUR);
    expect(["hub:ep1:r1", "hub:ep1:r2", "hub:ep1:r3", "hub:ep1:r4"].map(waits)).toEqual([23 * HOUR, 24 * HOUR, 24 * HOUR, 24 * HOUR]);
  });

  it("still waiting: the principal cancels it, and nothing reaches the manager", async () => {
    const { svc } = await steering();
    await svc.send(auth, MANAGER, "never mind", "r1");
    rig.fleet.moveDelivery("hub:ep1:r1", { waiting: { reason: "busy", since: T0 } });
    expect(await svc.cancel(auth, "r1")).toEqual({ ok: true, delivery: { requestId: "r1", state: "given_up", waiting: null, why: "cancelled" } });
    expect(rig.fleet.cancels).toEqual(["hub:ep1:r1"]);
    expect(await svc.cancel(auth, "r1")).toMatchObject({ ok: true, delivery: { state: "given_up" } });   // again: what it came to
    expect(backend.typed).toEqual([]);
  });

  it("typed already: too late; another device's message, or a message to another lane, is no such message (negative control)", async () => {
    const { svc } = await steering();
    await svc.send(auth, MANAGER, "status please", "r1");
    rig.fleet.moveDelivery("hub:ep1:r1", { state: "typed", typedAt: T0 + 5 });
    expect(await svc.cancel(auth, "r1")).toEqual({ ok: false, problem: "already_typed" });
    const other: Authenticated = { ...auth, endpoint: { ...auth.endpoint, id: endpointId("ep2") } };
    expect(await svc.cancel(other, "r1")).toEqual({ ok: false, problem: "unknown" });
    await svc.send(auth, ALPHA, "carry on", "r2");
    expect(await svc.cancel(auth, "r2")).toEqual({ ok: false, problem: "unknown" });
  });
});

// #29's review cases (its tests went with its inbox; ruling 81), on the queue.
describe("#29's review cases, on the queue", () => {
  it("B9: a message empty once control characters go is refused as empty, and nothing is queued", async () => {
    const { svc } = await steering();
    expect(await svc.send(auth, MANAGER, "\u001b\u0007\u0000 \r\n", "r1")).toEqual({ ok: false, problem: "empty" });
    expect(rig.fleet.deliveryCalls).toEqual([]);
  });

  it("B10: the manager is the pane its window has now; with that window gone, a message is no_pane, and nothing is queued", async () => {
    const queue = new ManagerQueue({ store, deliveries: fleetDeliveries(rig.client), lane: "manager", on: true, now: () => T0, pollMs: 60_000 });
    await queue.start();
    queues.push(queue);
    // As main.ts wires it: the manager is the pane the roster names for the manager's window, right now.
    const managerPane = () => (backend.panes["%0"] ? MANAGER : null);
    const svc = new SteeringService(store, rig.ports.tmux, () => T0, undefined, null, () => "none", () => null, rig.ports.uploads, rig.ports.sendStatus,
      { queue, isManager: id => id === managerPane() });
    expect(await svc.send(auth, MANAGER, "status please", "r1")).toMatchObject({ ok: true, delivery: { state: "queued" } });
    delete backend.panes["%0"];
    expect(await svc.send(auth, MANAGER, "are you there?", "r2")).toEqual({ ok: false, problem: "no_pane" });
    expect(rig.fleet.deliveryCalls.map(c => c.id)).toEqual(["hub:ep1:r1"]);
  });
});
```

- [ ] **Step 12.43: Run it and see it fail**

Run: `npx vitest run apps/hub/test/steering-queue.test.ts`
Expected: FAIL, 9 of 13: `AssertionError: expected { ok: true, at: … } to deeply equal { ok: true, at: Any<Number>, …(1) }`, `Error: no delivery hub:ep1:r1` (four), twice `AssertionError: expected { ok: true, at: … } to deeply equal { ok: false, problem: 'uncertain' }` (the message in doubt, and the one in doubt once off), `AssertionError: expected [ null, null, null, null ] to deeply equal [ 82800000, 86400000, 86400000, …(1) ]`, and `AssertionError: expected { ok: true, at: … } to match object { ok: true, …(1) }` (B10). Messages to other lanes, a refusal, the switch off and B9 pass already.

- [ ] **Step 12.44: Implement the messages through the queue, their 24 hours and their Cancel**

A message to the manager's pane goes to the queue after the same checks as one typed directly (S6, the worker it was written to, its images staged, `cleanText`), under the key a direct send uses. The send's `createdAt` comes back as its 24 hours; `cancel` withdraws one still waiting.

In `apps/hub/src/application/steering-service.ts` (1 of 11), replace:

```ts
import type { SendProblem } from "@morndo/node-ops";
import { LIMITS } from "@morndo/protocol";
import { ownerFileNote } from "../adapters/attachment-note.ts";
```

with:

```ts
import type { SendProblem } from "@morndo/node-ops";
import { LIMITS, type ErrorCode, type QueuedCommand } from "@morndo/protocol";
import { ownerFileNote } from "../adapters/attachment-note.ts";
```

In `apps/hub/src/application/steering-service.ts` (2 of 11), replace:

```ts
import { log } from "../adapters/log.ts";

// `at`: when the node typed it, on that node's clock, which its transcript's times are on: the app matches the echo by
// it (fleet core §3.1; before, the hub's own clock, review M2).
export type SendResult =
  | { ok: true; at: number }
  | { ok: false; problem: "duplicate"; at: number }
  | { ok: false; problem: SendProblem | AttachRefusal | SendRefused | "step_up" | "empty" | "too_long" | "uncertain" | "stale" | "too_large" | "node_offline" };

```

with:

```ts
import { log } from "../adapters/log.ts";
import { queuedCommand, type ManagerQueue } from "./manager-queue.ts";

// `at`: when the node typed it, on that node's clock, which its transcript's times are on: the app matches the echo by
// it (fleet core §3.1; before, the hub's own clock, review M2). `delivery`: a message to the manager through the fleet's
// queue (fleet-clients §9.1), where it stands; `at` is then when it was queued (or typed, or delivered), on that clock.
export type SendResult =
  | { ok: true; at: number; delivery?: QueuedCommand }
  | { ok: false; problem: "duplicate"; at: number; delivery?: QueuedCommand }
  | { ok: false; problem: SendProblem | AttachRefusal | SendRefused | "step_up" | "empty" | "too_long" | "uncertain" | "stale" | "too_large" | "node_offline" };
// A cancel of a message to the manager: withdrawn (its delivery, given up), or why not ("unknown": no such message of
// this device's; "already_typed": too late; "uncertain": the fleet never answered the cancel; or the fleet's refusal).
export type MessageCancel = { ok: true; delivery: QueuedCommand } | { ok: false; problem: ErrorCode | "unknown" };

```

In `apps/hub/src/application/steering-service.ts` (3 of 11), replace:

```ts
  #status: SendStatus | null;                                // the fleet's op.status; null: the legacy hub, nobody else knows

```

with:

```ts
  #status: SendStatus | null;                                // the fleet's op.status; null: the legacy hub, nobody else knows
  // The manager's queue (fleet-clients §9.1) and which worker is the manager; null without a fleet.
  #manager: { queue: ManagerQueue; isManager: (workerId: string) => boolean } | null;

```

In `apps/hub/src/application/steering-service.ts` (4 of 11), replace:

```ts
    status: SendStatus | null = null,
  ) {
    this.#status = status;
```

with:

```ts
    status: SendStatus | null = null,
    manager: { queue: ManagerQueue; isManager: (workerId: string) => boolean } | null = null,
  ) {
    this.#manager = manager;
    this.#status = status;
```

In `apps/hub/src/application/steering-service.ts` (5 of 11), replace:

```ts
  // `name`: the worker it was written to; a pane that now runs another agent is no longer that worker (review M2).
  async send(a: Authenticated, workerId: string, text: string, requestId: string, uploads: string[] = [], seen?: string, name?: string): Promise<SendResult> {
    const now = this.#now();
```

with:

```ts
  // `name`: the worker it was written to; a pane that now runs another agent is no longer that worker (review M2).
  // `createdAt`: when he wrote it, on the device's clock (S7): a message to the manager waits up to 24 hours from then.
  async send(a: Authenticated, workerId: string, text: string, requestId: string, uploads: string[] = [], seen?: string, name?: string, createdAt?: number): Promise<SendResult> {
    const now = this.#now();
```

In `apps/hub/src/application/steering-service.ts` (6 of 11), replace:

```ts
      const first = await typing;
      return first.ok ? { ok: false, problem: "duplicate", at: first.at } : first;
    }
```

with:

```ts
      const first = await typing;
      return first.ok ? { ok: false, problem: "duplicate", at: first.at, ...(first.delivery ? { delivery: first.delivery } : {}) } : first;
    }
    // A message handed to the manager's queue before (fleet-clients §9.1): what became of it, whatever the switch says
    // now, and nothing queued again. One in doubt ("sending") is judged again below and asked again under its own id. One
    // given up while the switch is off is typed directly (nothing of it was typed, so its key is free on the node).
    const queued = this.#manager?.queue.byRequest(a.endpoint.id, requestId) ?? null;
    // One still in doubt while the switch is off (its cancel at start went unanswered) may be queued: never typed by
    // hand (ruling 49). It stays "uncertain" until the queue is on again, or its row is pruned.
    if (queued?.kind === "command" && queued.state === "sending" && this.#manager && !this.#manager.queue.on) {
      log.warn(`send to ${workerId}: its delivery through the manager's queue is in doubt; never typed directly`);
      return { ok: false, problem: "uncertain" };
    }
    if (queued?.kind === "command" && queued.state !== "sending") {
      const queue = this.#manager?.queue;
      if (queued.state === "given_up" && queue && !queue.on) queue.forget(queued.deliveryId);
      else {
        const view = queue?.view(queued.deliveryId) ?? null;
        return { ok: false, problem: "duplicate", at: view?.at ?? queued.queuedAt, ...(view ? { delivery: queuedCommand(queued, view) } : {}) };
      }
    }
```

In `apps/hub/src/application/steering-service.ts` (7 of 11), replace:

```ts
    // meanwhile waits for this one: two repeats of a send in doubt at once paste it at most once.
    const job = this.#judge(a, key, workerId, text, uploads, now, known?.state === "started", seen, name);
    this.#typing.set(key, job);
```

with:

```ts
    // meanwhile waits for this one: two repeats of a send in doubt at once paste it at most once.
    const job = this.#judge(a, key, workerId, text, uploads, now, known?.state === "started", seen, name, createdAt);
    this.#typing.set(key, job);
```

In `apps/hub/src/application/steering-service.ts` (8 of 11), replace:

```ts
  // A send in doubt is settled with its node first; then the send is judged on arrival and typed.
  async #judge(a: Authenticated, key: string, workerId: string, text: string, uploads: string[], now: number, inDoubt: boolean, seen?: string, name?: string): Promise<SendResult> {
    if (inDoubt) {
```

with:

```ts
  // A send in doubt is settled with its node first; then the send is judged on arrival and typed.
  async #judge(a: Authenticated, key: string, workerId: string, text: string, uploads: string[], now: number, inDoubt: boolean, seen?: string, name?: string, createdAt?: number): Promise<SendResult> {
    if (inDoubt) {
```

In `apps/hub/src/application/steering-service.ts` (9 of 11), replace:

```ts
    if (refused) return refused;
    return this.#stageAndType(a, key, workerId, text, uploads, now);
  }
```

with:

```ts
    if (refused) return refused;
    return this.#stageAndType(a, key, workerId, text, uploads, now, createdAt);
  }
```

In `apps/hub/src/application/steering-service.ts` (10 of 11), replace:

```ts

  // A refusal from #prepare writes no row, so a retry may type it.
  async #stageAndType(a: Authenticated, key: string, workerId: string, text: string, uploads: string[], now: number): Promise<SendResult> {
    const prepared = await this.#prepare(a, workerId, text, uploads, now);
    if (!prepared.ok) return prepared;
    if (!this.#store.startSend(key, now)) return { ok: false, problem: "uncertain" };
```

with:

```ts

  // A refusal from #prepare writes no row, so a retry may type it. To the manager with the queue on: queued, not typed.
  async #stageAndType(a: Authenticated, key: string, workerId: string, text: string, uploads: string[], now: number, createdAt?: number): Promise<SendResult> {
    const prepared = await this.#prepare(a, workerId, text, uploads, now);
    if (!prepared.ok) return prepared;
    if (this.#manager?.queue.on && this.#manager.isManager(workerId)) return this.#queueCommand(a, key, workerId, prepared.body, uploads.length, now, createdAt);
    if (!this.#store.startSend(key, now)) return { ok: false, problem: "uncertain" };
```

In `apps/hub/src/application/steering-service.ts` (11 of 11), replace:

```ts
    return this.#type(key, workerId, prepared.body, audit);
  }
```

with:

```ts
    return this.#type(key, workerId, prepared.body, audit);
  }

  // A message to the manager through the fleet's queue (fleet-clients §9.1), under the key a direct send types it under
  // (`hub:<endpoint>:<request>`), so the switch never types it twice. CommandSent is recorded when the hub queues it (its
  // provenance, ADR-0006; reconciliation ruling 28): once, at its first attempt the fleet didn't refuse, whether or not
  // its answer came back. The delivery's outcome is its own (its row, the fleet's audit, §8). It waits up to 24 hours
  // from when he wrote it (ruling 83: busy, at a menu, behind his draft; no two-minute deadline): `createdAt`, unless that
  // time can't be right (ahead of this clock, or past the 24 hours), when they count from its arrival.
  async #queueCommand(a: Authenticated, key: string, workerId: string, body: string, attachments: number, now: number, createdAt?: number): Promise<SendResult> {
    const queue = (this.#manager as { queue: ManagerQueue }).queue;
    const requestId = key.slice(a.endpoint.id.length + 1);
    const first = queue.row(`hub:${key}`) === null;
    const age = now - (createdAt ?? now);
    const ttlMs = createdAt !== undefined && age > 0 && age < LIMITS.deliveryTtlMs ? LIMITS.deliveryTtlMs - age : undefined;
    const r = await queue.put({
      deliveryId: `hub:${key}`, kind: "command", escalationId: null, ask: null, choice: null,
      endpointId: a.endpoint.id, sessionId: a.session.id, requestId, queuedAt: now,
    }, body, ttlMs);
    if (first && (r.ok || r.problem === "uncertain")) this.#store.record([this.#commandSent(a, workerId, body, attachments, now)]);
    if (!r.ok) {
      log.warn(`send to ${workerId} not queued for the manager: ${r.problem}`);   // never the text
      return { ok: false, problem: r.problem === "timeout" ? "busy" : r.problem };
    }
    log.info(`send to ${workerId} queued for the manager`);
    return { ok: true, at: r.view.at ?? r.delivery.queuedAt, delivery: queuedCommand(r.row, r.view) };
  }

  // The principal's cancel of one of his messages to the manager still waiting in the fleet's queue (ruling 83, spec
  // §9.1): only his own device's, and only one not typed yet. It types nothing, so it asks no fresh passkey. Given up
  // already: that is its answer. Delivered, or typed and never seen taken: too late.
  async cancel(a: Authenticated, requestId: string): Promise<MessageCancel> {
    const queue = this.#manager?.queue;
    const row = queue?.byRequest(a.endpoint.id, requestId) ?? null;
    if (!queue || row?.kind !== "command") return { ok: false, problem: "unknown" };
    const view = queue.view(row.deliveryId);
    if (row.state === "given_up" && view) return { ok: true, delivery: queuedCommand(row, view) };
    if (row.state === "delivered" || row.state === "uncertain") return { ok: false, problem: "already_typed" };
    const r = await queue.cancel(row.deliveryId);
    if (!r.ok) return { ok: false, problem: r.problem };
    log.info(`a message to the manager was cancelled before it was typed (${row.deliveryId})`);
    return { ok: true, delivery: queuedCommand(queue.row(row.deliveryId) ?? row, r.view) };
  }
```

- [ ] **Step 12.45: Run it and see it pass, with the steering suites**

Run: `npx vitest run apps/hub/test/steering-queue.test.ts apps/hub/test/steering.test.ts apps/hub/test/fleet-steering.test.ts apps/hub/test/steering-durable.test.ts apps/hub/test/steering-keys.test.ts`
Expected: PASS, every test (`steering-queue.test.ts`: 13).

- [ ] **Step 12.46: Commit**

```bash
git add apps/hub/src/application/steering-service.ts apps/hub/test/steering-queue.test.ts
```

```bash
git commit -m "feat(hub): the manager's messages through the fleet's queue: up to 24 hours, and a cancel"
```

- [ ] **Step 12.47: Write the failing test of the feed's deliveries and the cancel route**

Create `apps/hub/test/http-manager-queue.test.ts`:

```ts
// The feed tells each device where its messages to the manager stand in the fleet's delivery queue (fleet-clients §9.1;
// the app's words are Task 13's): every one of the last day after a hello, then each change, by request id; never
// another device's. And the principal cancels one still waiting (ruling 83). A real hub HTTP server in this process, its
// queue over the fake fleet on a real Unix socket.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { FleetClient } from "@morndo/fleet-client";
import { fleetDeliveries } from "../src/adapters/fleet-deliveries.ts";
import { ManagerQueue, type NewDelivery } from "../src/application/manager-queue.ts";
import { localNode, memoryBackend, startFakeFleet, until, type FakeFleet } from "./helpers/fake-fleet.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import { frameText } from "./http-crash-fixture.ts";

let fleet: FakeFleet;
let hub: InProcessHub;
let queue: ManagerQueue | null = null;
let ws: WebSocket | null = null;
beforeEach(async () => {
  fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", memoryBackend({ "%0": { name: "manager", cwd: "/w/m", screen: "❯ ", sessionId: "s-m" } }))] });
  hub = await startInProcessHub({ queue: store => (queue = new ManagerQueue({ store, deliveries: fleetDeliveries(new FleetClient(fleet.socketPath)), lane: "manager", on: true, pollMs: 60_000 })) });
});
afterEach(async () => { ws?.close(); queue?.stop(); await hub.close(); await fleet.close(); });

const command = (endpointId: string, request: string): NewDelivery => ({
  deliveryId: `hub:${endpointId}:${request}`, kind: "command", escalationId: null, ask: null, choice: null, endpointId, sessionId: "s1", requestId: request, queuedAt: Date.now(),
});
async function feed(cookie: string) {
  const frames: { t: string; items?: unknown[] }[] = [];
  ws = await hub.socket("/api/feed", cookie);
  ws.on("message", raw => frames.push(JSON.parse(frameText(raw)) as { t: string; items?: unknown[] }));
  ws.send(JSON.stringify({ t: "hello" }));
  return frames;
}
const items = (frames: { t: string; items?: unknown[] }[]) => frames.filter(f => f.t === "deliveries").flatMap(f => f.items ?? []);

describe("the deliveries frame", () => {
  it("after a hello: this device's messages to the manager; then each change", async () => {
    const cookie = await hub.cookie();
    const me = hub.store.endpoints()[0]?.id ?? "";
    const q = queue as unknown as ManagerQueue;
    await q.start();
    await q.put(command(me, "r1"), "status please");
    const frames = await feed(cookie);
    await until(() => items(frames).length === 1);
    expect(items(frames)).toEqual([{ requestId: "r1", state: "queued", waiting: null, why: null }]);
    fleet.moveDelivery(`hub:${me}:r1`, { waiting: { reason: "draft_present", since: 1 } });
    fleet.moveDelivery(`hub:${me}:r1`, { state: "delivered", deliveredAt: 9 });
    await until(() => items(frames).some(i => (i as { state: string }).state === "delivered"));
    expect(items(frames).slice(1)).toEqual([
      { requestId: "r1", state: "queued", waiting: "draft_present", why: null },
      { requestId: "r1", state: "delivered", waiting: null, why: null },
    ]);
  });

  it("never another device's (negative control)", async () => {
    const cookie = await hub.cookie();
    const q = queue as unknown as ManagerQueue;
    await q.start();
    await q.put(command("ep-other", "r9"), "someone else's");
    const frames = await feed(cookie);
    await until(() => frames.some(f => f.t === "decisions"));
    fleet.moveDelivery("hub:ep-other:r9", { state: "delivered", deliveredAt: 9 });
    await new Promise(r => setTimeout(r, 200));
    expect(items(frames)).toEqual([]);
  });
});

describe("POST /api/manager/cancel (ruling 83)", () => {
  it("cancels one of this device's messages still waiting; too late once typed; no such message of another device's", async () => {
    const cookie = await hub.cookie();
    const me = hub.store.endpoints()[0]?.id ?? "";
    const q = queue as unknown as ManagerQueue;
    await q.start();
    await q.put(command(me, "11111111-1111-4111-8111-111111111111"), "never mind");
    await q.put(command(me, "22222222-2222-4222-8222-222222222222"), "status please");
    await q.put(command("ep-other", "33333333-3333-4333-8333-333333333333"), "someone else's");
    fleet.moveDelivery(`hub:${me}:22222222-2222-4222-8222-222222222222`, { state: "typed", typedAt: 5 });
    const cancel = async (requestId: string) => {
      const r = await hub.post("/api/manager/cancel", { requestId }, { cookie: `__Host-morndo=${cookie}` });
      return { status: r.status, body: await r.json() as unknown };
    };
    expect(await cancel("11111111-1111-4111-8111-111111111111")).toEqual({ status: 200, body: { ok: true, delivery: { requestId: "11111111-1111-4111-8111-111111111111", state: "given_up", waiting: null, why: "cancelled" } } });
    expect(await cancel("22222222-2222-4222-8222-222222222222")).toEqual({ status: 409, body: { error: "already_typed" } });
    expect(await cancel("33333333-3333-4333-8333-333333333333")).toEqual({ status: 404, body: { error: "unknown" } });
    expect(fleet.deliveries.get("hub:ep-other:33333333-3333-4333-8333-333333333333")?.delivery.state).toBe("queued");
  });
});
```

- [ ] **Step 12.48: Run it and see it fail**

Run: `npx vitest run apps/hub/test/http-manager-queue.test.ts`
Expected: FAIL, 3 of 3, each `TypeError: Cannot read properties of null (reading 'start')`: the in-process hub makes no queue yet.

- [ ] **Step 12.49: The feed's deliveries, a duplicate's delivery, and `POST /api/manager/cancel`**

In `apps/hub/src/adapters/http.ts` (1 of 7), replace:

```ts
import type { NotificationService } from "../application/notification-service.ts";
import type { EnginesService } from "../application/engines-service.ts";
```

with:

```ts
import type { NotificationService } from "../application/notification-service.ts";
import { queuedCommand, type ManagerQueue } from "../application/manager-queue.ts";
import type { EnginesService } from "../application/engines-service.ts";
```

In `apps/hub/src/adapters/http.ts` (2 of 7), replace:

```ts
import {
  AnswerBody, BoardActionBody, BoardCreateBody, ClientFeedFrames, ClientTerminalFrames, EnginesSaveBody, UsageReportBody, IdentityProveBody, LinkDecisionBody, PairCheckBody, PairOptionsBody, PasskeyVerifyBody, PolicyBody, PushSubscriptionBody, SendBody,
  decode, isWorkerOrLegacyId, parseBody, type FrameOf, type Output, type Schema,
```

with:

```ts
import {
  AnswerBody, BoardActionBody, BoardCreateBody, CancelBody, ClientFeedFrames, ClientTerminalFrames, EnginesSaveBody, UsageReportBody, IdentityProveBody, LinkDecisionBody, PairCheckBody, PairOptionsBody, PasskeyVerifyBody, PolicyBody, PushSubscriptionBody, SendBody,
  decode, isWorkerOrLegacyId, parseBody, type FrameOf, type Output, type Schema,
```

In `apps/hub/src/adapters/http.ts` (3 of 7), replace:

```ts
  usage?: UsageService | null;                                              // ADR-0016: the accounts' usage; null: off
}) {
```

with:

```ts
  usage?: UsageService | null;                                              // ADR-0016: the accounts' usage; null: off
  queue?: ManagerQueue | null;                                              // the manager's delivery queue (fleet-clients §9.1); null without a fleet
}) {
```

In `apps/hub/src/adapters/http.ts` (4 of 7), replace:

```ts
      const body = await readBody(req, SendBody);
      const r = await steering.send(a, sendTo, body.text, body.requestId, body.uploads ?? [], body.seen, body.name);
      if (r.ok) return json(res, 200, r);
      if (r.problem === "duplicate") return json(res, 200, { error: "duplicate", ok: true, at: r.at });
      return json(res, r.problem === "step_up" ? 403 : r.problem === "no_pane" ? 404 : 409, { error: r.problem });
    }
```

with:

```ts
      const body = await readBody(req, SendBody);
      const r = await steering.send(a, sendTo, body.text, body.requestId, body.uploads ?? [], body.seen, body.name, body.createdAt);
      if (r.ok) return json(res, 200, r);
      if (r.problem === "duplicate") return json(res, 200, { error: "duplicate", ok: true, at: r.at, ...(r.delivery ? { delivery: r.delivery } : {}) });
      return json(res, r.problem === "step_up" ? 403 : r.problem === "no_pane" ? 404 : 409, { error: r.problem });
    }
    // The principal's cancel of one of his messages to the manager still waiting in the fleet's queue (ruling 83; spec
    // §9.1): 200 with where it stands now (given up, cancelled), 409 when it is too late, 404 for no such message of his.
    if (path === "/api/manager/cancel" && method === "POST") {
      limited(buckets.commands.take(a.endpoint.id));
      const body = await readBody(req, CancelBody);
      const r = await steering.cancel(a, body.requestId);
      if (r.ok) return json(res, 200, r);
      return json(res, r.problem === "unknown" ? 404 : 409, { error: r.problem });
    }
```

In `apps/hub/src/adapters/http.ts` (5 of 7), replace:

```ts
      const unsubscribeUsage = p.usage?.subscribe(v => send({ t: "usage", ...v })) ?? (() => false);
      // Older pages, one at a time per connection (fleet core §3.1): each waits for the one before it.
```

with:

```ts
      const unsubscribeUsage = p.usage?.subscribe(v => send({ t: "usage", ...v })) ?? (() => false);
      // Where this device's messages to the manager stand in the fleet's queue (fleet-clients §9.1): each change, by
      // request id; never another device's.
      const unsubscribeQueue = p.queue?.subscribe(c => {
        if (c.row.kind === "command" && c.row.endpointId === conn.auth.endpoint.id) send({ t: "deliveries", items: [queuedCommand(c.row, c.view)] });
      }) ?? (() => false);
      // Older pages, one at a time per connection (fleet core §3.1): each waits for the one before it.
```

In `apps/hub/src/adapters/http.ts` (6 of 7), replace:

```ts
      ws.on("pong", () => { conn.alive = true; });
      ws.on("close", () => { conns.delete(conn); unsubscribe(); unsubscribeBoard(); unsubscribeTasks(); unsubscribeUsage(); unsubscribeReading(); p.push?.notifications.left(conn.id); });
      // Every frame is decoded (ADR-0008, A2): malformed closes with 1003, a type this hub doesn't know is ignored.
```

with:

```ts
      ws.on("pong", () => { conn.alive = true; });
      ws.on("close", () => { conns.delete(conn); unsubscribe(); unsubscribeBoard(); unsubscribeTasks(); unsubscribeUsage(); unsubscribeQueue(); unsubscribeReading(); p.push?.notifications.left(conn.id); });
      // Every frame is decoded (ADR-0008, A2): malformed closes with 1003, a type this hub doesn't know is ignored.
```

In `apps/hub/src/adapters/http.ts` (7 of 7), replace:

```ts
            if (p.usage) send({ t: "usage", ...p.usage.view() });           // ADR-0016: every account, after every hello
            if (p.reading) send(p.reading.state());           // all marks and mutes: they may have moved while away
```

with:

```ts
            if (p.usage) send({ t: "usage", ...p.usage.view() });           // ADR-0016: every account, after every hello
            if (p.queue) send({ t: "deliveries", items: p.queue.commandsOf(conn.auth.endpoint.id) });   // all of the last day
            if (p.reading) send(p.reading.state());           // all marks and mutes: they may have moved while away
```

In `packages/protocol/src/http.ts`, replace:

```ts
});
// `seen`: the version of the ask the answer was given for (askVersion; review of PR #7, finding 5). Optional: the
```

with:

```ts
});
// The principal's cancel of one of his messages to the manager still waiting in the fleet's delivery queue (ruling 83).
export const CancelBody = z.object({ requestId });
export type CancelBody = z.output<typeof CancelBody>;
// `seen`: the version of the ask the answer was given for (askVersion; review of PR #7, finding 5). Optional: the
```

The in-process hub takes a queue on its own store, and gives it to its steering as the manager's (this hub has no manager pane: a test puts deliveries on the queue itself):

In `apps/hub/test/inprocess-hub.ts` (1 of 3), replace:

```ts
import type { Config } from "../src/config.ts";

```

with:

```ts
import type { Config } from "../src/config.ts";
import type { ManagerQueue } from "../src/application/manager-queue.ts";

```

In `apps/hub/test/inprocess-hub.ts` (2 of 3), replace:

```ts
// `engines`: the engine layer's CLI to run (a test's fake) and its environment; absent, the Engines page is off.
export async function startInProcessHub(o: { limits?: Limits; heartbeatMs?: number; now?: () => number; observation?: ObservationService; engines?: { bin: string; env: NodeJS.ProcessEnv } } = {}): Promise<InProcessHub> {
  const dir = mkdtempSync(join(tmpdir(), "morndo-inproc-"));
```

with:

```ts
// `engines`: the engine layer's CLI to run (a test's fake) and its environment; absent, the Engines page is off.
// `queue`: the manager's delivery queue, made on the hub's own store (fleet-clients §9.1; default none). This hub has no
// manager pane: a test puts deliveries on the queue itself, and the feed and the cancel route follow them.
export async function startInProcessHub(o: { limits?: Limits; heartbeatMs?: number; now?: () => number; observation?: ObservationService; engines?: { bin: string; env: NodeJS.ProcessEnv }; queue?: (store: Store) => ManagerQueue } = {}): Promise<InProcessHub> {
  const dir = mkdtempSync(join(tmpdir(), "morndo-inproc-"));
```

In `apps/hub/test/inprocess-hub.ts` (3 of 3), replace:

```ts
  const usage = new UsageService({ store, ...(o.now ? { now: o.now } : {}) });
  const http = startHttp({
    config, identity: loadOrCreateIdentity(dir), access, observation: o.observation ?? new ObservationService(tmux, 1000),
    steering: new SteeringService(store, tmux, o.now ?? Date.now, () => access.policy(), inbox), escalations, remote, inbox, reading: new ReadingService(store),
    push: { publicKey: vapid.publicKey, notifications },
```

with:

```ts
  const usage = new UsageService({ store, ...(o.now ? { now: o.now } : {}) });
  const queue = o.queue ? o.queue(store) : null;
  const http = startHttp({
    config, identity: loadOrCreateIdentity(dir), access, observation: o.observation ?? new ObservationService(tmux, 1000),
    steering: new SteeringService(store, tmux, o.now ?? Date.now, () => access.policy(), inbox, undefined, undefined, undefined, null, queue ? { queue, isManager: () => false } : null),
    escalations, remote, inbox, reading: new ReadingService(store), queue,
    push: { publicKey: vapid.publicKey, notifications },
```

- [ ] **Step 12.50: Run it and see it pass**

Run: `npx vitest run apps/hub/test/http-manager-queue.test.ts apps/hub/test/http.test.ts apps/hub/test/http-protocol.test.ts`
Expected: PASS, every test (`http-manager-queue.test.ts`: 3).

- [ ] **Step 12.51: Commit**

```bash
git add apps/hub/src/adapters/http.ts packages/protocol/src/http.ts apps/hub/test/inprocess-hub.ts apps/hub/test/http-manager-queue.test.ts
```

```bash
git commit -m "feat(hub): the feed tells each device where its messages to the manager stand, and he can cancel one"
```

- [ ] **Step 12.52: Write the failing test of `morndo serve` with the queue**

Create `apps/hub/test/manager-queue-main.test.ts`:

```ts
// The hub as `morndo serve` runs it with a fleet (fleet-clients §9.1): the manager's queue is on by default; with
// MORNDO_MANAGER_QUEUE=off, a delivery still queued from before is cancelled at start; and a manager window the fleet
// doesn't keep sticky is said once in the log at start (plan.md Review Focus 5). The real hub as a child process on port
// 0 and a temporary home, against the fake fleet on a real Unix socket. Never the owner's hub, fleet or ports.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/adapters/store.ts";
import { localNode, memoryBackend, startFakeFleet, until, type FakeFleet } from "./helpers/fake-fleet.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
let dir: string;
let fleet: FakeFleet;
let child: ChildProcess | null = null;
let out = "";
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-queue-main-"));
  out = "";
});
afterEach(async () => {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await new Promise(r => child?.once("exit", r)); }
  child = null;
  await fleet.close();
  rmSync(dir, { recursive: true, force: true });
});

async function fleetWith(window: string) {
  fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", memoryBackend({ "%0": { name: window, cwd: "/w/m", screen: "❯ ", sessionId: "s-m" } }))], stickyLanes: ["manager"] });
}
// `morndo serve` until it says it listens.
async function serve(env: Record<string, string>) {
  const e: NodeJS.ProcessEnv = { ...process.env, MORNDO_HOME: dir, MORNDO_PORT: "0", MORNDO_FLEET_SOCKET: fleet.socketPath, MORNDO_POLL_MS: "200", ...env };
  delete e.MORNDO_PUSH_CONTACT;
  if (env.MORNDO_MANAGER_QUEUE === undefined) delete e.MORNDO_MANAGER_QUEUE;
  child = spawn(process.execPath, ["--no-warnings", MAIN, "serve"], { env: e, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
  await until(() => out.includes("morndo hub on"), 20_000);
}

describe("morndo serve with a fleet: the manager's queue", () => {
  it("on by default; a window the fleet keeps sticky says nothing of it", async () => {
    await fleetWith("manager");
    await serve({});
    expect(out.match(/manager queue: on\n/g)).toHaveLength(1);
    expect(out).not.toContain("stickyLanes");
  });

  it("a manager window the fleet doesn't keep sticky is said once at start (Review Focus 5)", async () => {
    await fleetWith("boss");
    await serve({ MORNDO_MANAGER_WINDOW: "boss" });
    expect(out.match(/the manager's window is "boss" \(MORNDO_MANAGER_WINDOW\), but the fleet's stickyLanes is \["manager"\]/g)).toHaveLength(1);
  });

  it("off: a delivery still queued from before is cancelled at start, and new answers are typed directly", async () => {
    await fleetWith("manager");
    const store = new Store(dir);
    store.saveManagerDelivery({ deliveryId: "hub:ep1:r1", kind: "command", escalationId: null, ask: null, choice: null, endpointId: "ep1", sessionId: "s1", requestId: "r1", queuedAt: 1, state: "queued", updatedAt: Date.now() });
    store.close();
    await new (await import("@morndo/fleet-client")).FleetClient(fleet.socketPath).deliver({ id: "hub:ep1:r1", lane: "manager", text: "status please" });
    await serve({ MORNDO_MANAGER_QUEUE: "off" });
    expect(fleet.cancels).toEqual(["hub:ep1:r1"]);
    expect(fleet.deliveries.get("hub:ep1:r1")?.delivery).toMatchObject({ state: "given_up", why: "cancelled" });
    expect(out.match(/manager queue: off \(MORNDO_MANAGER_QUEUE\)\n/g)).toHaveLength(1);
  });

  it("on, the same delivery is left queued (negative control)", async () => {
    await fleetWith("manager");
    const store = new Store(dir);
    store.saveManagerDelivery({ deliveryId: "hub:ep1:r1", kind: "command", escalationId: null, ask: null, choice: null, endpointId: "ep1", sessionId: "s1", requestId: "r1", queuedAt: 1, state: "queued", updatedAt: Date.now() });
    store.close();
    await new (await import("@morndo/fleet-client")).FleetClient(fleet.socketPath).deliver({ id: "hub:ep1:r1", lane: "manager", text: "status please" });
    await serve({});
    expect(fleet.cancels).toEqual([]);
    expect(fleet.deliveries.get("hub:ep1:r1")?.delivery.state).toBe("queued");
  });
});
```

- [ ] **Step 12.53: Run it and see it fail**

Run: `npx vitest run apps/hub/test/manager-queue-main.test.ts`
Expected: FAIL, 3 of 4: `AssertionError: Target cannot be null or undefined.` twice (no `manager queue: on` line, no sticky warning) and `AssertionError: expected [] to deeply equal [ 'hub:ep1:r1' ]` (nothing cancelled). The negative control ("on, the same delivery is left queued") passes.

- [ ] **Step 12.54: Wire the queue into `morndo serve`, and the fleet drills' hub**

`openFleet` now returns the client with the ports, for the queue's adapter.

In `apps/hub/src/main.ts` (1 of 10), replace:

```ts
import { RemoteService } from "./application/remote-service.ts";
import { fileStore } from "./adapters/files.ts";
```

with:

```ts
import { RemoteService } from "./application/remote-service.ts";
import { ManagerQueue } from "./application/manager-queue.ts";
import { fleetDeliveries } from "./adapters/fleet-deliveries.ts";
import { fileStore } from "./adapters/files.ts";
```

In `apps/hub/src/main.ts` (2 of 10), replace:

```ts
machine's tmux and Claude Code directly), MORNDO_ENGINE_SESSIONS (engine-lane registry directory; off unless set),
MORNDO_ENGINE_NODE (this machine's fleet node name, required with a fleet) and MORNDO_ENGINES (the engine layer's
CLI, engine-layer bin/engines: the Engines page).`;

```

with:

```ts
machine's tmux and Claude Code directly), MORNDO_ENGINE_SESSIONS (engine-lane registry directory; off unless set),
MORNDO_ENGINE_NODE (this machine's fleet node name, required with a fleet), MORNDO_ENGINES (the engine layer's
CLI, engine-layer bin/engines: the Engines page) and MORNDO_MANAGER_QUEUE (with a fleet, the manager's answers and
messages go through the fleet's delivery queue; "off" types them directly).`;

```

In `apps/hub/src/main.ts` (3 of 10), replace:

```ts
    const fleet = config.fleetSocket ? await openFleet(config.fleetSocket, files) : null;
    const ports: HubPorts = fleet ?? legacyPorts(config, { files });
    // Engine lanes on this machine, only when MORNDO_ENGINE_SESSIONS names their registry. Off otherwise: nothing is read.
```

with:

```ts
    const fleet = config.fleetSocket ? await openFleet(config.fleetSocket, files) : null;
    const ports: HubPorts = fleet?.ports ?? legacyPorts(config, { files });
    // Engine lanes on this machine, only when MORNDO_ENGINE_SESSIONS names their registry. Off otherwise: nothing is read.
```

In `apps/hub/src/main.ts` (4 of 10), replace:

```ts
    const inbox = uploadInbox({ dir: config.inboxDir, registry: store });
    // A Command is judged on arrival against what the worker waits for now (S6). With a fleet, a repeat of a send in
```

with:

```ts
    const inbox = uploadInbox({ dir: config.inboxDir, registry: store });
    // The manager's answers and messages through the fleet's delivery queue (fleet-clients §9.1), the only queue for them
    // (ruling 81): with a fleet, on unless MORNDO_MANAGER_QUEUE is off. Off, what is still queued is cancelled at start and
    // the rest followed to its end.
    const queue = fleet ? new ManagerQueue({ store, deliveries: fleetDeliveries(fleet.client), lane: config.managerWindow, on: config.managerQueue === true }) : null;
    // A Command is judged on arrival against what the worker waits for now (S6). With a fleet, a repeat of a send in
```

In `apps/hub/src/main.ts` (5 of 10), replace:

```ts
    const steering = new SteeringService(store, typist, Date.now, () => access.policy(), inbox, id => observation.waitingOn(id),
      id => observation.nameOf(id), ports.uploads, ports.sendStatus);
    const escalations = new EscalationService({
```

with:

```ts
    const steering = new SteeringService(store, typist, Date.now, () => access.policy(), inbox, id => observation.waitingOn(id),
      id => observation.nameOf(id), ports.uploads, ports.sendStatus, queue ? { queue, isManager: id => id === managerPane() } : null);
    const escalations = new EscalationService({
```

In `apps/hub/src/main.ts` (6 of 10), replace:

```ts
      settle: (key, workerId) => steering.settleInDoubt(key, workerId),
    });
    const remote = new RemoteService({
```

with:

```ts
      settle: (key, workerId) => steering.settleInDoubt(key, workerId),
      queue,
    });
    if (queue) {
      await queue.start();                               // off: what is still queued is cancelled here, before any answer
      log.info(`manager queue: ${queue.on ? "on" : "off (MORNDO_MANAGER_QUEUE)"}`);   // once, at start (reconciliation ruling 39)
    }
    const remote = new RemoteService({
```

In `apps/hub/src/main.ts` (7 of 10), replace:

```ts
    const usage = new UsageService({ store });
    const http = startHttp({ config, identity, access, observation, steering, escalations, remote, files, inbox, reading, push: { publicKey: vapid.publicKey, notifications }, engines, board: { service: board, agents }, usage });
    const sweepInbox = setInterval(() => inbox.sweep(), 3_600_000);
```

with:

```ts
    const usage = new UsageService({ store });
    const http = startHttp({ config, identity, access, observation, steering, escalations, remote, files, inbox, reading, push: { publicKey: vapid.publicKey, notifications }, engines, board: { service: board, agents }, usage, queue });
    const sweepInbox = setInterval(() => inbox.sweep(), 3_600_000);
```

In `apps/hub/src/main.ts` (8 of 10), replace:

```ts
    log.info(`hub identity ${formatFingerprint(identity.fingerprint)}`);
    const stop = async () => { clearInterval(sweepInbox); stopRetention(); observation.stop(); escalations.stop(); notifications.stop(); fleet?.stop(); await http.close(); store.close(); process.exit(0); };
    process.on("SIGINT", () => void stop());
```

with:

```ts
    log.info(`hub identity ${formatFingerprint(identity.fingerprint)}`);
    const stop = async () => { clearInterval(sweepInbox); stopRetention(); observation.stop(); escalations.stop(); notifications.stop(); queue?.stop(); fleet?.ports.stop(); await http.close(); store.close(); process.exit(0); };
    process.on("SIGINT", () => void stop());
```

In `apps/hub/src/main.ts` (9 of 10), replace:

```ts
//   (spec §7, "Fleet service down or restarting").
async function openFleet(socket: string, files: LocalFileStore): Promise<FleetPorts> {
  const client = new FleetClient(socket, { log });
```

with:

```ts
//   (spec §7, "Fleet service down or restarting").
async function openFleet(socket: string, files: LocalFileStore): Promise<{ ports: FleetPorts; client: FleetClient }> {
  const client = new FleetClient(socket, { log });
```

In `apps/hub/src/main.ts` (10 of 10), replace:

```ts
  await ports.start();
  return ports;
}
```

with:

```ts
  await ports.start();
  return { ports, client };
}
```

The queue is now on by default wherever the hub has a fleet, and the fleet drills' hub (`test/fleet-harness.ts`) follows what ships: on, unless a drill says `managerQueue: false` (ruling 66), so a drill written later tests what ships unless it says otherwise.

In `test/fleet-harness.ts` (1 of 2), replace:

```ts

export async function startHub(fleet: Fleet, o: { pollMs?: number; web?: "stub" | "build"; ledger?: unknown; vnc?: string } = {}): Promise<Hub> {
  const home = tempDir("morndo-hub-");
```

with:

```ts

export async function startHub(fleet: Fleet, o: { pollMs?: number; web?: "stub" | "build"; ledger?: unknown; vnc?: string; managerQueue?: boolean } = {}): Promise<Hub> {
  const home = tempDir("morndo-hub-");
```

In `test/fleet-harness.ts` (2 of 2), replace:

```ts
  if (o.vnc !== undefined) extra.MORNDO_VNC = o.vnc;
  if (o.ledger !== undefined) {
```

with:

```ts
  if (o.vnc !== undefined) extra.MORNDO_VNC = o.vnc;
  // The hub as it ships: with a fleet, the manager's queue (MORNDO_MANAGER_QUEUE) is on unless a drill turns it off.
  if (o.managerQueue === false) extra.MORNDO_MANAGER_QUEUE = "off";
  if (o.ledger !== undefined) {
```

`drills-retry` and `duplicate-names` drill the hub's direct path (its keyed `pane.send` and done keys), which the hub still uses with the switch off (step 2's rollback) and for every other lane, so they turn the queue off:

In `test/fleet/drills-retry.test.ts`, replace:

```ts
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const hub = await startHub(fleet, { ledger: { needsYou: [{ id: "ny-1", kind: "tap", question: "Ship the drill build?",
    options: [{ key: "ship", label: "Ship it" }, { key: "hold", label: "Hold" }], deadline: tomorrow, ts: new Date().toISOString() }] } });
```

with:

```ts
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  // The direct path, which the hub still types with the switch off (step 2's rollback) and for every other lane.
  const hub = await startHub(fleet, { managerQueue: false, ledger: { needsYou: [{ id: "ny-1", kind: "tap", question: "Ship the drill build?",
    options: [{ key: "ship", label: "Ship it" }, { key: "hold", label: "Hold" }], deadline: tomorrow, ts: new Date().toISOString() }] } });
```

In `test/fleet/duplicate-names.test.ts` (1 of 2), replace:

```ts
    expect(lane).toMatchObject({ node: "n1", workerId: null, conflict: true });
    const hub = await startHub(fleet);
    const feed = await hub.feed();
```

with:

```ts
    expect(lane).toMatchObject({ node: "n1", workerId: null, conflict: true });
    // The direct path, which the hub still types with the switch off (step 2's rollback) and for every other lane.
    const hub = await startHub(fleet, { managerQueue: false });
    const feed = await hub.feed();
```

In `test/fleet/duplicate-names.test.ts` (2 of 2), replace:

```ts
    await until("manager in conflict", async () => (await fleet.client.lanes()).find(l => l.name === "manager")?.conflict === true, 15_000);
    const hub = await startHub(fleet, { ledger: ledger() });
    const feed = await hub.feed();
```

with:

```ts
    await until("manager in conflict", async () => (await fleet.client.lanes()).find(l => l.name === "manager")?.conflict === true, 15_000);
    // The direct path, which the hub still types with the switch off (step 2's rollback) and for every other lane.
    const hub = await startHub(fleet, { managerQueue: false, ledger: ledger() });
    const feed = await hub.feed();
```

- [ ] **Step 12.55: Run it and see it pass, then every suite, the types and the linter**

Run: `npx vitest run apps/hub/test/manager-queue-main.test.ts apps/hub/test/config-fleet.test.ts apps/hub/test/migrations.test.ts`
Expected: PASS, every test (`manager-queue-main.test.ts`: 4).

Run: `npx vitest run apps/hub packages/domain packages/protocol`
Expected: PASS, every test.

Run: `npx vitest run test/fleet/drills-retry.test.ts test/fleet/duplicate-names.test.ts`
Expected: PASS, 20 tests (a few minutes). Without their `managerQueue: false`, the hub queues what these drills expect it to type: in the scratch copy (whose fleet has no deliveries, Tasks 4 to 9 not being in its base) 14 of them failed, most waiting for the manager's pane.

Run: `npx vitest run test/fleet`
Expected: PASS, every drill; the others run with the queue on.

Run: `grep -rn MORNDO_MANAGER_INBOX apps/hub/src apps/hub/README.md || echo "no MORNDO_MANAGER_INBOX"`
Expected: `no MORNDO_MANAGER_INBOX`.

Run: `npm run check`
Expected: exit 0.

Run: `npm run lint`
Expected: no problems.

- [ ] **Step 12.56: Commit**

```bash
git add apps/hub/src/main.ts apps/hub/test/manager-queue-main.test.ts test/fleet-harness.ts test/fleet/drills-retry.test.ts test/fleet/duplicate-names.test.ts
```

```bash
git commit -m "feat(hub): morndo serve sends the manager's answers and messages through the queue; the switch off cancels first"
```

- [ ] **Step 12.57: Add the negative controls of Task 12**

Add to `scripts/negative-controls.ts`, at the end of `CONTROLS` (every one was applied in the scratch copy and bit, with the `expect` text in its failure):

```ts
  // ---- fleet-clients Task 12: the manager's answers and commands through the queue (plan/04-hub-web.md)
  // The removal of #29's manager inbox (ruling 81): no switch, no spool writer.
  { id: "fc12-inbox-switch-back", task: "fc12", file: "apps/hub/src/config.ts",
    find: "    paneLock: env.MORNDO_PANE_LOCK || null,\n", replace: "    paneLock: env.MORNDO_PANE_LOCK || null,\n    managerInbox: env.MORNDO_MANAGER_INBOX || null,\n",
    run: ["apps/hub/test/no-manager-inbox.test.ts"], expect: "expected [ 'managerInbox' ] to deeply equal []" },
  { id: "fc12-spool-writer-back", task: "fc12", file: "apps/hub/src/application/escalation-service.ts",
    find: "import { log } from \"../adapters/log.ts\";\n", replace: "import { log } from \"../adapters/log.ts\";\nimport { managerInbox } from \"../adapters/manager-inbox.ts\";\n",
    run: ["apps/hub/test/no-manager-inbox.test.ts"], expect: "manager-inbox.ts" },
  { id: "fc12-adr-0010-not-superseded", task: "fc12", file: "docs/adr/0010-manager-inbox.md",
    find: "- **Superseded** by ADR-0014 (fleet clients, §9.1): the manager's answers and messages go through the fleet's delivery queue.", replace: "",
    run: ["apps/hub/test/no-manager-inbox.test.ts"], expect: "Superseded" },
  { id: "fc12-uncertain-any-decision", task: "fc12", file: "packages/domain/src/escalation.ts",
    find: "    if (!d || d.delivery?.state !== \"queued\" || !sameDecision(d, expected)) return false;\n    d.delivery = { state: \"uncertain\", at: null };",
    replace: "    if (!d || d.delivery?.state !== \"queued\") return false;\n    d.delivery = { state: \"uncertain\", at: null };",
    run: ["packages/domain/test/escalation-delivery.test.ts"], expect: "expected true to be false" },
  { id: "fc12-feed-unknown-state-delivered", task: "fc12", file: "packages/protocol/src/feed.ts",
    find: "state: orElse(z.enum([\"queued\", \"delivered\", \"uncertain\"]), \"queued\"), at:",
    replace: "state: z.enum([\"queued\", \"delivered\", \"uncertain\"]), at:",
    run: ["packages/protocol/test/feed-deliveries.test.ts"], expect: "never delivered" },
  { id: "fc12-store-any-state", task: "fc12", file: "apps/hub/src/adapters/migrations.ts",
    find: "        state TEXT NOT NULL CHECK (state IN ('sending', 'queued', 'typed', 'held', 'delivered', 'uncertain', 'given_up')),",
    replace: "        state TEXT NOT NULL,",
    run: ["apps/hub/test/manager-deliveries-store.test.ts"], expect: "to throw" },
  { id: "fc12-queue-switch-ignored", task: "fc12", file: "apps/hub/src/config.ts",
    find: "!/^(off|0)$/i.test(env.MORNDO_MANAGER_QUEUE ?? \"\")", replace: "true",
    run: ["apps/hub/test/config-manager-queue.test.ts"], expect: "off: expected true to be false" },
  { id: "fc12-unreached-in-doubt", task: "fc12", file: "apps/hub/src/adapters/fleet-deliveries.ts",
    find: "  if (e instanceof FleetUnavailable) return e.reached ? { ok: false, inDoubt: true } : { ok: false, refused: \"node_offline\" };",
    replace: "  if (e instanceof FleetUnavailable) return { ok: false, inDoubt: true };",
    run: ["apps/hub/test/fleet-deliveries.test.ts"], expect: "inDoubt: true" },
  { id: "fc12-cancel-unknown-in-doubt", task: "fc12", file: "apps/hub/src/adapters/fleet-deliveries.ts",
    find: "        return d === null ? { ok: false, unknown: true } : answered(d);", replace: "        return answered(d);",
    run: ["apps/hub/test/fleet-deliveries.test.ts"], expect: "ruling 56" },
  { id: "fc12-queue-older-word", task: "fc12", file: "apps/hub/src/application/manager-queue.ts",
    find: "    if (before && RANK[d.state] < RANK[before.state]) return;\n", replace: "",
    run: ["apps/hub/test/manager-queue.test.ts"], expect: "older word" },
  { id: "fc12-queue-drop-earlier-row", task: "fc12", file: "apps/hub/src/application/manager-queue.ts",
    find: "    if (!known) this.#store.dropManagerDelivery(d.deliveryId);", replace: "    this.#store.dropManagerDelivery(d.deliveryId);",
    run: ["apps/hub/test/manager-queue.test.ts"], expect: "expected undefined to be 'sending'" },
  { id: "fc12-queue-off-no-cancel", task: "fc12", file: "apps/hub/src/application/manager-queue.ts",
    find: "    else await this.#cancelQueued();", replace: "",
    run: ["apps/hub/test/manager-queue.test.ts"], expect: "cancels what is still queued" },
  { id: "fc12-queue-no-sticky-warning", task: "fc12", file: "apps/hub/src/application/manager-queue.ts",
    find: "    if (sticky === null || sticky.includes(this.lane)) return;", replace: "    return;",
    run: ["apps/hub/test/manager-queue.test.ts"], expect: "said once at start" },
  { id: "fc12-queue-view-before-commit", task: "fc12", file: "apps/hub/src/application/manager-queue.ts",
    find: "    this.#store.transaction(() => {\n      this.#store.setManagerDeliveryState(d.id, d.state, now.updatedAt);\n      if (notify) for (const l of this.#listeners) l({ row: now, view });\n    });\n    this.#views.set(d.id, view);",
    replace: "    this.#views.set(d.id, view);\n    this.#store.setManagerDeliveryState(d.id, d.state, now.updatedAt);\n    if (notify) for (const l of this.#listeners) l({ row: now, view });",
    run: ["apps/hub/test/manager-queue.test.ts"], expect: "listener that fails" },
  { id: "fc12-sending-row-kept", task: "fc12", file: "apps/hub/src/application/manager-queue.ts",
    find: "      if (this.#store.managerDelivery(id)?.state === \"sending\") this.#store.dropManagerDelivery(id);",
    replace: "      if (false) this.#store.dropManagerDelivery(id);",
    run: ["apps/hub/test/manager-queue.test.ts"], expect: "never had is dropped" },
  { id: "fc12-answer-typed-directly", task: "fc12", file: "apps/hub/src/application/escalation-service.ts",
    find: "      if (this.#queue?.on && e.asker.kind === \"manager\") return await this.#queueAnswer(a, e, choice, requestId, key);\n", replace: "",
    run: ["apps/hub/test/escalation-queue.test.ts"], expect: "is queued under its answer key" },
  { id: "fc12-no-withdraw", task: "fc12", file: "apps/hub/src/application/escalation-service.ts",
    find: "    this.#withdrawStale();\n    if (changed) this.#notify();", replace: "    if (changed) this.#notify();",
    run: ["apps/hub/test/escalation-queue.test.ts"], expect: "asked again while queued" },
  { id: "fc12-delivered-not-recorded", task: "fc12", file: "apps/hub/src/application/escalation-service.ts",
    find: "      this.#store.record([{ ...event, ...wordsOf(row) }]);\n", replace: "",
    run: ["apps/hub/test/escalation-queue.test.ts"], expect: "recorded once" },
  { id: "fc12-uncertain-reopens", task: "fc12", file: "apps/hub/src/application/escalation-service.ts",
    find: "      this.#x.uncertain(id, expected);", replace: "      this.#x.withdraw(id, expected);",
    run: ["apps/hub/test/escalation-queue.test.ts"], expect: "never opened again" },
  { id: "fc12-off-answer-in-doubt-typed", task: "fc12", file: "apps/hub/src/application/escalation-service.ts",
    find: "        if (queued.state === \"sending\" && this.#queue && !this.#queue.on) return { ok: false, problem: \"uncertain\", item: this.#view(id) };\n", replace: "",
    run: ["apps/hub/test/escalation-queue.test.ts"], expect: "its repeat is uncertain" },
  { id: "fc12-off-other-answer-typed", task: "fc12", file: "apps/hub/src/application/escalation-service.ts",
    find: "      if (this.#queue?.sendingOf(`hub:${askPrefix(e.id, e)}`).length) {", replace: "      if (false) {",
    run: ["apps/hub/test/escalation-queue.test.ts"], expect: "answer_in_doubt (ruling 49)" },
  { id: "fc12-given-up-kept", task: "fc12", file: "apps/hub/src/application/escalation-service.ts",
    find: "      this.#x.withdraw(id, expected);\n      this.#store.dropDecisionIf(id, expected.at);\n", replace: "",
    run: ["apps/hub/test/escalation-queue.test.ts"], expect: "given up" },
  { id: "fc12-given-up-id-reused", task: "fc12", file: "apps/hub/src/application/escalation-service.ts",
    find: "    const deliveryId = queue.idFor(k);", replace: "    const deliveryId = `hub:${k}`;",
    run: ["apps/hub/test/escalation-queue.test.ts"], expect: "under a new id" },
  { id: "fc12-other-answer-in-doubt", task: "fc12", file: "apps/hub/src/application/escalation-service.ts",
    find: "    if (queue.sendingOf(`hub:${askPrefix(e.id, e)}`).some(r => r.deliveryId !== deliveryId)) {", replace: "    if (false) {",
    run: ["apps/hub/test/escalation-queue.test.ts"], expect: "in doubt" },
  { id: "fc12-echo-taken-as-tap", task: "fc12", file: "apps/hub/src/application/escalation-service.ts",
    find: "      if (m.author.kind !== \"principal\" || echoes.has(m.id)) continue;", replace: "      if (m.author.kind !== \"principal\") continue;",
    run: ["apps/hub/test/escalation-queue.test.ts"], expect: "ADR-0010 H1" },
  { id: "fc12-command-typed-directly", task: "fc12", file: "apps/hub/src/application/steering-service.ts",
    find: "    if (this.#manager?.queue.on && this.#manager.isManager(workerId)) return this.#queueCommand(a, key, workerId, prepared.body, uploads.length, now, createdAt);\n", replace: "",
    run: ["apps/hub/test/steering-queue.test.ts"], expect: "is queued under the key" },
  { id: "fc12-off-command-in-doubt-typed", task: "fc12", file: "apps/hub/src/application/steering-service.ts",
    find: "    if (queued?.kind === \"command\" && queued.state === \"sending\" && this.#manager && !this.#manager.queue.on) {", replace: "    if (false) {",
    run: ["apps/hub/test/steering-queue.test.ts"], expect: "never typed directly on its repeat" },
  { id: "fc12-command-repeat-requeued", task: "fc12", file: "apps/hub/src/application/steering-service.ts",
    find: "    if (queued?.kind === \"command\" && queued.state !== \"sending\") {", replace: "    if (false) {",
    run: ["apps/hub/test/steering-queue.test.ts"], expect: "a repeat answers" },
  { id: "fc12-given-up-off-not-typed", task: "fc12", file: "apps/hub/src/application/steering-service.ts",
    find: "      if (queued.state === \"given_up\" && queue && !queue.on) queue.forget(queued.deliveryId);\n      else {", replace: "      {",
    run: ["apps/hub/test/steering-queue.test.ts"], expect: "given up while the switch is off" },
  { id: "fc12-commandsent-only-answered", task: "fc12", file: "apps/hub/src/application/steering-service.ts",
    find: "    if (first && (r.ok || r.problem === \"uncertain\")) this.#store.record(", replace: "    if (first && r.ok) this.#store.record(",
    run: ["apps/hub/test/steering-queue.test.ts"], expect: "nor told" },
  // Decision 2 (ruling 82): an answer never typed is Not delivered, and its ask opens again; one #29's inbox left queued may have been delivered.
  { id: "fc12-given-up-no-notice", task: "fc12", file: "apps/hub/src/application/escalation-service.ts",
    find: "    if (last.state === \"given_up\" && last.ask === ask) return { notice: NOT_DELIVERED };\n", replace: "",
    run: ["apps/hub/test/escalation-queue.test.ts"], expect: "Not delivered: the answer never reached the manager" },
  { id: "fc12-given-up-repeat-requeued", task: "fc12", file: "apps/hub/src/application/escalation-service.ts",
    find: "    if (givenUp?.kind === \"answer\" && givenUp.escalationId === id && givenUp.state === \"given_up\") return { ok: false, problem: \"not_delivered\", item: this.#view(id) };\n", replace: "",
    run: ["apps/hub/test/escalation-queue.test.ts"], expect: "not_delivered" },
  { id: "fc12-inbox-leftover-queued", task: "fc12", file: "apps/hub/src/application/escalation-service.ts",
    find: "      this.#x.uncertain(d.id, d.decision);\n", replace: "",
    run: ["apps/hub/test/escalation-queue.test.ts"], expect: "uncertain" },
  { id: "fc12-late-answer-replaces-newer", task: "fc12", file: "apps/hub/src/application/escalation-service.ts",
    find: "      this.#store.replaceDecisionIf(id, expected.at, { ...expected, delivery: { state: \"delivered\", at } });",
    replace: "      this.#store.saveDecision(id, { ...expected, delivery: { state: \"delivered\", at } });",
    run: ["apps/hub/test/escalation-queue.test.ts"], expect: "B3" },
  // Decision 3 (ruling 83): a message to the manager waits up to 24 hours from when it was written, and can be cancelled.
  { id: "fc12-message-two-minutes", task: "fc12", file: "apps/hub/src/application/steering-service.ts",
    find: "    const ttlMs = createdAt !== undefined && age > 0 && age < LIMITS.deliveryTtlMs ? LIMITS.deliveryTtlMs - age : undefined;",
    replace: "    const ttlMs = 2 * 60_000 + 0 * age;",
    run: ["apps/hub/test/steering-queue.test.ts"], expect: "82800000" },
  { id: "fc12-no-cancel", task: "fc12", file: "apps/hub/src/application/steering-service.ts",
    find: "    const r = await queue.cancel(row.deliveryId);\n    if (!r.ok) return { ok: false, problem: r.problem };",
    replace: "    const r = { ok: false as const, problem: \"unknown\" as const };\n    if (!r.ok) return { ok: false, problem: r.problem };",
    run: ["apps/hub/test/steering-queue.test.ts"], expect: "cancelled" },
  { id: "fc12-feed-other-device", task: "fc12", file: "apps/hub/src/adapters/http.ts",
    find: "if (c.row.kind === \"command\" && c.row.endpointId === conn.auth.endpoint.id) send(", replace: "if (c.row.kind === \"command\") send(",
    run: ["apps/hub/test/http-manager-queue.test.ts"], expect: "never another device" },
  { id: "fc12-feed-no-hello-list", task: "fc12", file: "apps/hub/src/adapters/http.ts",
    find: "            if (p.queue) send({ t: \"deliveries\", items: p.queue.commandsOf(conn.auth.endpoint.id) });   // all of the last day\n", replace: "",
    run: ["apps/hub/test/http-manager-queue.test.ts"], expect: "after a hello" },
  { id: "fc12-serve-queue-not-started", task: "fc12", file: "apps/hub/src/main.ts",
    find: "      await queue.start();                               // off: what is still queued is cancelled here, before any answer\n", replace: "",
    run: ["apps/hub/test/manager-queue-main.test.ts"], expect: "expected [] to deeply equal [ 'hub:ep1:r1' ]" },
```

Run: `node scripts/negative-controls.ts --check`
Expected: `ok` for every `fc12-` entry (its text is in its file exactly once).

Run: `node scripts/negative-controls.ts --list | awk -F'\t' '$1 ~ /^fc12-/ {print "--only " $1}' | xargs node scripts/negative-controls.ts` (all 39 `fc12-` entries)
Expected: `bit` for each. (The full run takes minutes; CI runs it with the rest.)

```bash
git add scripts/negative-controls.ts
```

```bash
git commit -m "test: negative controls for the manager's queue"
```

---

### Task 13: Web: Queued, Delivered and May-have-been-delivered for the manager, and Cancel

**What changes from #29's app.** #29 showed the manager's inbox: a sent command's spool word (eleven labels), a two-minute ask of where it stood, and Retry of an expired, lost or cancelled one. This task removes that (rulings 81 and 83: the fleet's queue is the only queue; no two-minute deadline, no Retry) and shows the queue instead, keeping #29's decision-card delivery line (`deliveryLine`, the phone's `answeredHere`), the cards' notice, `not_delivered`'s words and the outbox's `createdAt`.

**Files:**
- Create: `apps/web/src/lib/queue-words.ts` (the words, and the table of reasons)
- Modify: `apps/web/src/lib/outbox/state.ts` (#29's `queued`, `inbox`, `inboxReason`, `revive` and its Retry rule go; `CommandDelivery`, `OutboxRecord.delivery`, `commandDelivery`, `canCancel`), `apps/web/src/lib/outbox/outbox.ts` (#29's spool timers and revived Retry go; `PostOutcome.delivery`, `Outbox.deliveries`, `Outbox.cancel`, `CancelOutcome`), `apps/web/src/lib/outbox/device.ts` (#29's `spoolWord` and `retry` flag go; the send answer's `delivery`, `cancelDelivery`), `apps/web/src/lib/outbox/words.ts` (#29's eleven labels and its `not_delivered` reason go; the queue's labels, `deliveryNote`)
- Modify: `apps/web/src/lib/desktop/Desktop.svelte`, `apps/web/src/lib/phone/Phone.svelte` (frames to the outbox, Cancel), `apps/web/src/lib/desktop/ChannelView.svelte`, `apps/web/src/lib/desktop/MessageList.svelte`, `apps/web/src/lib/phone/CatchUp.svelte`, `apps/web/src/lib/phone/UpdateCard.svelte` (the note, the Cancel button)
- Modify: `apps/web/src/lib/desktop/decisions.ts` (`deliveryLine`, with the queue's reasons and `uncertain`), `apps/web/src/lib/desktop/DecisionCard.svelte`, `apps/web/src/lib/phone/DecisionCard.svelte`, `apps/web/src/lib/phone/horizon.ts`
- Modify: `apps/web/src/lib/gallery/data.ts` (#29's two queue cards keep their places, with the queue's reason; "May have been delivered" and "Not delivered" join them; the inbox's send becomes a queued one), `e2e/gallery.e2e.ts` (14 cards, their words, the new label)
- Delete: `apps/web/test/val-b4-queued-command-label.test.ts` (#29's inbox labels); Modify: `apps/web/test/outbox.test.ts` (#29's five inbox cases go)
- Create (tests): `apps/web/test/queue-words.test.ts`, `apps/web/test/outbox-deliveries.test.ts`, `apps/web/test/manager-queue-web.test.ts` (Chromium)
- Modify: `scripts/negative-controls.ts`

**Interfaces:**
- Consumes: Task 12's `QueuedCommand`, `DecisionItem.waiting`, `Decision.delivery`, the `deliveries` frame and `LiveFeed.deliveries` (Step 12.13), the send route's `delivery`, `POST /api/manager/cancel` (Step 12.49); #29's `DecisionItem.notice` and `deliveryLine`; Task 1's `WaitingReason` (with `unavailable`, ruling 15) and `GiveUpReason` (types only, for the tables' exhaustiveness).
- Produces:
  ```ts
  // apps/web/src/lib/queue-words.ts
  export const QUEUED = "Queued, it will be delivered", DELIVERED = "Delivered", MAY_HAVE_BEEN = "May have been delivered", NOT_DELIVERED = "Not delivered";
  export const WAITING: Record<string, string>;      // satisfies Record<WaitingReason | "typed" | "held", string>
  export const GIVEN_UP: Record<string, string>;     // satisfies Record<GiveUpReason, string>
  export function queuedLine(waiting: string | null | undefined): string;
  // apps/web/src/lib/outbox/state.ts
  export type CommandDelivery = { state: "queued" | "delivered" | "uncertain" | "given_up"; waiting: string | null; why: string | null };
  OutboxRecord.delivery?: CommandDelivery;  export function commandDelivery(v: unknown): CommandDelivery | null;
  export const canCancel: (r: OutboxRecord) => boolean;   // Sent, its delivery queued, not typed or held yet
  // apps/web/src/lib/outbox/outbox.ts
  PostOutcome "typed": { kind: "typed"; at?: number; delivery?: CommandDelivery };  Outbox.deliveries(items: readonly QueuedCommand[]): Promise<void>
  export type CancelOutcome = { kind: "cancelled"; delivery: CommandDelivery } | { kind: "too_late"; delivery: CommandDelivery | null } | { kind: "unanswered" };
  Outbox's d gains cancel?: (r: OutboxRecord) => Promise<CancelOutcome>;  Outbox.cancel(id): Promise<CancelOutcome["kind"] | null>
  // apps/web/src/lib/outbox/device.ts
  export function cancelDelivery(r: OutboxRecord): Promise<CancelOutcome>
  // apps/web/src/lib/outbox/words.ts
  export function deliveryNote(o: OutboxRecord): string
  // apps/web/src/lib/desktop/decisions.ts (#29's, with the queue's reasons and uncertain)
  export type DeliveryLine = { state: "queued"; why: string | null } | { state: "delivered"; at: number | null } | { state: "uncertain" };
  export function deliveryLine(d: DecisionItem): DeliveryLine | null
  // the Cancel button's handler, on MessageList, ChannelView, UpdateCard and CatchUp
  onCancel?: (id: string) => void
  ```

**The waiting reasons, in words** (`WAITING`; plan.md's Wording rule). Each follows "Queued, it will be delivered: ", and the line ends with a full stop:

| Reason | What the owner reads |
|---|---|
| `menu_open` | a menu is open in the manager's terminal; it goes in once that's answered |
| `draft_present` | the manager's input box has text that isn't from Morndo; it goes in once that's sent or cleared |
| `no_input_box` | the manager isn't showing its input box right now; it goes in once it does |
| `busy` | something else is typing into the manager right now; it goes in right after |
| `no_pane` | the manager isn't running right now; it goes in once it's back |
| `no_session` | the manager is still starting; it goes in once it's ready |
| `earlier` | an earlier message to the manager goes in first |
| `unavailable` | the machine didn't answer, trying again (ruling 15) |
| `typed` (state) | it was typed, and the manager hasn't shown it in its conversation yet |
| `held` (state) | the manager is busy and holds it in its own queue; it takes it after its current step |

A reason this app doesn't know adds nothing: the line is "Queued, it will be delivered." A message given up reads "Not delivered", and its note "Nothing reached the manager: <why>. Write it again if it's still needed.", with why:

| Why | Words |
|---|---|
| `expired` | it waited a whole day and was never typed |
| `cancelled` | it was withdrawn before it was typed |
| `gone` | the manager it was meant for was replaced before it could take it |
| `refused` | the manager's machine refused it |

**Where each shows:**
- **A message (the desktop's conversation, the phone's update card):** its time label is the delivery's word (a day queued still says "Queued, it will be delivered", never "not seen yet" and never "Not sent": there is no two-minute deadline); a note under the text says why it waits, why it never went, or what "may have been" means. While it waits and isn't typed, it has **Cancel** (ruling 83): the hub withdraws it, and it reads "Not delivered" with "it was withdrawn before it was typed"; once typed, Cancel is gone (too late, it says it was typed). There is no Retry for it. Dismiss as for any Sent entry. The echo still ends it.
- **An answer's card:**
  - desktop: "Queued, it will be delivered: <why>.", "Delivered · <time>. The manager closes this when it's done.", or "May have been delivered: it was typed, but never seen in the manager's conversation. It stays answered; look at the manager's screen to be sure.";
  - phone: "Answered. Queued, it will be delivered: <why>.", "Answered. Delivered to the manager.", "Answered. May have been delivered: …";
  - the phone's Today row: "… Queued, it will be delivered." or "… May have been delivered.";
  - given up: the card is open again, and #29's notice line shows the hub's "Not delivered: the answer never reached the manager. Answer again." (desktop and phone).
- From #29 (ADR-0010 rebuilt) this keeps the card's `deliveryLine`, the phone's `answeredHere` and the notice line, with this queue's states and reasons in place of the inbox's (`INBOX_WAITS` went in Step 12.3).

- [ ] **Step 13.1: Write the failing tests**

Create `apps/web/test/queue-words.test.ts`:

```ts
// The words for the manager's delivery queue (fleet-clients Task 13; plan.md Wording): exactly "Queued, it will be
// delivered", "Delivered", "May have been delivered", and why it waits in plain words, one for each reason the queue
// gives, never its code. The same words for a message (the outbox) and an answer (the decision cards, the phone's Today).
import { describe, expect, it } from "vitest";
import type { DecisionItem } from "../src/lib/desktop/decisions.ts";
import { deliveryLine } from "../src/lib/desktop/decisions.ts";
import { horizon } from "../src/lib/phone/horizon.ts";
import type { OutboxRecord } from "../src/lib/outbox/state.ts";
import { deliveryNote, sendLabel } from "../src/lib/outbox/words.ts";
import { DELIVERED, GIVEN_UP, MAY_HAVE_BEEN, QUEUED, WAITING, queuedLine } from "../src/lib/queue-words.ts";

const T0 = new Date(2026, 9, 8, 9, 0).getTime();
const REASONS = ["menu_open", "draft_present", "no_input_box", "busy", "no_pane", "no_session", "earlier", "unavailable", "typed", "held"];
const rec = (o: Partial<OutboxRecord> = {}): OutboxRecord => ({
  id: "r1", worker: "pc.aaaaaaaa.0", workerName: "manager", text: "status please", uploads: [], createdAt: T0, budgetFrom: T0, state: "sent",
  error: null, attempts: 1, seen: "none", sentAt: T0, typedAt: T0, ...o,
});
const item = (o: Partial<DecisionItem> = {}): DecisionItem => ({
  id: "ny-7", asker: { kind: "manager", name: "Manager", workerId: "pc.aaaaaaaa.0" }, need: "decision", title: "Ship it?", shortTitle: null,
  summary: null, minutes: null, link: null, details: null, context: null, contextKind: "markdown", options: [], answerBy: "tap",
  recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null, askedAt: T0 - 60_000, messageId: null,
  tracking: "ledger", status: "answered", source: "open", resolution: null, settledAt: null, askedAgain: false, answerable: "already_answered", version: "v1",
  decision: { choice: { kind: "option", key: "ship", label: "Ship it" }, at: T0, via: "here", endpointId: null, sessionId: null, delivery: { state: "queued", at: null } },
  ...o,
} as DecisionItem);

describe("the queue's words", () => {
  it("are exactly the plan's", () => {
    expect([QUEUED, DELIVERED, MAY_HAVE_BEEN]).toEqual(["Queued, it will be delivered", "Delivered", "May have been delivered"]);
    expect(queuedLine("unavailable")).toBe("Queued, it will be delivered: the machine didn't answer, trying again.");   // ruling 15
  });
  it("say why it waits for every reason the queue gives, in words, never the code", () => {
    for (const r of REASONS) {
      expect(WAITING[r], r).toMatch(/^[a-z][^_]*[a-z]$/);                   // a clause, never a code such as menu_open
      expect(queuedLine(r)).toBe(`Queued, it will be delivered: ${WAITING[r]}.`);
    }
    for (const why of ["expired", "cancelled", "gone", "refused"]) expect(GIVEN_UP[why], why).toMatch(/^[a-z][^_]*[a-z]$/);
  });
  it("a reason it doesn't know adds nothing it can't vouch for (negative control)", () => {
    expect(queuedLine("teleporting")).toBe("Queued, it will be delivered.");
    expect(queuedLine(null)).toBe("Queued, it will be delivered.");
  });
});

describe("a message to the manager in the outbox", () => {
  it("reads as its delivery says, with why it waits or why it never went", () => {
    expect(sendLabel(rec({ delivery: { state: "queued", waiting: "menu_open", why: null } }), [], T0)).toBe("Queued, it will be delivered");
    expect(deliveryNote(rec({ delivery: { state: "queued", waiting: "menu_open", why: null } }))).toBe(queuedLine("menu_open"));
    expect(sendLabel(rec({ delivery: { state: "delivered", waiting: null, why: null } }), [], T0)).toBe("Delivered");
    expect(deliveryNote(rec({ delivery: { state: "delivered", waiting: null, why: null } }))).toBe("");
    expect(sendLabel(rec({ delivery: { state: "uncertain", waiting: null, why: null } }), [], T0)).toBe("May have been delivered");
    expect(deliveryNote(rec({ delivery: { state: "uncertain", waiting: null, why: null } }))).toMatch(/^It was typed, but never seen/);
    expect(sendLabel(rec({ delivery: { state: "given_up", waiting: null, why: "expired" } }), [], T0)).toBe("Not delivered");
    expect(deliveryNote(rec({ delivery: { state: "given_up", waiting: null, why: "expired" } }))).toBe(`Nothing reached the manager: ${GIVEN_UP.expired}. Write it again if it's still needed.`);
  });
  it("queued a day long, it still says it will be delivered, never 'not seen yet'", () => {
    expect(sendLabel(rec({ delivery: { state: "queued", waiting: null, why: null } }), [], T0 + 23 * 3_600_000)).toBe("Queued, it will be delivered");
  });
  it("one typed directly reads as before (negative control)", () => {
    expect(sendLabel(rec(), [], T0)).toBe("Sent");
    expect(deliveryNote(rec())).toBe("");
  });
});

describe("an answer to the manager", () => {
  it("the card's line: queued with why, delivered with when, or may have been delivered", () => {
    expect(deliveryLine(item({ waiting: "draft_present" }))).toEqual({ state: "queued", why: WAITING.draft_present });
    expect(deliveryLine(item())).toEqual({ state: "queued", why: null });
    expect(deliveryLine(item({ decision: { ...item().decision!, delivery: { state: "delivered", at: T0 + 5000 } } }))).toEqual({ state: "delivered", at: T0 + 5000 });
    expect(deliveryLine(item({ decision: { ...item().decision!, delivery: { state: "uncertain", at: null } } }))).toEqual({ state: "uncertain" });
    expect(deliveryLine(item({ decision: { ...item().decision!, delivery: undefined } }))).toBeNull();
  });
  it("the phone's Today says it is queued, or may have been delivered, in the row", () => {
    const row = (d: DecisionItem) => horizon({ decisions: [d], workers: [], later: new Set(), now: T0 + 60_000 }).whenReady.find(r => r.key === "d:ny-7")?.detail;
    expect(row(item())).toBe("You said “Ship it” at 09:00. Queued, it will be delivered.");
    expect(row(item({ decision: { ...item().decision!, delivery: { state: "uncertain", at: null } } }))).toBe("You said “Ship it” at 09:00. May have been delivered.");
    expect(row(item({ decision: { ...item().decision!, delivery: { state: "delivered", at: T0 + 5000 } } }))).toBe("You said “Ship it” at 09:00. The manager takes it from here.");
  });
});
```

Create `apps/web/test/outbox-deliveries.test.ts`:

```ts
// A message to the manager through the fleet's delivery queue, in the outbox (fleet-clients §9.1, Task 13): the hub's
// answer says where it stands, and each `deliveries` frame moves it on by its request id; one in doubt that the hub
// later finds queued is Sent. A frame for a request this device doesn't hold changes nothing. While it waits it can be
// cancelled, and it is never retried: no two-minute deadline, no Retry (ruling 83). A memory store.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Outbox, type CancelOutcome, type PostOutcome } from "../src/lib/outbox/outbox.ts";
import { memoryStore, type OutboxStore } from "../src/lib/outbox/store.ts";
import { BUDGET_MS, canCancel, canRetry, commandDelivery } from "../src/lib/outbox/state.ts";
import { sendLabel } from "../src/lib/outbox/words.ts";

const T0 = Date.UTC(2026, 9, 8, 9);
let store: OutboxStore;
let answer: () => PostOutcome;
let cancelled: () => CancelOutcome;
let posts = 0;
let cancels = 0;
let n = 0;
const outbox = () => new Outbox({
  store, post: async () => { posts++; return answer(); }, cancel: async () => { cancels++; return cancelled(); }, connected: () => true, onChange: () => {},
  timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) },
  newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
});
const cmd = { worker: "pc.aaaaaaaa.0", workerName: "manager", text: "status please", uploads: [], seen: "none" };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); store = memoryStore(); n = 0; posts = 0; cancels = 0; });
afterEach(() => vi.useRealTimers());

describe("the hub's word on a message to the manager", () => {
  it("is kept with the Sent record, and each deliveries frame moves it on", async () => {
    answer = () => ({ kind: "typed", at: T0, delivery: { state: "queued", waiting: "menu_open", why: null } });
    const o = outbox();
    const r = await o.enqueue(cmd);
    await flush();
    expect(o.records[0]).toMatchObject({ state: "sent", delivery: { state: "queued", waiting: "menu_open" } });
    await o.deliveries([{ requestId: r.id, state: "delivered", waiting: null, why: null }]);
    expect(o.records[0]?.delivery).toEqual({ state: "delivered", waiting: null, why: null });
    expect((await store.all())[0]?.delivery?.state).toBe("delivered");
  });

  it("one in doubt that the hub then finds queued is Sent, with its delivery", async () => {
    answer = () => ({ kind: "uncertain" });
    const o = outbox();
    const r = await o.enqueue(cmd);
    await flush();
    expect(o.records[0]?.state).toBe("uncertain");
    await o.deliveries([{ requestId: r.id, state: "queued", waiting: null, why: null }]);
    expect(o.records[0]).toMatchObject({ state: "sent", error: null, delivery: { state: "queued" } });
  });

  it("a frame for a request this device doesn't hold changes nothing (negative control)", async () => {
    answer = () => ({ kind: "typed", at: T0 });
    const o = outbox();
    await o.enqueue(cmd);
    await flush();
    await o.deliveries([{ requestId: "someone-elses", state: "delivered", waiting: null, why: null }]);
    expect(o.records[0]?.delivery).toBeUndefined();
  });
});

describe("waiting, and Cancel (ruling 83)", () => {
  const waiting = () => ({ kind: "typed" as const, at: T0, delivery: { state: "queued" as const, waiting: "busy", why: null } });

  it("waits as long as the hub says, never Not sent after two minutes, never retried; Cancel withdraws it", async () => {
    answer = waiting;
    const o = outbox();
    const r = await o.enqueue(cmd);
    await flush();
    await vi.advanceTimersByTimeAsync(10 * BUDGET_MS);
    const saved = o.records[0];
    expect(saved && [sendLabel(saved, [saved], T0 + 10 * BUDGET_MS), canRetry(saved, T0 + 10 * BUDGET_MS), canCancel(saved)]).toEqual(["Queued, it will be delivered", false, true]);
    expect(posts).toBe(1);
    cancelled = () => ({ kind: "cancelled", delivery: { state: "given_up", waiting: null, why: "cancelled" } });
    expect(await o.cancel(r.id)).toBe("cancelled");
    expect(o.records[0]).toMatchObject({ state: "sent", delivery: { state: "given_up", why: "cancelled" } });
    expect(o.records[0] && canCancel(o.records[0])).toBe(false);
    expect((await store.all())[0]?.delivery?.state).toBe("given_up");
  });

  it("too late, typed meanwhile: it says it was typed, and Cancel is gone", async () => {
    answer = waiting;
    const o = outbox();
    const r = await o.enqueue(cmd);
    await flush();
    cancelled = () => ({ kind: "too_late", delivery: null });
    expect(await o.cancel(r.id)).toBe("too_late");
    expect(o.records[0]?.delivery).toEqual({ state: "queued", waiting: "typed", why: null });
    expect(o.records[0] && canCancel(o.records[0])).toBe(false);
  });

  it("typed already, or a message typed directly: no Cancel, nothing asked of the hub (negative control)", async () => {
    answer = () => ({ kind: "typed", at: T0, delivery: { state: "queued", waiting: "typed", why: null } });
    const o = outbox();
    const typed = await o.enqueue(cmd);
    answer = () => ({ kind: "typed", at: T0 });
    const direct = await o.enqueue({ ...cmd, worker: "pc.aaaaaaaa.1", workerName: "alpha" });
    await flush();
    expect([await o.cancel(typed.id), await o.cancel(direct.id), cancels]).toEqual([null, null, 0]);
  });
});

describe("reading the hub's delivery", () => {
  it("takes what fits, and reads a state it doesn't know as queued", () => {
    expect(commandDelivery({ requestId: "r1", state: "delivered", waiting: null, why: null })).toEqual({ state: "delivered", waiting: null, why: null });
    expect(commandDelivery({ state: "beamed", waiting: 7, why: "expired" })).toEqual({ state: "queued", waiting: null, why: "expired" });
    expect(commandDelivery(undefined)).toBeNull();
    expect(commandDelivery("queued")).toBeNull();
  });
});
```

Create `apps/web/test/manager-queue-web.test.ts` (headless Chromium, as `answer-in-doubt-web.test.ts`):

```ts
// The manager's delivery queue in the app (fleet-clients §9.1, Task 13): a message to the manager reads "Queued, it will
// be delivered" with why it waits, and can be cancelled while it does (ruling 83), then "Delivered", "May have been
// delivered" or "Not delivered" as the hub's `deliveries` frames say; an answer's card reads the same on the desktop and
// on the phone. The real Desktop client and
// the phone's decision card in headless Chromium, the hub faked at the browser's edges (harness.ts). Synthetic data only.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Escalations, escalationId, type Ask, type Decision } from "@morndo/domain";
import { WAITING, queuedLine } from "../src/lib/queue-words.ts";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

const NOW = Date.now();
const ask: Ask = {
  id: escalationId("ny-7"), asker: { kind: "manager", name: "Manager", workerId: "%0" }, need: "decision", title: "Ship the demo release tonight?",
  shortTitle: null, summary: null, minutes: null, link: null, details: null, context: null, contextKind: "markdown",
  options: [{ key: "ship", label: "Ship it", detail: null }, { key: "hold", label: "Hold", detail: null }], answerBy: "tap",
  recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null, askedAt: NOW - 20 * 60_000, messageId: null, tracking: "ledger",
};
const board = new Escalations();
board.reconcile([{ ask, source: { kind: "open" }, answered: null }], NOW, true);
const decision = (delivery: Decision["delivery"]): Decision => ({ choice: { kind: "option", key: "ship", label: "Ship it" }, at: NOW - 60_000, via: "here", endpointId: null, sessionId: null, delivery });
const answered = (delivery: Decision["delivery"], waiting?: string) =>
  ({ ...board.get("ny-7"), status: "answered", decision: decision(delivery), answerable: "already_answered", version: "v-ny-7", ...(waiting ? { waiting } : {}) });

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Desktop from "/src/lib/desktop/Desktop.svelte";
  import DecisionCard from "/src/lib/phone/DecisionCard.svelte";
  const view = new URLSearchParams(location.search).get("view");
  if (view === "desktop") {
    mount(Desktop, { target: document.body, props: { device: "dev-1", office: "Test office", verifiedAt: Date.now(), policy: { stay: "7d", stepUp: "1h" }, desktop: false, onSignedOut: () => {} } });
  } else {
    const item = window.__item;                     // set by the test before the page loads
    mount(DecisionCard, { target: document.body, props: { item, primed: true, index: 1, of: 1, now: Date.now(), answering: null,
      refusal: null, note: null, onPick: async () => true, onUndo() {}, onVerifyAgain() {}, onTryAgain() {}, onScreen() {}, onNext() {} } });
  }
  window.__ready = true;
</script></body></html>`;

type SendWin = FeedWin & { __posts: { requestId: string; text: string }[]; __delivery: unknown; __cancels: string[] };
// Runs in the page before the app: POST /api/workers/<id>/send answers as a fleet hub does for the manager (spec §9.1):
// ok, with where the message stands in the queue; never an echo (it isn't in the conversation yet).
function fakeQueueSend() {
  const w = globalThis as unknown as SendWin & { fetch: typeof fetch };
  w.__posts = [];
  w.__cancels = [];
  w.__delivery = { state: "queued", waiting: "menu_open", why: null };
  const inner = w.fetch.bind(w);
  w.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    // The principal's Cancel (ruling 83): the hub withdraws it, given up, cancelled.
    if (url === "/api/manager/cancel") {
      const { requestId } = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { requestId: string };
      w.__cancels.push(requestId);
      const delivery = { requestId, state: "given_up", waiting: null, why: "cancelled" };
      return new Response(JSON.stringify({ ok: true, delivery }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (!/^\/api\/workers\/[^/]+\/send$/.test(url)) return inner(input, init);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { requestId: string; text: string };
    w.__posts.push({ requestId: body.requestId, text: body.text });
    const delivery = { requestId: body.requestId, ...(w.__delivery as object) };
    return new Response(JSON.stringify({ ok: true, at: Date.now(), delivery }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

let web: Web;
let tab: Page;
let errors: string[];
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });
afterEach(async () => { await tab?.context().close(); });

async function open(query: string, size: { width: number; height: number }, init?: () => Promise<void>) {
  const context = await web.browser.newContext({ viewport: size });
  tab = await context.newPage();
  errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  await init?.();
  await tab.goto(`${web.url}?${query}`);
  await tab.waitForFunction(() => (globalThis as unknown as { __ready?: boolean }).__ready === true);
}
async function desktop() {
  await open("view=desktop", { width: 1600, height: 1000 }, async () => {
    await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }] });
    await tab.addInitScript(fakeQueueSend);
  });
  await tab.waitForFunction(() => typeof (globalThis as unknown as FeedWin).__feedPush === "function");
}
const push = (m: unknown) => tab.evaluate(x => (globalThis as unknown as FeedWin).__feedPush(x), m);
async function writeToManager(text: string): Promise<string> {
  await tab.locator("button.row", { hasText: "Manager" }).first().click();
  const box = tab.getByRole("textbox", { name: "Message Manager" });
  await box.fill(text);
  await box.press("Enter");
  await tab.waitForFunction(t => (globalThis as unknown as SendWin).__posts.some(p => p.text === t), text);
  return tab.evaluate(t => (globalThis as unknown as SendWin).__posts.find(p => p.text === t)?.requestId ?? "", text);
}
const entry = (text: string) => tab.locator("article.pending", { hasText: text });

describe("a message to the manager, on the desktop", () => {
  it("queued with why it waits; then Delivered", { timeout: 60_000 }, async () => {
    await desktop();
    const id = await writeToManager("status please");
    await entry("status please").locator("time", { hasText: "Queued, it will be delivered" }).waitFor({ timeout: 10_000 });
    await entry("status please").getByText(queuedLine("menu_open")).waitFor();
    await push({ t: "deliveries", items: [{ requestId: "someone-elses", state: "delivered", waiting: null, why: null }] });
    await tab.waitForTimeout(300);
    expect(await entry("status please").locator("time").textContent()).toBe("Queued, it will be delivered");   // negative control
    await push({ t: "deliveries", items: [{ requestId: id, state: "delivered", waiting: null, why: null }] });
    await entry("status please").locator("time", { hasText: /^Delivered$/ }).waitFor({ timeout: 10_000 });
    expect(await entry("status please").getByText(/Queued, it will be delivered:/).count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("may have been delivered, or not delivered with why", { timeout: 60_000 }, async () => {
    await desktop();
    const maybe = await writeToManager("deploy when green");
    await push({ t: "deliveries", items: [{ requestId: maybe, state: "uncertain", waiting: null, why: null }] });
    await entry("deploy when green").locator("time", { hasText: "May have been delivered" }).waitFor({ timeout: 10_000 });
    const lost = await writeToManager("call me back");
    await push({ t: "deliveries", items: [{ requestId: lost, state: "given_up", waiting: null, why: "expired" }] });
    await entry("call me back").locator("time", { hasText: "Not delivered" }).waitFor({ timeout: 10_000 });
    await entry("call me back").getByText("Nothing reached the manager: it waited a whole day and was never typed.", { exact: false }).waitFor();
    await entry("call me back").getByRole("button", { name: "Dismiss" }).waitFor();
    expect(errors).toEqual([]);
  });
});

describe("a message to the manager, cancelled while it waits (ruling 83)", () => {
  it("Cancel withdraws it: Not delivered, no Retry; once typed there is no Cancel", { timeout: 60_000 }, async () => {
    await desktop();
    const id = await writeToManager("never mind");
    await entry("never mind").getByRole("button", { name: "Cancel" }).click();
    await entry("never mind").locator("time", { hasText: "Not delivered" }).waitFor({ timeout: 10_000 });
    await entry("never mind").getByText("Nothing reached the manager: it was withdrawn before it was typed.", { exact: false }).waitFor();
    expect(await tab.evaluate(() => (globalThis as unknown as SendWin).__cancels)).toEqual([id]);
    expect(await entry("never mind").getByRole("button", { name: /Retry|Cancel/ }).count()).toBe(0);
    const typed = await writeToManager("status please");
    await push({ t: "deliveries", items: [{ requestId: typed, state: "queued", waiting: "typed", why: null }] });
    await entry("status please").getByText(queuedLine("typed")).waitFor({ timeout: 10_000 });
    expect(await entry("status please").getByRole("button", { name: "Cancel" }).count()).toBe(0);   // negative control
    expect(errors).toEqual([]);
  });
});

describe("an answer to the manager, its card", () => {
  it("on the desktop: queued with why it waits, then delivered, then may have been delivered", { timeout: 60_000 }, async () => {
    await desktop();
    const card = tab.locator('[data-decision="ny-7"]').first();
    const ledger = { configured: true, ok: true, at: Date.now() };
    await push({ t: "decisions", items: [answered({ state: "queued", at: null }, "draft_present")], ledger });
    await card.getByText(`Queued, it will be delivered: ${WAITING.draft_present}.`).waitFor({ timeout: 15_000 });
    await push({ t: "decisions", items: [answered({ state: "delivered", at: NOW })], ledger });
    await card.locator('[data-delivery="delivered"]', { hasText: "Delivered" }).waitFor({ timeout: 10_000 });
    await push({ t: "decisions", items: [answered({ state: "uncertain", at: null })], ledger });
    await card.locator('[data-delivery="uncertain"]', { hasText: "May have been delivered" }).waitFor({ timeout: 10_000 });
    await push({ t: "decisions", items: [answered(undefined)], ledger });          // answered directly: as before
    await card.getByText("The manager has it and closes this when it's done.").waitFor({ timeout: 10_000 });
    expect(errors).toEqual([]);
  });

  it("on the phone: the same words", { timeout: 60_000 }, async () => {
    const card = (item: unknown) => open("view=card", { width: 390, height: 844 }, async () => {
      await tab.addInitScript(x => { (globalThis as unknown as { __item: unknown }).__item = x; }, item);
    });
    await card(answered({ state: "queued", at: null }, "no_pane"));
    await tab.getByText(`Answered. Queued, it will be delivered: ${WAITING.no_pane}.`).waitFor({ timeout: 15_000 });
    await tab.context().close();
    await card(answered({ state: "uncertain", at: null }));
    await tab.getByText("Answered. May have been delivered", { exact: false }).waitFor({ timeout: 15_000 });
    expect(errors).toEqual([]);
  });

  it("given up, never typed: the card is open again and says Not delivered, on the desktop and on the phone", { timeout: 60_000 }, async () => {
    const NOT_DELIVERED = "Not delivered: the answer never reached the manager. Answer again.";
    const reopened = { ...board.get("ny-7"), answerable: null, version: "v-ny-7", notice: NOT_DELIVERED };
    await desktop();
    await push({ t: "decisions", items: [reopened], ledger: { configured: true, ok: true, at: Date.now() } });
    await tab.locator('[data-decision="ny-7"]').first().getByText(NOT_DELIVERED).waitFor({ timeout: 15_000 });
    await tab.context().close();
    await open("view=card", { width: 390, height: 844 }, async () => {
      await tab.addInitScript(x => { (globalThis as unknown as { __item: unknown }).__item = x; }, reopened);
    });
    await tab.getByText(NOT_DELIVERED).waitFor({ timeout: 15_000 });
    await tab.getByRole("button", { name: "Ship it" }).waitFor();                // open: it can be answered again
    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 13.2: Run them and see them fail**

Run: `npx vitest run apps/web/test/queue-words.test.ts apps/web/test/outbox-deliveries.test.ts`
Expected: FAIL. `queue-words.test.ts` errors with `Error: Cannot find module '../src/lib/queue-words.ts' imported from …/apps/web/test/queue-words.test.ts` and runs no tests; `outbox-deliveries.test.ts` fails 7 of 7: `AssertionError: expected { …(13) } to match object { state: 'sent', delivery: { …(2) } }`, `TypeError: o.deliveries is not a function` (two), `TypeError: canCancel is not a function`, `TypeError: o.cancel is not a function` (two), `TypeError: commandDelivery is not a function`.

Run: `npx vitest run apps/web/test/manager-queue-web.test.ts`
Expected: FAIL: the suite doesn't load (`Cannot find module '../src/lib/queue-words.ts'`), so none of its 6 tests runs.

- [ ] **Step 13.3: Implement the words, the outbox's deliveries and Cancel, and the cards**

Create `apps/web/src/lib/queue-words.ts`:

```ts
// The manager's delivery queue in words (fleet-clients §9.1, Task 13; plan.md Wording): the three states exactly, and
// why a message or an answer still waits, in plain words, one for each reason the queue gives (a WaitingReason, spec
// §4.2), and once typed ("typed": not in the manager's conversation yet; "held": Claude Code holds it in its own queue).
// The same words for a message (the outbox) and an answer (the decision cards, the phone's Today). A reason this app
// doesn't know adds nothing it can't vouch for.
import type { GiveUpReason, WaitingReason } from "@morndo/protocol";

export const QUEUED = "Queued, it will be delivered";
export const DELIVERED = "Delivered";
export const MAY_HAVE_BEEN = "May have been delivered";
export const NOT_DELIVERED = "Not delivered";

// After "Queued, it will be delivered: ".
export const WAITING: Record<string, string> = {
  menu_open: "a menu is open in the manager's terminal; it goes in once that's answered",
  draft_present: "the manager's input box has text that isn't from Morndo; it goes in once that's sent or cleared",
  no_input_box: "the manager isn't showing its input box right now; it goes in once it does",
  busy: "something else is typing into the manager right now; it goes in right after",
  no_pane: "the manager isn't running right now; it goes in once it's back",
  no_session: "the manager is still starting; it goes in once it's ready",
  earlier: "an earlier message to the manager goes in first",
  unavailable: "the machine didn't answer, trying again",                 // reconciliation ruling 15
  typed: "it was typed, and the manager hasn't shown it in its conversation yet",
  held: "the manager is busy and holds it in its own queue; it takes it after its current step",
} satisfies Record<WaitingReason | "typed" | "held", string>;

// After "Nothing reached the manager: ".
export const GIVEN_UP: Record<string, string> = {
  expired: "it waited a whole day and was never typed",
  cancelled: "it was withdrawn before it was typed",
  gone: "the manager it was meant for was replaced before it could take it",
  refused: "the manager's machine refused it",
} satisfies Record<GiveUpReason, string>;

export const queuedLine = (waiting: string | null | undefined): string => {
  const why = waiting ? WAITING[waiting] : undefined;
  return `${QUEUED}${why ? `: ${why}` : ""}.`;
};
```

The outbox: #29's inbox fields (`queued`, `inbox`, `inboxReason`, `revive`), its two-minute ask of the spool (`#armSpool`, `#askSpool`, `#clearSpool`) and its revived Retry go; the delivery, the hub's frames and Cancel come. #29's ordered disk writes and its echo that leaves the screen first stay.

In `apps/web/src/lib/outbox/state.ts` (1 of 3), replace:

```ts
export type SendState = "queued" | "sending" | "sent" | "failed" | "uncertain";

```

with:

```ts
export type SendState = "queued" | "sending" | "sent" | "failed" | "uncertain";

// A message to the manager through the fleet's delivery queue (fleet-clients §9.1): where it stands there, as the hub
// says (its send answer, then each `deliveries` frame): queued (with why it waits), delivered, uncertain (it may have
// reached the manager), or given up (with why: nothing reached it). Its record stays Sent: the hub took it (S8).
export type CommandDelivery = { state: "queued" | "delivered" | "uncertain" | "given_up"; waiting: string | null; why: string | null };

```

In `apps/web/src/lib/outbox/state.ts` (2 of 3), replace:

```ts
  hubAt?: number | null;
  queued?: boolean;               // Sent into the manager's inbox (ADR-0010): it types it once the pane is free
  // Where that inbox says the command stands, once a repeat has asked. Absent: not known yet, so still "queued".
  inbox?: "queued" | "held" | "typing" | "sent" | "stuck" | "accepted" | "delivered" | "lost" | "expired" | "cancelled" | "gone";
  inboxReason?: string | null;   // "unconfirmed" is a reason on a sent command, not a status of its own
  revive?: true;                  // this attempt is the owner's Retry; a plain repeat must not set it
};

```

with:

```ts
  hubAt?: number | null;
  delivery?: CommandDelivery;
};

// The hub's `delivery` on a send answer, or null when it gives none (a message typed directly). A state this app
// doesn't know reads as queued: it never claims a delivery it can't vouch for.
export function commandDelivery(v: unknown): CommandDelivery | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const state = o.state === "delivered" || o.state === "uncertain" || o.state === "given_up" ? o.state : "queued";
  return { state, waiting: typeof o.waiting === "string" ? o.waiting : null, why: typeof o.why === "string" ? o.why : null };
}

```

In `apps/web/src/lib/outbox/state.ts` (3 of 3), replace:

```ts
// Retry on Not sent, Check again on Uncertain: the same request id both times, so the hub types it at most once (S5).
// A queued command is Not sent only once the spool expired it, still untyped. accepted, sent, stuck and unconfirmed
// have no such deadline, so the two minutes passing is not a reason to retry them.
export const canRetry = (r: OutboxRecord, now: number) =>
  ((r.state === "failed" || r.state === "uncertain") && now - r.createdAt < RETRY_WINDOW_MS)
  || (r.queued === true && r.state === "sent" && (r.inbox === "expired" || r.inbox === "lost" || r.inbox === "cancelled") && now - r.createdAt < RETRY_WINDOW_MS);

```

with:

```ts
// Retry on Not sent, Check again on Uncertain: the same request id both times, so the hub types it at most once (S5).
// A message the manager's queue has is Sent: never retried (ruling 83). It waits there up to 24 hours, or is cancelled.
export const canRetry = (r: OutboxRecord, now: number) => (r.state === "failed" || r.state === "uncertain") && now - r.createdAt < RETRY_WINDOW_MS;
// Cancel: a message the manager's queue still holds, not typed yet (ruling 83). Once typed it can't be taken back.
export const canCancel = (r: OutboxRecord) => r.state === "sent" && r.delivery?.state === "queued" && r.delivery.waiting !== "typed" && r.delivery.waiting !== "held";

```

In `apps/web/src/lib/outbox/outbox.ts` (1 of 15), replace:

```ts
// Design reference, not code: Signal-Desktop ts/jobs/JobQueue.std.ts and conversationJobQueue.preload.ts.
import { ATTEMPT_TIMEOUT_MS, BUDGET_MS, advance, canRetry, matchEchoes, retryDelay, type Echo, type OutboxRecord } from "./state.ts";
import type { OutboxStore } from "./store.ts";
```

with:

```ts
// Design reference, not code: Signal-Desktop ts/jobs/JobQueue.std.ts and conversationJobQueue.preload.ts.
import type { QueuedCommand } from "@morndo/protocol";
import { ATTEMPT_TIMEOUT_MS, BUDGET_MS, advance, canCancel, canRetry, matchEchoes, retryDelay, type CommandDelivery, type Echo, type OutboxRecord } from "./state.ts";
import type { OutboxStore } from "./store.ts";
```

In `apps/web/src/lib/outbox/outbox.ts` (2 of 15), replace:

```ts
export type PostOutcome =
  | { kind: "typed"; at?: number; queued?: true; inbox?: OutboxRecord["inbox"]; reason?: string | null }   // queued: in the manager's inbox (ADR-0010); inbox: where the spool says it stands
  | { kind: "uncertain" }
```

with:

```ts
export type PostOutcome =
  | { kind: "typed"; at?: number; delivery?: CommandDelivery }   // delivery: the manager's queue has it (fleet-clients §9.1)
  | { kind: "uncertain" }
```

In `apps/web/src/lib/outbox/outbox.ts` (3 of 15), replace:

```ts

// Still waiting to be typed: the spool has not said otherwise. Those are the ones a later ask can find expired.
const spoolWaiting = (inbox: OutboxRecord["inbox"]) => inbox === undefined || inbox === "queued" || inbox === "held";

// A sent record, with the spool's word when the hub reported one, and without the owner's Retry flag.
function sentRecord(r: OutboxRecord, o: Extract<PostOutcome, { kind: "typed" }>, sentAt: number): OutboxRecord {
  const next: OutboxRecord = { ...r, state: "sent", sentAt, typedAt: o.at ?? null, error: null };
  delete next.revive;
  if (o.queued) next.queued = true;
  else { delete next.queued; delete next.inbox; delete next.inboxReason; }   // delivered: Sent, not still queued as lost (round 3.4)
  // A fresh queue (a successful Retry) names no spool word: the old "expired" must not stay (round 3.2).
  if (o.queued && o.inbox) { next.inbox = o.inbox; next.inboxReason = o.reason ?? null; }
  else if (o.queued) { delete next.inbox; delete next.inboxReason; }
  return next;
}

```

with:

```ts

// A sent record, with where the manager's queue has it when the hub says so (fleet-clients §9.1).
function sentRecord(r: OutboxRecord, o: Extract<PostOutcome, { kind: "typed" }>, sentAt: number): OutboxRecord {
  return { ...r, state: advance(r.state, "sent"), sentAt, typedAt: o.at ?? null, error: null, ...(o.delivery ? { delivery: o.delivery } : {}) };
}

// What the hub said to a Cancel (ruling 83): withdrawn, with where it stands now (given up: cancelled); too late (typed
// meanwhile), with where it stands when the hub says; or no answer of the hub's own (Cancel can be pressed again).
export type CancelOutcome = { kind: "cancelled"; delivery: CommandDelivery } | { kind: "too_late"; delivery: CommandDelivery | null } | { kind: "unanswered" };

```

In `apps/web/src/lib/outbox/outbox.ts` (4 of 15), replace:

```ts
  #post: (r: OutboxRecord, signal: AbortSignal) => Promise<PostOutcome>;
  #timers: Timers;
```

with:

```ts
  #post: (r: OutboxRecord, signal: AbortSignal) => Promise<PostOutcome>;
  #cancel: ((r: OutboxRecord) => Promise<CancelOutcome>) | null;
  #timers: Timers;
```

In `apps/web/src/lib/outbox/outbox.ts` (5 of 15), replace:

```ts
  #spent = new Set<string>();                      // echoes that already ended an entry
  #spoolWait = new Map<string, unknown>();         // when to ask where a queued command stands
  #echoing: Promise<void> = Promise.resolve();     // echo matching runs one call at a time
```

with:

```ts
  #spent = new Set<string>();                      // echoes that already ended an entry
  #echoing: Promise<void> = Promise.resolve();     // echo matching runs one call at a time
```

In `apps/web/src/lib/outbox/outbox.ts` (6 of 15), replace:

```ts
    store: OutboxStore; post: (r: OutboxRecord, signal: AbortSignal) => Promise<PostOutcome>; timers: Timers; connected: () => boolean;
    onChange: (records: OutboxRecord[]) => void; newId?: () => string;
```

with:

```ts
    store: OutboxStore; post: (r: OutboxRecord, signal: AbortSignal) => Promise<PostOutcome>; timers: Timers; connected: () => boolean;
    cancel?: (r: OutboxRecord) => Promise<CancelOutcome>;               // the hub's cancel of a message the manager's queue holds
    onChange: (records: OutboxRecord[]) => void; newId?: () => string;
```

In `apps/web/src/lib/outbox/outbox.ts` (7 of 15), replace:

```ts
    this.#post = d.post;
    this.#timers = d.timers;
```

with:

```ts
    this.#post = d.post;
    this.#cancel = d.cancel ?? null;
    this.#timers = d.timers;
```

In `apps/web/src/lib/outbox/outbox.ts` (8 of 15), replace:

```ts
    this.#kickAll();
    for (const id of fresh.keys()) this.#armSpool(id);
  }
```

with:

```ts
    this.#kickAll();
  }
```

In `apps/web/src/lib/outbox/outbox.ts` (9 of 15), replace:

```ts

  stop() {
    this.#stopped = true;
    for (const id of this.#spoolWait.keys()) this.#clearSpool(id);
    for (const c of this.#inFlight.values()) c.abort();
    this.#wakeAll();
  }

```

with:

```ts

  stop() { this.#stopped = true; for (const c of this.#inFlight.values()) c.abort(); this.#wakeAll(); }

```

In `apps/web/src/lib/outbox/outbox.ts` (10 of 15), replace:

```ts
    if (r.state === "uncertain") return this.#check(id);
    const now = this.#timers.now();
    // The owner's Retry of a command the spool expired. The flag is what lets the hub ask the deliverer again;
    // a plain repeat of the request id must not carry it.
    const reviving = r.inbox === "expired" || r.inbox === "lost" || r.inbox === "cancelled" ? { revive: true as const } : {};
    if (r.queued && r.state === "sent") {
      const again: OutboxRecord = { ...r, state: "queued", error: null, budgetFrom: now, ...reviving };
      delete again.queued;
      if (!(await this.#save(again))) return;
      this.#kick(r.worker);
      return;
    }
    if (!(await this.#save({ ...r, state: advance(r.state, "queued", true), error: null, budgetFrom: now, ...reviving }))) return;
    this.#kick(r.worker);
```

with:

```ts
    if (r.state === "uncertain") return this.#check(id);
    if (!(await this.#save({ ...r, state: advance(r.state, "queued", true), error: null, budgetFrom: this.#timers.now() }))) return;
    this.#kick(r.worker);
```

In `apps/web/src/lib/outbox/outbox.ts` (11 of 15), replace:

```ts
    if (!(await this.#save(sentRecord(r, outcome, this.#timers.now())))) return;
    this.#armSpool(r.id);
    this.#kick(r.worker);                                             // what was written after it goes now
  }
```

with:

```ts
    if (!(await this.#save(sentRecord(r, outcome, this.#timers.now())))) return;
    this.#kick(r.worker);                                             // what was written after it goes now
  }

  // Where this device's messages to the manager stand in the fleet's queue (the hub's `deliveries` frame, by request id;
  // fleet-clients §9.1): each record it names takes the hub's latest word. One Uncertain (the hub couldn't say it was
  // queued) is Sent once the hub says it has it. A record ends as before: by its echo, or Dismiss.
  async deliveries(items: readonly QueuedCommand[]) {
    for (const item of items) {
      const r = this.#records.get(item.requestId);
      if (!r || (r.state !== "sent" && r.state !== "uncertain")) continue;
      const delivery: CommandDelivery = { state: item.state, waiting: item.waiting, why: item.why };
      if (r.state === "sent" && JSON.stringify(r.delivery) === JSON.stringify(delivery)) continue;
      const sent = r.state === "uncertain" ? { state: advance(r.state, "sent"), sentAt: this.#timers.now(), error: null } : {};
      if (await this.#save({ ...r, ...sent, delivery })) this.#kick(r.worker);
    }
  }

  // The principal's Cancel of a message the manager's queue still holds, not typed yet (ruling 83): the hub withdraws it
  // there, and the record says where it stands (Not delivered: cancelled). Too late: it was typed meanwhile, and says so.
  async cancel(id: string): Promise<CancelOutcome["kind"] | null> {
    const r = this.#records.get(id);
    if (!r || !canCancel(r) || !this.#cancel) return null;
    const c = await this.#cancel(r);
    const now = this.#records.get(id);
    if (now && c.kind === "cancelled") await this.#save({ ...now, delivery: c.delivery });
    if (now && c.kind === "too_late") await this.#save({ ...now, delivery: c.delivery ?? { state: "queued", waiting: "typed", why: null } });
    return c.kind;
  }
```

In `apps/web/src/lib/outbox/outbox.ts` (12 of 15), replace:

```ts
    this.#records.delete(id);
    this.#clearSpool(id);
    this.#inFlight.get(id)?.abort();
```

with:

```ts
    this.#records.delete(id);
    this.#inFlight.get(id)?.abort();
```

In `apps/web/src/lib/outbox/outbox.ts` (13 of 15), replace:

```ts
        this.#records.delete(id);
        this.#clearSpool(id);
        drop.push(id);
```

with:

```ts
        this.#records.delete(id);
        drop.push(id);
```

In `apps/web/src/lib/outbox/outbox.ts` (14 of 15), replace:

```ts
          await this.#save(sentRecord(now, outcome, this.#timers.now()));
          this.#armSpool(id);
          return;
```

with:

```ts
          await this.#save(sentRecord(now, outcome, this.#timers.now()));
          return;
```

In `apps/web/src/lib/outbox/outbox.ts` (15 of 15), replace:

```ts

  #clearSpool(id: string) {
    const t = this.#spoolWait.get(id);
    if (t === undefined) return;
    this.#timers.clearTimeout(t);
    this.#spoolWait.delete(id);
  }

  // A command the inbox took is Sent, so nothing posts it again. Ask once its two minutes are up, and again while the
  // spool still says it is waiting, so an expiry is not left as "Queued" (round 3.1). Not a Retry: no revive flag.
  #armSpool(id: string) {
    if (this.#spoolWait.has(id) || this.#stopped || !this.#active) return;
    const r = this.#records.get(id);
    if (!r || r.state !== "sent" || r.queued !== true || !spoolWaiting(r.inbox)) return;
    const until = r.budgetFrom + BUDGET_MS;
    const now = this.#timers.now();
    const delay = now < until ? until - now : 5_000;
    const timer = this.#timers.setTimeout(() => { this.#spoolWait.delete(id); void this.#askSpool(id); }, delay);
    this.#spoolWait.set(id, timer);
  }

  async #askSpool(id: string) {
    const r = this.#records.get(id);
    if (!r || this.#stopped || r.state !== "sent" || r.queued !== true || !spoolWaiting(r.inbox) || this.#inFlight.has(id)) return;
    if (!this.#connected()) { this.#armSpool(id); return; }
    const outcome = await this.#attempt(id, ATTEMPT_TIMEOUT_MS);
    const now = this.#records.get(id);
    if (!now) return;
    if (outcome.kind !== "typed") { this.#armSpool(id); return; }
    if (!(await this.#save(sentRecord(now, outcome, this.#timers.now())))) return;
    this.#armSpool(id);
  }

  // One POST, given up after `ms` (a stalled connection never answers; review H3) or when the record is discarded.
```

with:

```ts

  // One POST, given up after `ms` (a stalled connection never answers; review H3) or when the record is discarded.
```

In `apps/web/src/lib/outbox/device.ts` (1 of 4), replace:

```ts
import { api, ApiError } from "../api.ts";
import { Outbox, type PostOutcome } from "./outbox.ts";
import type { OutboxRecord } from "./state.ts";
import { openStore } from "./store.ts";

const SPOOL = new Set(["queued", "held", "typing", "sent", "stuck", "accepted", "delivered", "lost", "expired", "cancelled", "gone"]);
function spoolWord(inbox: unknown, reason: unknown): { inbox: NonNullable<OutboxRecord["inbox"]>; reason: string | null } | Record<string, never> {
  if (typeof inbox !== "string" || !SPOOL.has(inbox)) return {};
  return { inbox: inbox as NonNullable<OutboxRecord["inbox"]>, reason: typeof reason === "string" ? reason : null };
}

```

with:

```ts
import { api, ApiError } from "../api.ts";
import { Outbox, type CancelOutcome, type PostOutcome } from "./outbox.ts";
import { commandDelivery, type OutboxRecord } from "./state.ts";
import { openStore } from "./store.ts";

```

In `apps/web/src/lib/outbox/device.ts` (2 of 4), replace:

```ts
  try {
    const res = await api.post<{ at?: unknown; queued?: unknown; inbox?: unknown; reason?: unknown }>(`/api/workers/${encodeURIComponent(r.worker)}/send`, { text: r.text, requestId: r.id, uploads: r.uploads, seen: r.seen, name: r.workerName, createdAt: r.createdAt, ...(r.revive ? { retry: true } : {}) }, signal);
    // ok, or 200 "duplicate": typed before. `at` is the hub's time of the typing (review M2). queued: the manager's inbox
    // has it and types it once its pane is free (ADR-0010). inbox: where the spool says that command stands.
    const queued = res.queued === true ? { queued: true as const } : {};
    const inbox = spoolWord(res.inbox, res.reason);
    return typeof res.at === "number" ? { kind: "typed", at: res.at, ...queued, ...inbox } : { kind: "typed", ...queued, ...inbox };
  } catch (e) {
```

with:

```ts
  try {
    const res = await api.post<{ at?: unknown; delivery?: unknown }>(`/api/workers/${encodeURIComponent(r.worker)}/send`, { text: r.text, requestId: r.id, uploads: r.uploads, seen: r.seen, name: r.workerName, createdAt: r.createdAt }, signal);
    // ok, or 200 "duplicate": typed before. `at` is the hub's time of the typing (review M2). `delivery`: the manager's
    // queue has it (fleet-clients §9.1), and where it stands there. `createdAt`: a message to the manager waits up to 24
    // hours from when it was written (ruling 83).
    const delivery = commandDelivery(res.delivery);
    return { kind: "typed", ...(typeof res.at === "number" ? { at: res.at } : {}), ...(delivery ? { delivery } : {}) };
  } catch (e) {
```

In `apps/web/src/lib/outbox/device.ts` (3 of 4), replace:

```ts
    return { kind: "refused", code: e.code, status: e.status };
  }
```

with:

```ts
    return { kind: "refused", code: e.code, status: e.status };
  }
}

// The Cancel of a message the manager's queue still holds (ruling 83): what the hub said. A 409 is too late (typed
// meanwhile); a 404 means the hub has no such message of this device's, so there is nothing to cancel either.
export async function cancelDelivery(r: OutboxRecord): Promise<CancelOutcome> {
  try {
    const res = await api.post<{ delivery?: unknown }>("/api/manager/cancel", { requestId: r.id });
    const delivery = commandDelivery(res.delivery);
    return delivery ? { kind: "cancelled", delivery } : { kind: "unanswered" };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 409 || e.status === 404) && e.code !== `http_${e.status}`) return { kind: "too_late", delivery: commandDelivery(e.data.delivery) };
    return { kind: "unanswered" };
  }
```

In `apps/web/src/lib/outbox/device.ts` (4 of 4), replace:

```ts
    const box = new Outbox({
      store, post, active: !locks,
      timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) },
```

with:

```ts
    const box = new Outbox({
      store, post, cancel: cancelDelivery, active: !locks,
      timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) },
```

In `apps/web/src/lib/outbox/words.ts` (1 of 5), replace:

```ts
import { UNSEEN_AFTER_MS, type OutboxRecord } from "./state.ts";

```

with:

```ts
import { UNSEEN_AFTER_MS, type OutboxRecord } from "./state.ts";
import { DELIVERED, GIVEN_UP, MAY_HAVE_BEEN, NOT_DELIVERED, QUEUED, queuedLine } from "../queue-words.ts";

```

In `apps/web/src/lib/outbox/words.ts` (2 of 5), replace:

```ts
  uncertain: "May have been sent. Check again asks whether it was typed; if that can't be known, it stays here, so look at the worker's screen before sending it again.",
  not_delivered: "Not sent: that command is no longer in the inbox, so it cannot be sent again.",
};
```

with:

```ts
  uncertain: "May have been sent. Check again asks whether it was typed; if that can't be known, it stays here, so look at the worker's screen before sending it again.",
};
```

In `apps/web/src/lib/outbox/words.ts` (3 of 5), replace:

```ts

// Where it stands, in words (S8).
```

with:

```ts

const DELIVERY_LABELS: Record<NonNullable<OutboxRecord["delivery"]>["state"], string> = {
  queued: QUEUED, delivered: DELIVERED, uncertain: MAY_HAVE_BEEN, given_up: NOT_DELIVERED,
};
// A message in the manager's queue, one line more: why it waits, why it never went, or what "may have" means. Empty for
// one delivered, or typed directly.
export function deliveryNote(o: OutboxRecord): string {
  const d = o.state === "sent" ? o.delivery : undefined;
  if (!d) return "";
  if (d.state === "queued") return queuedLine(d.waiting);
  if (d.state === "uncertain") return "It was typed, but never seen in the manager's conversation. Look at its screen before sending it again.";
  if (d.state === "given_up") return `Nothing reached the manager${d.why && GIVEN_UP[d.why] ? `: ${GIVEN_UP[d.why]}` : ""}. Write it again if it's still needed.`;
  return "";
}

// Where it stands, in words (S8).
```

In `apps/web/src/lib/outbox/words.ts` (4 of 5), replace:

```ts
    case "sent":
      // Queued in the manager's inbox. "Not sent" only when the spool expired it, still untyped. A command it has
      // accepted, sent, stuck or left unconfirmed has no deadline and keeps its own words. One typed directly
      // keeps the "not seen yet" warning.
      if (o.queued) return queuedPlace(o);
      return o.sentAt !== null && now - o.sentAt > UNSEEN_AFTER_MS ? "Sent, not seen in the conversation yet" : "Sent";
```

with:

```ts
    case "sent":
      if (o.delivery) return DELIVERY_LABELS[o.delivery.state];               // the manager's queue has it (fleet-clients §9.1)
      return o.sentAt !== null && now - o.sentAt > UNSEEN_AFTER_MS ? "Sent, not seen in the conversation yet" : "Sent";
```

In `apps/web/src/lib/outbox/words.ts` (5 of 5), replace:

```ts
}

function queuedPlace(o: OutboxRecord): string {
  if (o.inbox === "expired") return "Not sent";
  if (o.inbox === "accepted") return "Accepted, waiting to be delivered";
  if (o.inbox === "stuck") return "Stuck, still waiting to be delivered";
  if (o.inbox === "sent" && o.inboxReason === "unconfirmed") return "Sent, not confirmed in the conversation yet";
  if (o.inbox === "sent") return "Sent, not seen in the conversation yet";
  if (o.inbox === "typing") return "Being typed";
  if (o.inbox === "held") return "Held, it will be delivered";
  if (o.inbox === "lost") return "Lost from the queue";
  if (o.inbox === "cancelled") return "Cancelled";
  if (o.inbox === "gone") return "Not in the inbox";
  return "Queued, it will be delivered";
}
```

with:

```ts
}
```

The frames reach the outbox, and Cancel reaches the buttons:

In `apps/web/src/lib/desktop/Desktop.svelte` (1 of 3), replace:

```svelte
  $effect(() => { if (feed.status === "live") outbox?.connected(); });

```

with:

```svelte
  $effect(() => { if (feed.status === "live") outbox?.connected(); });
  // Messages to the manager in the fleet's queue move on as the hub says (fleet-clients §9.1).
  $effect(() => { const items = feed.deliveries; if (items.length) void outboxReady.then(o => o.deliveries(items)); });

```

In `apps/web/src/lib/desktop/Desktop.svelte` (2 of 3), replace:

```svelte
  async function onDiscard(id: string) { forget(id); await outbox?.discard(id); }
  // "Not sent: verify": the passkey check, then the same request id again (AC7 is judged when it arrives).
```

with:

```svelte
  async function onDiscard(id: string) { forget(id); await outbox?.discard(id); }
  // Cancel: the hub withdraws a message the manager's queue still holds (ruling 83); its entry then says Not delivered.
  async function onCancel(id: string) { await outbox?.cancel(id); }
  // "Not sent: verify": the passkey check, then the same request id again (AC7 is judged when it arrives).
```

In `apps/web/src/lib/desktop/Desktop.svelte` (3 of 3), replace:

```svelte
              outgoing={outgoing.filter(r => r.worker === current?.id).map((r): Outgoing => ({ ...r, images: previews.get(r.id) ?? [] }))}
              {onQueue} {onRetry} {onDiscard} {onVerify} {onEdit} {editRequest} {onEdited}
              prefs={prefsOf(current.name)} onDetails={() => current && openDetails(current.id)}
```

with:

```svelte
              outgoing={outgoing.filter(r => r.worker === current?.id).map((r): Outgoing => ({ ...r, images: previews.get(r.id) ?? [] }))}
              {onQueue} {onRetry} {onDiscard} {onCancel} {onVerify} {onEdit} {editRequest} {onEdited}
              prefs={prefsOf(current.name)} onDetails={() => current && openDetails(current.id)}
```

In `apps/web/src/lib/desktop/ChannelView.svelte` (1 of 3), replace:

```svelte

  let { worker, displayName, feed, outgoing, verifiedAt, stepUpMs, panel, prefs, onDetails, onSecurity, onPanel, onQueue, onRetry, onDiscard,
    onVerify, onEdit, editRequest, onEdited, onVerified, dividerMark = undefined, onAtBottom = () => {}, decisions, decisionsOpen, onDecisions, screenRequest, decisionOf, card, focus, desktop,
```

with:

```svelte

  let { worker, displayName, feed, outgoing, verifiedAt, stepUpMs, panel, prefs, onDetails, onSecurity, onPanel, onQueue, onRetry, onDiscard, onCancel = () => {},
    onVerify, onEdit, editRequest, onEdited, onVerified, dividerMark = undefined, onAtBottom = () => {}, decisions, decisionsOpen, onDecisions, screenRequest, decisionOf, card, focus, desktop,
```

In `apps/web/src/lib/desktop/ChannelView.svelte` (2 of 3), replace:

```svelte
    onRetry: (id: string) => void; onDiscard: (id: string) => void; onVerify: (id: string) => void; onEdit: (id: string) => void;
    editRequest: { worker: string; text: string; n: number } | null; onEdited: () => void; onVerified: (at: number) => void;
```

with:

```svelte
    onRetry: (id: string) => void; onDiscard: (id: string) => void; onVerify: (id: string) => void; onEdit: (id: string) => void;
    onCancel?: (id: string) => void;                    // a message the manager's queue still holds (ruling 83)
    editRequest: { worker: string; text: string; n: number } | null; onEdited: () => void; onVerified: (at: number) => void;
```

In `apps/web/src/lib/desktop/ChannelView.svelte` (3 of 3), replace:

```svelte
    <MessageList {worker} {prefs} messages={feed.historyFor === worker.id ? feed.messages : []} loading={feed.historyFor !== worker.id} {outgoing} {displayName} {decisionOf} {card} {focus}
      {onRetry} {onDiscard} {onVerify} {onEdit} {dividerMark} {onAtBottom}
      older={feed.older} olderPages={feed.olderPages} onOlder={() => feed.loadOlder()} detached={feed.detached} newWhileDetached={feed.newWhileDetached} onLatest={() => feed.latest()} />
```

with:

```svelte
    <MessageList {worker} {prefs} messages={feed.historyFor === worker.id ? feed.messages : []} loading={feed.historyFor !== worker.id} {outgoing} {displayName} {decisionOf} {card} {focus}
      {onRetry} {onDiscard} {onVerify} {onEdit} {onCancel} {dividerMark} {onAtBottom}
      older={feed.older} olderPages={feed.olderPages} onOlder={() => feed.loadOlder()} detached={feed.detached} newWhileDetached={feed.newWhileDetached} onLatest={() => feed.latest()} />
```

In `apps/web/src/lib/desktop/MessageList.svelte` (1 of 5), replace:

```svelte
  import { unreachable } from "@morndo/domain";
  import { canRetry, type OutboxRecord } from "../outbox/state.ts";
  import { sendLabel, sendReason } from "../outbox/words.ts";
  import { dividerBefore, scrollAnchor, showJump, type Anchor, type TimelineChange } from "./timeline.ts";
```

with:

```svelte
  import { unreachable } from "@morndo/domain";
  import { canCancel, canRetry, type OutboxRecord } from "../outbox/state.ts";
  import { deliveryNote, sendLabel, sendReason } from "../outbox/words.ts";
  import { dividerBefore, scrollAnchor, showJump, type Anchor, type TimelineChange } from "./timeline.ts";
```

In `apps/web/src/lib/desktop/MessageList.svelte` (2 of 5), replace:

```svelte
  export type Outgoing = OutboxRecord & { images: string[] };
  let { worker, messages, loading, outgoing, displayName, prefs, decisionOf, card, focus, onRetry, onDiscard, onVerify, onEdit,
    dividerMark = undefined, onAtBottom = () => {}, older = { loading: false, done: false, failed: false }, olderPages = 0, onOlder = () => {},
```

with:

```svelte
  export type Outgoing = OutboxRecord & { images: string[] };
  let { worker, messages, loading, outgoing, displayName, prefs, decisionOf, card, focus, onRetry, onDiscard, onVerify, onEdit, onCancel = () => {},
    dividerMark = undefined, onAtBottom = () => {}, older = { loading: false, done: false, failed: false }, olderPages = 0, onOlder = () => {},
```

In `apps/web/src/lib/desktop/MessageList.svelte` (3 of 5), replace:

```svelte
    onRetry: (id: string) => void; onDiscard: (id: string) => void; onVerify: (id: string) => void; onEdit: (id: string) => void;
    // Phase D: the read mark when the conversation was opened (for "New messages"), whether the list is at the bottom
```

with:

```svelte
    onRetry: (id: string) => void; onDiscard: (id: string) => void; onVerify: (id: string) => void; onEdit: (id: string) => void;
    onCancel?: (id: string) => void;                    // a message the manager's queue still holds (ruling 83)
    // Phase D: the read mark when the conversation was opened (for "New messages"), whether the list is at the bottom
```

In `apps/web/src/lib/desktop/MessageList.svelte` (4 of 5), replace:

```svelte
        {#if stuck}<p class="err">{reason(p)}</p>{/if}
        {#if stuck || p.state === "queued" || p.state === "sending" || (p.state === "sent" && label(p) !== "Sent")}
```

with:

```svelte
        {#if stuck}<p class="err">{reason(p)}</p>{/if}
        {#if deliveryNote(p)}<p class="meta-line" data-delivery={p.delivery?.state}>{deliveryNote(p)}</p>{/if}
        {#if stuck || p.state === "queued" || p.state === "sending" || (p.state === "sent" && label(p) !== "Sent")}
```

In `apps/web/src/lib/desktop/MessageList.svelte` (5 of 5), replace:

```svelte
            {:else if p.state === "failed" && p.error === "stale"}<button onclick={() => onEdit(p.id)}>Edit</button>
            {:else if canRetry(p, clockNow)}<button onclick={() => onRetry(p.id)}>{p.state === "uncertain" ? "Check again" : "Retry"}</button>{/if}
            <button onclick={() => onDiscard(p.id)}>{p.state === "sent" ? "Dismiss" : "Discard"}</button>
```

with:

```svelte
            {:else if p.state === "failed" && p.error === "stale"}<button onclick={() => onEdit(p.id)}>Edit</button>
            {:else if canRetry(p, clockNow)}<button onclick={() => onRetry(p.id)}>{p.state === "uncertain" ? "Check again" : "Retry"}</button>
            {:else if canCancel(p)}<button onclick={() => onCancel(p.id)}>Cancel</button>{/if}
            <button onclick={() => onDiscard(p.id)}>{p.state === "sent" ? "Dismiss" : "Discard"}</button>
```

In `apps/web/src/lib/phone/Phone.svelte` (1 of 2), replace:

```svelte
  $effect(() => { if (feed.status === "live") outbox?.connected(); });

```

with:

```svelte
  $effect(() => { if (feed.status === "live") outbox?.connected(); });
  // Messages to the manager in the fleet's queue move on as the hub says (fleet-clients §9.1).
  $effect(() => { const items = feed.deliveries; if (items.length) void device$.ready.then(o => o.deliveries(items)); });

```

In `apps/web/src/lib/phone/Phone.svelte` (2 of 2), replace:

```svelte
      onQueue={async c => { const o = outbox ?? await device$.ready; await o.enqueue(c); }}
      onRetry={id => void outbox?.retry(id)} onDiscard={id => void outbox?.discard(id)}
      onEchoes={(worker, echoes) => void outbox?.echoes(worker, echoes)}
```

with:

```svelte
      onQueue={async c => { const o = outbox ?? await device$.ready; await o.enqueue(c); }}
      onRetry={id => void outbox?.retry(id)} onDiscard={id => void outbox?.discard(id)} onCancel={id => void outbox?.cancel(id)}
      onEchoes={(worker, echoes) => void outbox?.echoes(worker, echoes)}
```

In `apps/web/src/lib/phone/CatchUp.svelte` (1 of 3), replace:

```svelte

  let { feed, session, quick, outgoing, verifiedFresh, verify, onBack, onDay, onQueue, onRetry, onDiscard, onEchoes, onScreen }: {
    feed: LiveFeed; session: CatchUpSession; quick: QuickAnswers; outgoing: OutboxRecord[]; verifiedFresh: boolean; verify: () => Promise<boolean>;
```

with:

```svelte

  let { feed, session, quick, outgoing, verifiedFresh, verify, onBack, onDay, onQueue, onRetry, onDiscard, onCancel = () => {}, onEchoes, onScreen }: {
    feed: LiveFeed; session: CatchUpSession; quick: QuickAnswers; outgoing: OutboxRecord[]; verifiedFresh: boolean; verify: () => Promise<boolean>;
```

In `apps/web/src/lib/phone/CatchUp.svelte` (2 of 3), replace:

```svelte
    onEchoes: (worker: string, echoes: Echo[]) => void; onScreen: (workerId: string) => void;
  } = $props();
```

with:

```svelte
    onEchoes: (worker: string, echoes: Echo[]) => void; onScreen: (workerId: string) => void;
    onCancel?: (id: string) => void;                    // a message the manager's queue still holds (ruling 83)
  } = $props();
```

In `apps/web/src/lib/phone/CatchUp.svelte` (3 of 3), replace:

```svelte
              {now} outgoing={outgoing.filter(o => o.worker === top.worker)} loading={online} {note}
              onReply={reply} onOpen={id => openChat(top.worker, top.conversation, id)} {onRetry} {onDiscard}
              onVerify={id => void verify().then(ok => { if (ok) onRetry(id); })} />
```

with:

```svelte
              {now} outgoing={outgoing.filter(o => o.worker === top.worker)} loading={online} {note}
              onReply={reply} onOpen={id => openChat(top.worker, top.conversation, id)} {onRetry} {onDiscard} {onCancel}
              onVerify={id => void verify().then(ok => { if (ok) onRetry(id); })} />
```

In `apps/web/src/lib/phone/UpdateCard.svelte` (1 of 4), replace:

```svelte
  import { present, withoutFileNotes } from "../desktop/present.ts";
  import { canRetry, type OutboxRecord } from "../outbox/state.ts";
  import { sendLabel, sendReason } from "../outbox/words.ts";
  import { headline, sinceLabel, spanLabel } from "./words.ts";

  let { worker, name, view, mark, now, outgoing, loading, note, onReply, onOpen, onRetry, onDiscard, onVerify }: {
    worker: RosterEntry | null; name: string; view: CatchUpConversationWire | null; mark: number | null; now: number;
```

with:

```svelte
  import { present, withoutFileNotes } from "../desktop/present.ts";
  import { canCancel, canRetry, type OutboxRecord } from "../outbox/state.ts";
  import { deliveryNote, sendLabel, sendReason } from "../outbox/words.ts";
  import { headline, sinceLabel, spanLabel } from "./words.ts";

  let { worker, name, view, mark, now, outgoing, loading, note, onReply, onOpen, onRetry, onDiscard, onVerify, onCancel = () => {} }: {
    worker: RosterEntry | null; name: string; view: CatchUpConversationWire | null; mark: number | null; now: number;
```

In `apps/web/src/lib/phone/UpdateCard.svelte` (2 of 4), replace:

```svelte
    onVerify: (id: string) => void;                     // "Not sent: verify": the passkey check, then the same request again
  } = $props();
```

with:

```svelte
    onVerify: (id: string) => void;                     // "Not sent: verify": the passkey check, then the same request again
    onCancel?: (id: string) => void;                    // a message the manager's queue still holds (ruling 83)
  } = $props();
```

In `apps/web/src/lib/phone/UpdateCard.svelte` (3 of 4), replace:

```svelte
            {#if stuck}<p class="err">{sendReason(o, name, "its screen in Agents")}</p>{/if}
            {#if stuck || o.state === "queued" || o.state === "sending" || (o.state === "sent" && label !== "Sent")}
```

with:

```svelte
            {#if stuck}<p class="err">{sendReason(o, name, "its screen in Agents")}</p>{/if}
            {#if deliveryNote(o)}<p class="note" data-delivery={o.delivery?.state}>{deliveryNote(o)}</p>{/if}
            {#if stuck || o.state === "queued" || o.state === "sending" || (o.state === "sent" && label !== "Sent")}
```

In `apps/web/src/lib/phone/UpdateCard.svelte` (4 of 4), replace:

```svelte
                {:else if o.state === "failed" && o.error === "stale"}<button class="pbtn small" onclick={() => { text = text.trim() ? `${text}\n\n${o.text}` : o.text; onDiscard(o.id); }}>Edit</button>
                {:else if canRetry(o, now)}<button class="pbtn small" onclick={() => onRetry(o.id)}>{o.state === "uncertain" ? "Check again" : "Retry"}</button>{/if}
                <button class="pbtn small" onclick={() => onDiscard(o.id)}>{o.state === "sent" ? "Dismiss" : "Discard"}</button>
```

with:

```svelte
                {:else if o.state === "failed" && o.error === "stale"}<button class="pbtn small" onclick={() => { text = text.trim() ? `${text}\n\n${o.text}` : o.text; onDiscard(o.id); }}>Edit</button>
                {:else if canRetry(o, now)}<button class="pbtn small" onclick={() => onRetry(o.id)}>{o.state === "uncertain" ? "Check again" : "Retry"}</button>
                {:else if canCancel(o)}<button class="pbtn small" onclick={() => onCancel(o.id)}>Cancel</button>{/if}
                <button class="pbtn small" onclick={() => onDiscard(o.id)}>{o.state === "sent" ? "Dismiss" : "Discard"}</button>
```

The cards: #29's `deliveryLine` takes the queue's reasons and `uncertain`:

In `apps/web/src/lib/desktop/decisions.ts` (1 of 3), replace:

```ts
import type { DecisionItem, LedgerState } from "@morndo/protocol";

```

with:

```ts
import type { DecisionItem, LedgerState } from "@morndo/protocol";
import { WAITING } from "../queue-words.ts";

```

In `apps/web/src/lib/desktop/decisions.ts` (2 of 3), replace:

```ts

// A Decision for the manager that waits until it reached the manager (E13): queued, or delivered (and when).
export type DeliveryLine = { state: "queued"; why: string | null } | { state: "delivered"; at: number | null };
export function deliveryLine(d: DecisionItem): DeliveryLine | null {
```

with:

```ts

// An answer for the manager in the fleet's delivery queue (E13; fleet-clients §9.1): queued (with why it waits, in words),
// delivered (and when), or may have been delivered. Null for an answer that went straight in.
export type DeliveryLine = { state: "queued"; why: string | null } | { state: "delivered"; at: number | null } | { state: "uncertain" };
export function deliveryLine(d: DecisionItem): DeliveryLine | null {
```

In `apps/web/src/lib/desktop/decisions.ts` (3 of 3), replace:

```ts
  if (del.state === "delivered") return { state: "delivered", at: del.at };
  return { state: "queued", why: null };
}
```

with:

```ts
  if (del.state === "delivered") return { state: "delivered", at: del.at };
  if (del.state === "uncertain") return { state: "uncertain" };
  return { state: "queued", why: d.waiting ? WAITING[d.waiting] ?? null : null };
}
```

In `apps/web/src/lib/desktop/DecisionCard.svelte` (1 of 2), replace:

```svelte
  import { ago, deliveryLine, dueLabel, REFUSALS, urgency, type DecisionItem } from "./decisions.ts";
  import { clock } from "./grouping.ts";
```

with:

```svelte
  import { ago, deliveryLine, dueLabel, REFUSALS, urgency, type DecisionItem } from "./decisions.ts";
  import { DELIVERED, MAY_HAVE_BEEN, QUEUED } from "../queue-words.ts";
  import { clock } from "./grouping.ts";
```

In `apps/web/src/lib/desktop/DecisionCard.svelte` (2 of 2), replace:

```svelte
        </p>
        {#if dl?.state === "queued"}
          <p class="sub">Queued, it will be delivered{#if dl.why}: {dl.why}{/if}.</p>
        {:else if dl?.state === "delivered"}
          <p class="sub">Delivered{#if dl.at !== null} <span class="t">· {clock(dl.at)}</span>{/if}. The manager closes this when it's done.</p>
        {:else}
```

with:

```svelte
        </p>
        <!-- The manager's queue (fleet-clients §9.1, E13): where the answer stands until it is in the conversation. -->
        {#if dl?.state === "queued"}
          <p class="sub" data-delivery="queued">{QUEUED}{#if dl.why}: {dl.why}{/if}.</p>
        {:else if dl?.state === "delivered"}
          <p class="sub" data-delivery="delivered">{DELIVERED}{#if dl.at !== null} <span class="t">· {clock(dl.at)}</span>{/if}. The manager closes this when it's done.</p>
        {:else if dl?.state === "uncertain"}
          <p class="sub" data-delivery="uncertain">{MAY_HAVE_BEEN}: it was typed, but never seen in the manager's conversation. It stays answered; look at the manager's screen to be sure.</p>
        {:else}
```

In `apps/web/src/lib/phone/DecisionCard.svelte` (1 of 2), replace:

```svelte
  import { REFUSALS, ago, deliveryLine, type DecisionItem } from "../desktop/decisions.ts";
  import { byLabel } from "./horizon.ts";
```

with:

```svelte
  import { REFUSALS, ago, deliveryLine, type DecisionItem } from "../desktop/decisions.ts";
  import { DELIVERED, MAY_HAVE_BEEN, QUEUED } from "../queue-words.ts";
  import { byLabel } from "./horizon.ts";
```

In `apps/web/src/lib/phone/DecisionCard.svelte` (2 of 2), replace:

```svelte
  const left = $derived(answering ? Math.max(0, Math.ceil((answering.commitAt - now) / 1000)) : 0);
  // ADR-0010: an answer for the manager waits in its inbox until it reached the manager.
  function answeredHere(d: DecisionItem): string {
    const dl = deliveryLine(d);
    if (dl?.state === "queued") return `Answered. Queued, it will be delivered${dl.why ? `: ${dl.why}` : ""}.`;
    if (dl?.state === "delivered") return "Answered. Delivered to the manager.";
    return "Answered.";
```

with:

```svelte
  const left = $derived(answering ? Math.max(0, Math.ceil((answering.commitAt - now) / 1000)) : 0);
  // An answer for the manager in the fleet's queue (fleet-clients §9.1, E13): where it stands until it is in the conversation.
  function answeredHere(d: DecisionItem): string {
    const dl = deliveryLine(d);
    if (dl?.state === "queued") return `Answered. ${QUEUED}${dl.why ? `: ${dl.why}` : ""}.`;
    if (dl?.state === "delivered") return `Answered. ${DELIVERED} to the manager.`;
    if (dl?.state === "uncertain") return `Answered. ${MAY_HAVE_BEEN}: look at the manager's screen to be sure.`;
    return "Answered.";
```

In `apps/web/src/lib/phone/horizon.ts` (1 of 2), replace:

```ts
import { deliveryLine, type DecisionItem } from "../desktop/decisions.ts";
import { clause } from "./brief.ts";
```

with:

```ts
import { deliveryLine, type DecisionItem } from "../desktop/decisions.ts";
import { MAY_HAVE_BEEN, QUEUED } from "../queue-words.ts";
import { clause } from "./brief.ts";
```

In `apps/web/src/lib/phone/horizon.ts` (2 of 2), replace:

```ts
        : here ? `You said “${here.label}” at ${hm(dec.at)}.` : `You answered in words at ${hm(dec.at)}.`;
      const queued = deliveryLine(d)?.state === "queued";      // ADR-0010: still in the manager's inbox
      rows.push({ key: `d:${d.id}`, needsYou: false, at: d.deadline, title: short(d), detail: queued ? `${said} Queued, it will be delivered.` : `${said} ${asker(d)} takes it from here.`, decisionId: null, item: d });
    }
```

with:

```ts
        : here ? `You said “${here.label}” at ${hm(dec.at)}.` : `You answered in words at ${hm(dec.at)}.`;
      // In the manager's queue (fleet-clients §9.1): not there yet, or may have been.
      const dl = deliveryLine(d);
      const then = dl?.state === "queued" ? `${QUEUED}.` : dl?.state === "uncertain" ? `${MAY_HAVE_BEEN}.` : `${asker(d)} takes it from here.`;
      rows.push({ key: `d:${d.id}`, needsYou: false, at: d.deadline, title: short(d), detail: `${said} ${then}`, decisionId: null, item: d });
    }
```

#29's tests of the inbox's words go: `val-b4-queued-command-label.test.ts`, and the five inbox cases of `outbox.test.ts` (a revived Retry, the two-minute ask, the spool word kept or dropped). Their opposites are in `outbox-deliveries.test.ts` above: never Not sent after two minutes, never retried.

```bash
git rm apps/web/test/val-b4-queued-command-label.test.ts
```

In `apps/web/test/outbox.test.ts` (1 of 2), replace:

```ts
import { memoryStore, type OutboxStore } from "../src/lib/outbox/store.ts";
import { ATTEMPT_TIMEOUT_MS, BUDGET_MS, RETRY_WINDOW_MS, canRetry, type OutboxRecord } from "../src/lib/outbox/state.ts";
import { sendLabel } from "../src/lib/outbox/words.ts";

```

with:

```ts
import { memoryStore, type OutboxStore } from "../src/lib/outbox/store.ts";
import { ATTEMPT_TIMEOUT_MS, RETRY_WINDOW_MS, type OutboxRecord } from "../src/lib/outbox/state.ts";

```

In `apps/web/test/outbox.test.ts` (2 of 2), replace:

```ts
describe("queueing (S4)", () => {
  it("Retry of an expired command is posted as the owner's retry, and that flag does not stay", async () => {
    answer = async () => ({ kind: "typed", queued: true, inbox: "expired", reason: null });
    const o = outbox();
    const r = await o.enqueue(cmd("%0"));
    await flush();
    let revived = false;
    answer = async rec => { revived = rec.revive === true; return { kind: "typed", queued: true, inbox: "queued", reason: null }; };
    await o.retry(r.id);
    await flush();
    expect(revived).toBe(true);
    expect(state(o, r.id)?.revive).toBeUndefined();
  });
  it("asks again after 2 minutes, so an expired command does not stay Queued", async () => {
    answer = async () => ({ kind: "typed", queued: true });
    const o = outbox();
    const r = await o.enqueue(cmd("%0", "ship it"));
    await flush();
    expect(state(o, r.id)).toMatchObject({ state: "sent", queued: true });
    expect(state(o, r.id)?.inbox).toBeUndefined();
    let asks = 0;
    answer = async rec => {
      asks += 1;
      expect(rec.revive).toBeUndefined();
      return { kind: "typed", queued: true, inbox: "expired", reason: null };
    };
    await advance(BUDGET_MS);
    expect(asks).toBe(1);
    const saved = state(o, r.id);
    expect(saved?.inbox).toBe("expired");
    expect(saved && sendLabel(saved, [saved], T0 + BUDGET_MS)).toBe("Not sent");
    expect(saved && canRetry(saved, T0 + BUDGET_MS)).toBe(true);
  });
  it("a successful Retry drops the expired spool word, so it is not still Not sent", async () => {
    answer = async () => ({ kind: "typed", queued: true, inbox: "expired", reason: null });
    const o = outbox();
    const r = await o.enqueue(cmd("%0"));
    await flush();
    answer = async () => ({ kind: "typed", queued: true });
    await o.retry(r.id);
    await flush();
    const saved = state(o, r.id);
    expect(saved?.inbox).toBeUndefined();
    expect(saved?.inboxReason).toBeUndefined();
    expect(saved && sendLabel(saved, [saved], T0)).toBe("Queued, it will be delivered");
    expect(saved && canRetry(saved, T0)).toBe(false);
  });
  it("a Retry the hub says was delivered is Sent, not still queued as lost", async () => {
    answer = async () => ({ kind: "typed", queued: true, inbox: "lost", reason: null });
    const o = outbox();
    const r = await o.enqueue(cmd("%0"));
    await flush();
    const deliveredAt = T0 + 30_000;
    answer = async () => ({ kind: "typed", at: deliveredAt });
    await o.retry(r.id);
    await flush();
    const saved = state(o, r.id);
    expect(saved?.queued).toBeUndefined();
    expect(saved?.inbox).toBeUndefined();
    expect(saved?.inboxReason).toBeUndefined();
    expect(saved && sendLabel(saved, [saved], deliveredAt)).toBe("Sent");
  });
  it("keeps the spool status a queued answer reported, so the label can name it", async () => {
    answer = async () => ({ kind: "typed", queued: true, inbox: "accepted", reason: null });
    const o = outbox();
    const r = await o.enqueue(cmd("%0"));
    await flush();
    expect(state(o, r.id)).toMatchObject({ state: "sent", queued: true, inbox: "accepted", inboxReason: null });
  });
  it("writes the Command down before its first attempt, and it ends Sent", async () => {
```

with:

```ts
describe("queueing (S4)", () => {
  it("writes the Command down before its first attempt, and it ends Sent", async () => {
```

- [ ] **Step 13.4: The gallery's cards, and its check**

In `apps/web/src/lib/gallery/data.ts` (1 of 2), replace:

```ts
    send("held", now - 30_000, "Waiting for the message above.", {}),
    send("inbox", now - 20_000, "Queued in the manager's inbox: it will be delivered.", { state: "sent", sentAt: now - 20_000, attempts: 1, queued: true }),
  ];
```

with:

```ts
    send("held", now - 30_000, "Waiting for the message above.", {}),
    // The manager's queue (fleet-clients §9.1): waiting, with why and its Cancel (ruling 83).
    send("queue", now - 20_000, "Queued for the manager: it will be delivered.", { state: "sent", sentAt: now - 20_000, attempts: 1, delivery: { state: "queued", waiting: "busy", why: null } }),
  ];
```

In `apps/web/src/lib/gallery/data.ts` (2 of 2), replace:

```ts
    { label: "Answered here", item: d("answered", { status: "answered", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 5 * MIN, via: "here", endpointId: null, sessionId: null } }) },
    { label: "Answered, queued for the manager", item: d("queued", { status: "answered", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 2 * MIN, via: "here", endpointId: null, sessionId: null, delivery: { state: "queued", at: null } } }) },
    { label: "Answered, delivered to the manager", item: d("delivered", { status: "answered", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 9 * MIN, via: "here", endpointId: null, sessionId: null, delivery: { state: "delivered", at: now - 8 * MIN } } }) },
    { label: "Settled", item: d("settled", { status: "settled", decision: { choice: { kind: "option", key: "b", label: "Wait a week" }, at: now - 2 * HOUR, via: "elsewhere", endpointId: null, sessionId: null }, resolution: "Moved to next week.", settledAt: now - HOUR }) },
```

with:

```ts
    { label: "Answered here", item: d("answered", { status: "answered", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 5 * MIN, via: "here", endpointId: null, sessionId: null } }) },
    // The manager's queue (fleet-clients §9.1, E13): queued with why it waits, delivered, and may have been delivered.
    { label: "Answered, queued for the manager (its input box has someone's text)", item: d("queued", { status: "answered", answerable: "already_answered", waiting: "draft_present", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 2 * MIN, via: "here", endpointId: null, sessionId: null, delivery: { state: "queued", at: null } } }) },
    { label: "Answered, delivered to the manager", item: d("delivered", { status: "answered", answerable: "already_answered", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 9 * MIN, via: "here", endpointId: null, sessionId: null, delivery: { state: "delivered", at: now - 8 * MIN } } }) },
    { label: "Open again: the answer never reached the manager", item: d("notice", { notice: "Not delivered: the answer never reached the manager. Answer again." }) },
    { label: "Answered, may have been delivered", item: d("uncertain", { status: "answered", answerable: "already_answered", decision: { choice: { kind: "option", key: "b", label: "Wait a week" }, at: now - 3 * HOUR, via: "here", endpointId: null, sessionId: null, delivery: { state: "uncertain", at: null } } }) },
    { label: "Settled", item: d("settled", { status: "settled", decision: { choice: { kind: "option", key: "b", label: "Wait a week" }, at: now - 2 * HOUR, via: "elsewhere", endpointId: null, sessionId: null }, resolution: "Moved to next week.", settledAt: now - HOUR }) },
```

In `e2e/gallery.e2e.ts` (1 of 3), replace:

```ts
let code = 1;
const SENDS = ["Queued", "Waiting to send…", "Sending…", "Sent", "Sent, not seen in the conversation yet", "Not sent", "May have been sent", "Waiting for the message above"];
const PILLS = ["Connecting", "Live", "Reconnecting", "Offline", "Signed out"];
```

with:

```ts
let code = 1;
const SENDS = ["Queued", "Waiting to send…", "Sending…", "Sent", "Sent, not seen in the conversation yet", "Not sent", "May have been sent", "Waiting for the message above", "Queued, it will be delivered"];
const PILLS = ["Connecting", "Live", "Reconnecting", "Offline", "Signed out"];
```

In `e2e/gallery.e2e.ts` (2 of 3), replace:

```ts
      // Each decision card in its state (review L2).
      assert(await page.locator('[data-shot="decisions"] figure').count() === 12, "not 12 decision cards");
      const card = (caption: string) => page.locator('[data-shot="decisions"] figure').filter({ has: page.locator("figcaption", { hasText: caption }) }).locator("article.dc");
```

with:

```ts
      // Each decision card in its state (review L2).
      assert(await page.locator('[data-shot="decisions"] figure').count() === 14, "not 14 decision cards");
      const card = (caption: string) => page.locator('[data-shot="decisions"] figure').filter({ has: page.locator("figcaption", { hasText: caption }) }).locator("article.dc");
```

In `e2e/gallery.e2e.ts` (3 of 3), replace:

```ts
      await card("Settled").getByText("Decided:").waitFor();
      // Answering, by clicking as a person would (review L3): the confirmation, words, sending, refused.
```

with:

```ts
      await card("Settled").getByText("Decided:").waitFor();
      // The manager's queue (fleet-clients §9.1): each state in its words.
      await card("Answered, queued for the manager").getByText("Queued, it will be delivered: the manager's input box has text that isn't from Morndo").waitFor();
      await card("Answered, delivered to the manager").getByText("Delivered", { exact: false }).first().waitFor();
      await card("Answered, may have been delivered").getByText("May have been delivered", { exact: false }).waitFor();
      await card("Open again: the answer never reached the manager").getByText("Not delivered: the answer never reached the manager. Answer again.").waitFor();
      // Answering, by clicking as a person would (review L3): the confirmation, words, sending, refused.
```

- [ ] **Step 13.5: Run them and see them pass, then every web suite and the checks**

Run: `npx vitest run apps/web/test/queue-words.test.ts apps/web/test/outbox-deliveries.test.ts apps/web/test/manager-queue-web.test.ts`
Expected: PASS, 3 files, 21 tests (8, 7 and 6).

Run: `npx vitest run apps/web`
Expected: PASS, every test (57 files, 350 tests in the scratch copy, the Chromium ones included).

Run: `npm run check`
Expected: exit 0.

Run: `npm run lint`
Expected: no problems.

Run: `npm run build && node e2e/gallery.e2e.ts`
Expected: `gallery.e2e.ts` passes 5 of 5: 14 decision cards, the queue's words and the notice. (Run it on its own: `npm run e2e` stops earlier at `desktop.e2e.ts` on a machine without TigerVNC, unrelated to this task.)

Run: `npm run check:build`
Expected: every check `PASS` (no gallery in the build; the JS within its budget).

- [ ] **Step 13.6: Commit, then the negative controls**

```bash
git add apps/web/src/lib/queue-words.ts apps/web/src/lib/outbox/state.ts apps/web/src/lib/outbox/outbox.ts apps/web/src/lib/outbox/device.ts apps/web/src/lib/outbox/words.ts apps/web/src/lib/desktop/Desktop.svelte apps/web/src/lib/desktop/ChannelView.svelte apps/web/src/lib/desktop/MessageList.svelte apps/web/src/lib/phone/Phone.svelte apps/web/src/lib/phone/CatchUp.svelte apps/web/src/lib/phone/UpdateCard.svelte apps/web/src/lib/desktop/decisions.ts apps/web/src/lib/desktop/DecisionCard.svelte apps/web/src/lib/phone/DecisionCard.svelte apps/web/src/lib/phone/horizon.ts apps/web/src/lib/gallery/data.ts e2e/gallery.e2e.ts apps/web/test/outbox.test.ts apps/web/test/queue-words.test.ts apps/web/test/outbox-deliveries.test.ts apps/web/test/manager-queue-web.test.ts
```

```bash
git commit -m "feat(web): the manager's queue in the app: queued with why, delivered, may have been, not delivered, and Cancel"
```

Add to `scripts/negative-controls.ts`, at the end of `CONTROLS` (each seen to bite):

```ts
  // ---- fleet-clients Task 13: the manager's queue in the app (plan/04-hub-web.md)
  { id: "fc13-label-ignores-delivery", task: "fc13", file: "apps/web/src/lib/outbox/words.ts",
    find: "      if (o.delivery) return DELIVERY_LABELS[o.delivery.state];               // the manager's queue has it (fleet-clients §9.1)\n", replace: "",
    run: ["apps/web/test/queue-words.test.ts"], expect: "expected 'Sent' to be 'Queued, it will be delivered'" },
  { id: "fc13-unavailable-unworded", task: "fc13", file: "apps/web/src/lib/queue-words.ts",
    find: "  unavailable: \"the machine didn't answer, trying again\",                 // reconciliation ruling 15\n", replace: "",
    run: ["apps/web/test/queue-words.test.ts"], expect: "the machine didn't answer" },
  { id: "fc13-uncertain-stays", task: "fc13", file: "apps/web/src/lib/outbox/outbox.ts",
    find: "      if (!r || (r.state !== \"sent\" && r.state !== \"uncertain\")) continue;", replace: "      if (!r || r.state !== \"sent\") continue;",
    run: ["apps/web/test/outbox-deliveries.test.ts"], expect: "in doubt that the hub then finds" },
  { id: "fc13-frames-not-applied", task: "fc13", file: "apps/web/src/lib/desktop/Desktop.svelte",
    find: "  $effect(() => { const items = feed.deliveries; if (items.length) void outboxReady.then(o => o.deliveries(items)); });\n", replace: "",
    run: ["apps/web/test/manager-queue-web.test.ts"], expect: "then Delivered" },
  { id: "fc13-today-ignores-delivery", task: "fc13", file: "apps/web/src/lib/phone/horizon.ts",
    find: "const then = dl?.state === \"queued\" ? `${QUEUED}.` : dl?.state === \"uncertain\" ? `${MAY_HAVE_BEEN}.` : `${asker(d)} takes it from here.`;",
    replace: "const then = `${asker(d)} takes it from here.`;",
    run: ["apps/web/test/queue-words.test.ts"], expect: "Today" },
  // Decision 3 (ruling 83): a message the queue holds is never retried, and only one not typed yet can be cancelled.
  { id: "fc13-queued-retried", task: "fc13", file: "apps/web/src/lib/outbox/state.ts",
    find: "export const canRetry = (r: OutboxRecord, now: number) => (r.state === \"failed\" || r.state === \"uncertain\") && now - r.createdAt < RETRY_WINDOW_MS;",
    replace: "export const canRetry = (r: OutboxRecord, now: number) => (r.state === \"failed\" || r.state === \"uncertain\" || r.delivery?.state === \"queued\") && now - r.createdAt < RETRY_WINDOW_MS;",
    run: ["apps/web/test/outbox-deliveries.test.ts"], expect: "never retried" },
  { id: "fc13-cancel-once-typed", task: "fc13", file: "apps/web/src/lib/outbox/state.ts",
    find: " && r.delivery.waiting !== \"typed\" && r.delivery.waiting !== \"held\";", replace: ";",
    run: ["apps/web/test/outbox-deliveries.test.ts"], expect: "too late" },
  { id: "fc13-no-cancel-button", task: "fc13", file: "apps/web/src/lib/desktop/MessageList.svelte",
    find: "            {:else if canCancel(p)}<button onclick={() => onCancel(p.id)}>Cancel</button>{/if}\n", replace: "{/if}\n",
    run: ["apps/web/test/manager-queue-web.test.ts"], expect: "withdraws it" },
```

Run: `node scripts/negative-controls.ts --only fc13-label-ignores-delivery --only fc13-unavailable-unworded --only fc13-uncertain-stays --only fc13-frames-not-applied --only fc13-today-ignores-delivery --only fc13-queued-retried --only fc13-cancel-once-typed --only fc13-no-cancel-button`
Expected: `bit` for each.

```bash
git add scripts/negative-controls.ts
```

```bash
git commit -m "test: negative controls for the manager's queue in the app"
```

---

### Task 14: `morndo lanes`

**Files:**
- Create: `apps/hub/src/console/lanes.ts`
- Modify: `apps/hub/src/main.ts` (the `lanes` command, before the hub's settings; `HELP`)
- Modify: `apps/hub/test/helpers/fake-fleet.ts` (`subscriberCount`; `loseDeliveryAnswers(n, "hang")`, a fleet that takes a delivery and never answers)
- Create: `apps/hub/test/lanes-console.test.ts`
- Modify: `scripts/negative-controls.ts`

**Interfaces:**
- Consumes:
  - **Task 3 (`@morndo/fleet-client`):** `new FleetClient(socket, { client: "lanes" })`, `nodes()`, `lanes()`, `op()`, `deliver()`, `delivery()`, `caps()`, `events()` (`t: "lane"`); `FleetOpFailed`, `FleetUnavailable` (`reached: true`: the request went out and no answer came, in doubt; `false`: nothing left the process, ruling 49), `FleetMismatch`.
  - **Task 1:** `KEY_NAMES`, `KeyName`, `LIMITS.captureMaxLines`, `LIMITS.maxDeliveryId`, `LIMITS.maxSendText`, `LIMITS.laneStopWaitMs`, `Delivery`, `LaneEvent`, `OpError`, `parseWorkerId`, and the op shapes of `pane.capture`, `pane.keys` by `names`, `pane.send`, `lane.start` (`prompt`, and its answer's `waiting` and `prompt`), `lane.stop` (`mode`; an exit not seen in time is `uncertain`, part 02), `inventory.get` (`Pane.status`, `Pane.pid`, `Pane.topic`, `Pane.lastPrompt`: ruling 13).
  - Task 12's fake fleet (Step 12.26: `pane.capture`, `keyNamesTyped`, deliveries, `laneEvent`). Nothing else of Task 12: this task can run right after Step 12.26 (the drift map ran it so, ruling 85), and its `main.ts` edit quotes only text that Task 12 doesn't change.
- Produces:
  ```ts
  // apps/hub/src/console/lanes.ts
  export const EXIT = { ok: 0, usage: 2, late: 3, notDelivered: 4, inDoubt: 5, unavailable: 69 };   // plan.md's exit table (ruling 49)
  export type LanesIo = { env; out(text): Promise<void>; err(text): Promise<void>; stdin(): Promise<string>; interrupted(): Promise<void> };
  export function processIo(): LanesIo;
  export function runLanes(argv: string[], io: LanesIo): Promise<number>;
  export type LaneRow = { name; node; workerId; window; status; pid; cwd; title; topic; lastPrompt; sessionId; online; conflict };   // `morndo lanes --json`'s items (ruling 29)
  export const USAGE: string;
  // apps/hub/test/helpers/fake-fleet.ts
  FakeFleet.subscriberCount(): number;  FakeFleet.loseDeliveryAnswers(n, how?: "drop" | "hang")
  ```

**Behaviour** (spec §9.2; rulings 29 and 49). In doubt is never typed by hand and never reported "not delivered": a delivery's id is its idempotency, so running the same command again with the same `--id` is the safe way on (ruling 49).

| Command | What it does | Exit |
|---|---|---|
| `morndo lanes [--json]` | every lane of every online node from its inventory (name, node, worker id, window, session status, pid, folder, and its title column the session's topic, else its title; `--json`: `LaneRow[]`, with `topic` and `lastPrompt`, ruling 13); a node not online lists the registry's rows, offline | 0 |
| `morndo lanes peek <lane> [--lines N]` | `pane.capture` of the one window of that name (N from 1 to 2000, default 40); `--json`: `{ text, truncated }` | 0; 4 no such lane, two of that name, or its node offline; 2 a bad N |
| `morndo lanes send <lane> <text \| ->` | a delivery: id `lanes:<uuid>`, or `--id` (`lanes:` added when it names no client); prints `<id>: <state>` (`--json`: the Delivery); `-` reads stdin, its last newline dropped; `--wait S` asks every 250 ms until it is final | 0 queued, typed, held or delivered (with `--wait`: delivered); 3 `--wait` ran out; 4 given up, uncertain, or refused (`id_conflict`, `no_session`, …); 5 in doubt: the fleet took it and never answered (also while `--wait` asks), and the line names the id: "run it again with the same --id (--id lanes:…)"; 69 the fleet couldn't be reached (nothing queued) |
| `… send --direct` | `pane.send` at once under the id as its key, with the window's session, for a lane without Claude Code | 0 typed; 4 refused, or not typed; 5 in doubt (no answer, or the node's `uncertain`): the same `--id` again answers its stored outcome and never types twice |
| `morndo lanes keys <lane> <key…>` | `pane.keys` by name; every name on `KEY_NAMES` | 0; 2 a name not on it; 4 refused |
| `morndo lanes start <name> --cwd DIR [--node N] [--account A] [--resume S] [--prompt T]` | `lane.start` on `--node`, or on the one online node; keyed `lanes:start:<uuid>`; prints the worker id, the trust dialog, and the first prompt's delivery id; `--json`: the result with its node, `waiting: "trust"` included | 0 (also when it waits at the trust dialog); 2 no `--cwd`, or several nodes and no `--node`; 4 refused; 5 the fleet took it and never answered: it may have started (a start has no `--id`, so the line says to look with `morndo lanes` first) |
| `morndo lanes stop <lane> [--kill]` | `lane.stop` by the lane's name, `mode: "exit"` (or `"kill"`); each keyed anew (`lanes:stop:<uuid>`), so `--kill` may follow an exit that timed out | 0 stopped; 3 `uncertain` (not seen to close or reach its shell in its 30 s; the line says `--kill` closes it); 4 refused (`denied` for a protected name) |
| `morndo lanes status <id>` | one delivery's state (`--json`: the Delivery and `stale`) | 0 queued, typed, held, delivered; 4 given up, uncertain or unknown |
| `morndo lanes events [--json]` | the fleet's `lane` events as they happen, one line each, until SIGINT or SIGTERM | 0; 69 the fleet couldn't be reached at start |

- Any command: 5 when the fleet was reached and never answered (`FleetUnavailable`, `reached: true`); 69 only when the fleet's socket (`MORNDO_FLEET_SOCKET`, default `~/.local/state/morndo-fleet/fleet.sock` under `HOME`) couldn't be reached, or isn't the client API, so nothing was asked of it; 2 for an unknown command, an option the command doesn't take, or a missing argument. Options may come before or after the lane name (`send --direct --id ID lane text`). A refusal's code goes to stderr (`refused: <code>…`).
- It names itself `lanes` on every request (the fleet's audit, §8). It reads no hub setting and opens no hub database.

- [ ] **Step 14.1: Count the fake fleet's event subscribers, and let it take a delivery and never answer**

`morndo lanes events`' test waits for the command's subscription before it raises an event; the in-doubt test (ruling 49) needs a fleet that stores a delivery and never answers, so the client times out after the POST.

In `apps/hub/test/helpers/fake-fleet.ts` (1 of 4), replace:

```ts
  quietDeliveries(quiet: boolean): void;                    // true: no `delivery` events (one sent while unsubscribed)
  loseDeliveryAnswers(n: number): void;                     // the next n deliveries are stored, and their answer lost
  laneEvent(e: LaneEvent): void;                            // kept for GET /v1/lane-events, and sent as a `lane` event
  close(): Promise<void>;
```

with:

```ts
  quietDeliveries(quiet: boolean): void;                    // true: no `delivery` events (one sent while unsubscribed)
  // The next n deliveries are stored, and their answer lost: the connection drops ("drop"), or no answer ever comes and
  // the client times out ("hang").
  loseDeliveryAnswers(n: number, how?: "drop" | "hang"): void;
  laneEvent(e: LaneEvent): void;                            // kept for GET /v1/lane-events, and sent as a `lane` event
  subscriberCount(): number;                                // events WebSockets open now
  close(): Promise<void>;
```

In `apps/hub/test/helpers/fake-fleet.ts` (2 of 4), replace:

```ts
  let lose = 0;
  const stale = (d: Delivery) => status.get(d.node) !== "online";
```

with:

```ts
  let lose = 0;
  let loseBy: "drop" | "hang" = "drop";
  const stale = (d: Delivery) => status.get(d.node) !== "online";
```

In `apps/hub/test/helpers/fake-fleet.ts` (3 of 4), replace:

```ts
      // Stored, and the answer lost on its way: as a fleet that stops after it published the change (its event first).
      if (r === null) { setTimeout(() => req.socket.destroy(), 50); return; }
      return json(r.status, r.body);
```

with:

```ts
      // Stored, and the answer lost on its way: as a fleet that stops after it published the change (its event first).
      if (r === null) { if (loseBy === "drop") setTimeout(() => req.socket.destroy(), 50); return; }
      return json(r.status, r.body);
```

In `apps/hub/test/helpers/fake-fleet.ts` (4 of 4), replace:

```ts
    quietDeliveries(q) { quiet = q; },
    loseDeliveryAnswers(n) { lose = n; },
    laneEvent(e) { laneEvents.push(e); broadcast({ t: "lane", node: e.node, body: e }); },
    async close() {
```

with:

```ts
    quietDeliveries(q) { quiet = q; },
    loseDeliveryAnswers(n, how = "drop") { lose = n; loseBy = how; },
    laneEvent(e) { laneEvents.push(e); broadcast({ t: "lane", node: e.node, body: e }); },
    subscriberCount: () => subscribers.size,
    async close() {
```

- [ ] **Step 14.2: Write the failing test**

Create `apps/hub/test/lanes-console.test.ts`:

```ts
// `morndo lanes` (fleet-clients §9.2) as a person runs it: the real console, a child process, against the fake fleet on
// a real Unix socket, with a temporary HOME and no hub settings or database. Each command's output and exit code
// (0 accepted, 3 not delivered in time, 4 given up, refused or uncertain, 69 the fleet unavailable, 2 bad arguments).
// Synthetic panes only; never the owner's fleet socket.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LaneEvent } from "@morndo/protocol";
import { localNode, memoryBackend, refusal, until, type FakeFleet, type MemoryBackend } from "./helpers/fake-fleet.ts";
import { startFakeFleet } from "./helpers/fake-fleet.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
let home: string;
let fleet: FakeFleet;
let backend: MemoryBackend;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "morndo-lanes-"));
  backend = memoryBackend({
    "%0": { name: "manager", cwd: "/w/manager", screen: "one\ntwo\nthree\n❯ ", sessionId: "s-m", status: "busy", pid: 4242, topic: "Ship the release", lastPrompt: "check CI" },
    "%1": { name: "alpha", cwd: "/w/alpha", screen: "a1\na2\n❯ ", sessionId: "s-a", status: "idle", pid: 4343 },
    "%2": { name: "shell", cwd: "/w", screen: "$ " },
  });
  fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", backend)] });
});
afterEach(async () => { await fleet.close(); rmSync(home, { recursive: true, force: true }); });

type Ran = { code: number | null; out: string; err: string };
// `morndo lanes …`; `stdin` is written and closed; `during` runs while it does (moving a delivery, say); once its output
// satisfies `interruptWhen`, it gets SIGINT, as from Ctrl-C.
function lanes(args: string[], o: { stdin?: string; env?: Record<string, string>; during?: () => Promise<void>; interruptWhen?: (out: string) => boolean } = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, MORNDO_FLEET_SOCKET: fleet.socketPath, ...o.env };
    const child = spawn(process.execPath, ["--no-warnings", MAIN, "lanes", ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); if (o.interruptWhen?.(out)) child.kill("SIGINT"); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.stdin.end(o.stdin ?? "");
    child.on("error", reject);
    child.on("exit", code => resolve({ code, out, err }));
    void o.during?.();
  });
}

describe("morndo lanes: listing and reading", () => {
  it("lists every lane, with its node, worker id, session status, pid and folder", async () => {
    const r = await lanes([]);
    expect(r.code, r.err).toBe(0);
    const [head, ...rows] = r.out.trim().split("\n");
    expect(head).toMatch(/^NAME\s+NODE\s+WORKER\s+STATUS\s+PID\s+FOLDER\s+TITLE$/);
    expect(rows).toEqual([
      expect.stringMatching(/^alpha\s+pc\s+pc\.aaaaaaaa\.1\s+idle\s+4343\s+\/w\/alpha$/),
      expect.stringMatching(/^manager\s+pc\s+pc\.aaaaaaaa\.0\s+busy\s+4242\s+\/w\/manager\s+Ship the release$/),   // its topic
      expect.stringMatching(/^shell\s+pc\s+pc\.aaaaaaaa\.2\s+-\s+-\s+\/w$/),
    ]);
    expect(new Set(fleet.clients)).toEqual(new Set(["lanes"]));            // it names itself, for the fleet's audit
  });

  it("--json: each lane's fields, its session's topic and last prompt included (ruling 13)", async () => {
    const r = await lanes(["--json"]);
    expect(JSON.parse(r.out)).toContainEqual({ name: "manager", node: "pc", workerId: "pc.aaaaaaaa.0", window: "manager", status: "busy", pid: 4242,
      cwd: "/w/manager", title: null, topic: "Ship the release", lastPrompt: "check CI", sessionId: "s-m", online: true, conflict: false });
    expect(JSON.parse(r.out)).toContainEqual(expect.objectContaining({ name: "shell", topic: null, lastPrompt: null, status: null, pid: null }));
  });

  it("peek: the screen's last lines (default 40, --lines N)", async () => {
    expect((await lanes(["peek", "manager", "--lines", "2"])).out).toBe("three\n❯ \n");
    expect((await lanes(["peek", "manager"])).out).toBe("one\ntwo\nthree\n❯ \n");
    expect((await lanes(["peek", "manager", "--lines", "0"])).code).toBe(2);
    expect((await lanes(["peek", "nobody"])).code).toBe(4);
  });
});

describe("morndo lanes send", () => {
  it("queues a delivery and says where it stands; 0", async () => {
    const r = await lanes(["send", "manager", "status please"]);
    expect(r.code, r.err).toBe(0);
    const [call] = fleet.deliveryCalls;
    expect(call).toMatchObject({ lane: "manager", workerId: null, text: "status please", id: expect.stringMatching(/^lanes:[0-9a-f-]{36}$/) });
    expect(r.out).toBe(`${call?.id}: queued\n`);
  });

  it("- reads the text from stdin, without its last newline", async () => {
    expect((await lanes(["send", "manager", "-"], { stdin: "from stdin\n" })).code).toBe(0);
    expect(fleet.deliveryCalls[0]?.text).toBe("from stdin");
  });

  it("--id chooses it (lanes: added when it names no client); the same id again is the same delivery", async () => {
    expect((await lanes(["send", "manager", "once", "--id", "mine"])).out).toBe("lanes:mine: queued\n");
    expect((await lanes(["send", "manager", "once", "--id", "lanes:mine"])).code).toBe(0);
    expect(fleet.deliveries.size).toBe(1);
    expect((await lanes(["send", "manager", "other text", "--id", "lanes:mine"])).code).toBe(4);   // id_conflict
  });

  it("--wait: 0 once delivered, 3 if not in time, 4 if given up", async () => {
    const moveWhen = (state: "delivered" | "given_up") => async () => {
      await until(() => fleet.deliveryCalls.length > 0);
      const id = fleet.deliveryCalls.at(-1)?.id ?? "";
      fleet.moveDelivery(id, state === "delivered" ? { state, deliveredAt: Date.now() } : { state, why: "expired" });
    };
    const delivered = await lanes(["send", "manager", "a", "--wait", "5"], { during: moveWhen("delivered") });
    expect(delivered.code).toBe(0);
    expect(delivered.out).toMatch(/: delivered\n$/);
    expect((await lanes(["send", "manager", "b", "--wait", "0.5"])).code).toBe(3);
    fleet.deliveryCalls.length = 0;
    expect((await lanes(["send", "manager", "c", "--wait", "5"], { during: moveWhen("given_up") })).code).toBe(4);
  });

  it("--wait: an uncertain delivery (it may have reached the lane) is 4 (ruling 60)", async () => {
    const r = await lanes(["send", "manager", "maybe", "--wait", "5"], {
      during: async () => { await until(() => fleet.deliveryCalls.length > 0); fleet.moveDelivery(fleet.deliveryCalls[0]?.id ?? "", { state: "uncertain", note: "typed, never seen taken" }); },
    });
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/: uncertain\n$/);
  });

  it("the fleet reached but silent (a timeout after the POST) is 5, in doubt; the same --id again is 0, one delivery (ruling 49)", { timeout: 30_000 }, async () => {
    fleet.loseDeliveryAnswers(1, "hang");
    const first = await lanes(["send", "manager", "deploy when green", "--id", "t1"]);
    expect(first.code).toBe(5);
    expect(first.err).toContain("in doubt: the fleet took lanes:t1 and never answered");
    expect(first.err).toContain("run it again with the same --id (--id lanes:t1)");
    expect(await lanes(["send", "manager", "deploy when green", "--id", "t1"])).toMatchObject({ code: 0, out: "lanes:t1: queued\n" });
    expect(fleet.deliveries.size).toBe(1);
  });

  it("--direct types at once, under its id as the key; a refusal is 4", async () => {
    const r = await lanes(["send", "shell", "ls", "--direct", "--id", "d1"]);
    expect(r.code, r.err).toBe(0);
    expect(backend.typed).toEqual([{ pane: "%2", text: "ls", key: "lanes:d1" }]);
    expect(fleet.deliveryCalls).toEqual([]);
    backend.panes["%1"] = { ...backend.panes["%1"]!, problem: "menu_open" };
    expect((await lanes(["send", "alpha", "x", "--direct"])).code).toBe(4);
  });

  it("the fleet not reached: 69, and nothing guessed (negative control)", async () => {
    const r = await lanes(["send", "manager", "x"], { env: { MORNDO_FLEET_SOCKET: join(home, "nothing.sock") } });
    expect(r.code).toBe(69);
    expect(r.err).toContain("the fleet couldn't be reached");                   // 69: never reached, so nothing was queued
    const d = await lanes([], { env: { MORNDO_FLEET_SOCKET: "" } });          // the default socket, under this HOME
    expect(d.code).toBe(69);
    expect(d.err).toContain(join(home, ".local/state/morndo-fleet/fleet.sock"));
  });
});

describe("morndo lanes: keys, start, stop, status, events", () => {
  it("keys by name; a name not on the allow-list is 2, and nothing is sent", async () => {
    expect((await lanes(["keys", "alpha", "Escape", "Enter"])).code).toBe(0);
    expect(backend.keyNamesTyped).toEqual([{ pane: "%1", names: ["Escape", "Enter"] }]);
    expect((await lanes(["keys", "alpha", "F13"])).code).toBe(2);
    expect(backend.keyNamesTyped).toHaveLength(1);
  });

  it("start: lane.start on the one online node, with its folder, account and first prompt", async () => {
    fleet.intercept("lane.start", async () => ({ ok: true, result: { workerId: "pc.aaaaaaaa.9", prompt: "lanes:start:x:prompt" } }));
    const r = await lanes(["start", "build", "--cwd", "/w/build", "--account", "work", "--prompt", "go"]);
    expect(r.code, r.err).toBe(0);
    expect(fleet.calls.find(c => c.op === "lane.start")).toMatchObject({ node: "pc", args: { name: "build", cwd: "/w/build", account: "work", prompt: "go" }, key: expect.stringMatching(/^lanes:start:/) });
    const resume = "3f2c7a1e-9b4d-4e8a-a1c2-5d6e7f809a1b";                     // ruling 60: --resume reaches lane.start
    expect((await lanes(["start", "build", "--cwd", "/w/build", "--resume", resume])).code).toBe(0);
    expect(fleet.calls.filter(c => c.op === "lane.start").at(-1)?.args).toEqual({ name: "build", cwd: "/w/build", resume });
    expect(r.out).toContain("started build on pc: pc.aaaaaaaa.9");
    expect((await lanes(["start", "build"])).code).toBe(2);                    // no --cwd
    fleet.intercept("lane.start", async () => ({ ok: true, result: { workerId: "pc.aaaaaaaa.9", waiting: "trust" } }));
    const json = await lanes(["start", "build", "--cwd", "/w/build", "--json", "--node", "pc"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toEqual({ node: "pc", workerId: "pc.aaaaaaaa.9", waiting: "trust" });
  });

  it("stop: graceful by default, --kill closes the window; not seen to stop in time is 3, a refusal 4 (ruling 29)", async () => {
    fleet.intercept("lane.stop", async call => {
      const a = call.args as { name: string; mode: string };
      if (a.name === "manager") return refusal("denied", "protected");
      if (a.name === "shell" && a.mode === "exit") return refusal("uncertain", "after /exit the lane neither closed nor came back to its shell in time");
      return { ok: true, result: { ok: true } };
    });
    expect((await lanes(["stop", "alpha"])).code).toBe(0);
    expect((await lanes(["stop", "alpha", "--kill"])).code).toBe(0);
    expect(fleet.calls.filter(c => c.op === "lane.stop").map(c => c.args)).toEqual([{ name: "alpha", mode: "exit" }, { name: "alpha", mode: "kill" }]);
    const late = await lanes(["stop", "shell"]);
    expect(late.code).toBe(3);
    expect(late.err).toContain("refused: uncertain (it may have happened)");
    expect((await lanes(["stop", "shell", "--kill"])).code).toBe(0);          // --kill after an exit that timed out
    const denied = await lanes(["stop", "manager"]);
    expect(denied.code).toBe(4);
    expect(denied.err).toContain("refused: denied");                          // the refusal's code, on stderr
  });

  it("status: a delivery's state; given up or unknown is 4", async () => {
    await lanes(["send", "manager", "x", "--id", "s1"]);
    expect(await lanes(["status", "lanes:s1"])).toMatchObject({ code: 0, out: "lanes:s1: queued\n" });
    fleet.moveDelivery("lanes:s1", { state: "given_up", why: "cancelled" });
    expect(await lanes(["status", "lanes:s1"])).toMatchObject({ code: 4, out: "lanes:s1: given_up (cancelled)\n" });
    expect((await lanes(["status", "lanes:nope"])).code).toBe(4);
  });

  it("events: lane events as they happen, until interrupted; 0", async () => {
    const e: LaneEvent = { v: 1, t: "lane", seq: 1, event: "finished", node: "pc", window: "alpha", lane: "alpha", at: Date.UTC(2026, 9, 8, 9), status: "done", firstLine: "STATUS: DONE shipped" };
    const r = await lanes(["events", "--json"], {
      during: async () => { await until(() => fleet.subscriberCount() > 0, 10_000); fleet.laneEvent(e); },
      interruptWhen: out => out.includes("\n"),
    });
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n").map(l => JSON.parse(l) as unknown)).toEqual([e]);
  });

  it("bad arguments are 2: an unknown command, an option a command doesn't take, a missing lane", async () => {
    expect((await lanes(["fly"])).code).toBe(2);
    expect((await lanes(["peek", "alpha", "--kill"])).code).toBe(2);
    expect((await lanes(["send"])).code).toBe(2);
    expect((await lanes(["--frobnicate"])).code).toBe(2);
  });

  it("needs no hub: it reads no hub settings and opens no hub database (negative control)", async () => {
    const r = await lanes([], { env: { MORNDO_ORIGIN: "http://not-https.example" } });   // a setting serve would refuse
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(home, ".local/share/morndo"))).toBe(false);
  });
});
```

- [ ] **Step 14.3: Run it and see it fail**

Run: `npx vitest run apps/hub/test/lanes-console.test.ts`
Expected: FAIL, 18 of 18. `morndo lanes` is no command yet, so `main.ts` prints its help: `AssertionError: expected 'morndo: your agents, on your phone.' to match /^NAME\s+NODE\s+WORKER\s+STATUS\s+PID\…/`, `SyntaxError: Unexpected token 'm', "morndo: yo"... is not valid JSON`, `AssertionError: expected 'morndo: your agents, on your phone.\n…' to be 'three\n❯ \n'`, `AssertionError: expected undefined to match object { lane: 'manager', …(3) }`, and so on.

- [ ] **Step 14.4: Implement `morndo lanes`**

Create `apps/hub/src/console/lanes.ts`:

```ts
// `morndo lanes` (fleet-clients spec §9.2): every node's lanes over the fleet's client socket, for any user, with no hub
// settings and no hub database. It names itself "lanes" (x-morndo-client), and its ids and keys are namespaced so
// ("lanes:…"): the fleet audits each by its client (§8, §11).
// - list: each lane's name, node, worker id, window, session status, pid, folder, title, and its session's topic and
//   last prompt (reconciliation ruling 13; each online node's inventory; a node that isn't online lists the registry's
//   rows, offline);
// - peek: the screen's last lines (pane.capture);
// - send: a delivery (§4), waited for with --wait; --direct types at once (pane.send), for a lane without Claude Code;
// - keys: pane.keys by key name (the protocol's allow-list);
// - start, stop: lane.start (with a first prompt typed once the lane can take it), lane.stop (graceful, or --kill; an
//   exit not seen within its 30 s is "uncertain", exit 3, and --kill may follow);
// - status: one delivery's state; events: lane events as they happen, until interrupted.
// Exit codes (§9.2; reconciliation rulings 29 and 49): 0 accepted (with --wait: delivered; stop: stopped), 3 not
// delivered in time (stop: not seen to stop in time), 4 given up, refused or uncertain, 5 in doubt (the fleet was reached
// and never answered: run it again with the same --id, which never queues it twice; never typed by hand), 69 the fleet
// couldn't be reached, so nothing was queued (EX_UNAVAILABLE, sysexits.h), 2 bad arguments. A refusal's code goes to
// stderr.
// util.parseArgs, strict, with positionals ("--" ends the options, so a text may start with "-"):
// https://nodejs.org/docs/latest-v24.x/api/util.html#utilparseargsconfig, read 2026-10-08.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { FleetClient, FleetMismatch, FleetOpFailed, FleetUnavailable } from "@morndo/fleet-client";
import { KEY_NAMES, LIMITS, parseWorkerId, type Delivery, type KeyName, type LaneEvent, type OpError } from "@morndo/protocol";

export const EXIT = { ok: 0, usage: 2, late: 3, notDelivered: 4, inDoubt: 5, unavailable: 69 } as const;

// Where the command reads and writes: the process's own (processIo), or a test's. Every write resolves once written,
// so the caller may exit then (writes to a pipe are asynchronous on POSIX:
// https://nodejs.org/docs/latest-v24.x/api/process.html#a-note-on-process-io, read 2026-10-08).
export type LanesIo = {
  env: NodeJS.ProcessEnv;
  out(text: string): Promise<void>;
  err(text: string): Promise<void>;
  stdin(): Promise<string>;
  interrupted(): Promise<void>;                     // SIGINT or SIGTERM: `events` ends
};

export function processIo(): LanesIo {
  const write = (s: NodeJS.WriteStream) => (text: string) => new Promise<void>(resolve => { s.write(text.endsWith("\n") ? text : `${text}\n`, () => resolve()); });
  return {
    env: process.env,
    out: write(process.stdout),
    err: write(process.stderr),
    async stdin() {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    interrupted: () => new Promise<void>(resolve => { process.once("SIGINT", () => resolve()); process.once("SIGTERM", () => resolve()); }),
  };
}

export const USAGE = `usage: morndo lanes [--json]
       morndo lanes peek <lane> [--lines N] [--json]
       morndo lanes send <lane> <text | -> [--id ID] [--wait SECONDS] [--direct] [--json]
       morndo lanes keys <lane> <key>...
       morndo lanes start <name> --cwd DIR [--node NODE] [--account A] [--resume SESSION] [--prompt TEXT] [--json]
       morndo lanes stop <lane> [--kill]
       morndo lanes status <delivery id> [--json]
       morndo lanes events [--json]
send - reads the text from stdin. Keys are tmux key names: ${KEY_NAMES.join(" ")}.
Exit codes: 0 accepted (with --wait: delivered; stop: stopped), 3 not delivered in time (stop: not seen to stop),
4 given up, refused or uncertain, 5 in doubt (the fleet was reached and never answered: run it again with the same
--id), 69 the fleet couldn't be reached (nothing queued), 2 bad arguments. The fleet's socket: MORNDO_FLEET_SOCKET
(default ~/.local/state/morndo-fleet/fleet.sock).`;

const OPTIONS = {
  json: { type: "boolean" }, lines: { type: "string" }, id: { type: "string" }, wait: { type: "string" }, direct: { type: "boolean" },
  kill: { type: "boolean" }, prompt: { type: "string" }, cwd: { type: "string" }, account: { type: "string" }, resume: { type: "string" },
  node: { type: "string" }, help: { type: "boolean", short: "h" },
} as const;
// The options each command takes; any other is a usage error.
const ALLOWED: Record<string, readonly string[]> = {
  list: ["json"], peek: ["lines", "json"], send: ["id", "wait", "direct", "json"], keys: [], status: ["json"], events: ["json"],
  start: ["cwd", "node", "account", "resume", "prompt", "json"], stop: ["kill"],
};
const DEFAULT_LINES = 40;
const WAIT_STEP_MS = 250;
const KEYS = new Set<string>(KEY_NAMES);

class Usage extends Error {}
class NotDone extends Error {}                         // a refusal, or a delivery given up or uncertain: exit 4
class InDoubt extends Error {}                         // the fleet was reached and never answered: exit 5 (ruling 49)

type Values = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string };
export type LaneRow = {
  name: string; node: string; workerId: string | null; window: string; status: string | null; pid: number | null;
  cwd: string | null; title: string | null; topic: string | null; lastPrompt: string | null; sessionId: string | null;
  online: boolean; conflict: boolean;
};

export async function runLanes(argv: string[], io: LanesIo): Promise<number> {
  let values: Values;
  let positionals: string[];
  try { ({ values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })); }
  catch (e) { await io.err(`${(e as Error).message}\n${USAGE}`); return EXIT.usage; }
  if (values.help) { await io.out(USAGE); return EXIT.ok; }
  const [first, ...rest] = positionals;
  const command = first ?? "list";
  const allowed = ALLOWED[command];
  if (!allowed) { await io.err(`no such lanes command: ${command}\n${USAGE}`); return EXIT.usage; }
  const wrong = Object.keys(values).filter(k => !allowed.includes(k));
  if (wrong.length) { await io.err(`${command} takes no ${wrong.map(k => `--${k}`).join(", ")}\n${USAGE}`); return EXIT.usage; }
  const socket = io.env.MORNDO_FLEET_SOCKET || join(io.env.HOME || homedir(), ".local/state/morndo-fleet/fleet.sock");
  const client = new FleetClient(socket, { client: "lanes" });
  try {
    switch (command) {
      case "list": return await list(client, io, rest, values);
      case "peek": return await peek(client, io, rest, values);
      case "send": return await send(client, io, rest, values);
      case "keys": return await keys(client, io, rest);
      case "start": return await start(client, io, rest, values);
      case "stop": return await stop(client, io, rest, values);
      case "status": return await status(client, io, rest, values);
      default: return await events(client, io, rest, values);
    }
  } catch (e) {
    if (e instanceof Usage) { await io.err(`${e.message}\n${USAGE}`); return EXIT.usage; }
    if (e instanceof NotDone) { await io.err(e.message); return EXIT.notDelivered; }
    if (e instanceof InDoubt) { await io.err(e.message); return EXIT.inDoubt; }
    if (e instanceof FleetOpFailed) { await io.err(refusedLine(e.error)); return EXIT.notDelivered; }
    // Reached, and no answer: in doubt (ruling 49). Not reached, or not the client API: nothing was asked of it.
    if (e instanceof FleetUnavailable && e.reached) { await io.err(`in doubt: the fleet at ${socket} took the request and never answered (${e.message}); run it again`); return EXIT.inDoubt; }
    if (e instanceof FleetUnavailable || e instanceof FleetMismatch) { await io.err(`the fleet couldn't be reached at ${socket}, so nothing was asked of it: ${e.message}`); return EXIT.unavailable; }
    throw e;
  }
}

const refusedLine = (e: OpError) => `refused: ${e.code}${e.executed === "maybe" ? " (it may have happened)" : ""}: ${e.message}`;
const none = (rest: string[], what: string) => { if (rest.length) throw new Usage(`${what} takes no ${rest.length === 1 ? "argument" : "arguments"} here: ${rest.join(" ")}`); };

// Every lane of every node: each online node's inventory, with the registry's conflict flag; a node that isn't online is
// listed from the registry's rows (its last-known lanes), offline.
async function lanesNow(client: FleetClient): Promise<LaneRow[]> {
  const [nodes, registry] = await Promise.all([client.nodes(), client.lanes()]);
  const conflict = new Set(registry.filter(l => l.conflict).map(l => l.name));
  const rows: LaneRow[] = [];
  for (const n of nodes) {
    const r = n.status === "online" ? await client.op({ node: n.name }, "inventory.get", {}, { timeoutMs: 3000 }) : null;
    if (!r?.ok) {
      for (const l of registry.filter(x => x.node === n.name)) {
        rows.push({ name: l.name, node: l.node, workerId: l.workerId, window: l.name, status: null, pid: null, cwd: null, title: null, topic: null, lastPrompt: null,
          sessionId: null, online: false, conflict: l.conflict });
      }
      continue;
    }
    for (const p of r.result.panes) {
      rows.push({
        name: p.window, node: n.name, workerId: p.workerId, window: p.window, status: p.status ?? null, pid: p.pid ?? null, cwd: p.cwd,
        title: p.sessionName ?? p.title ?? null, topic: p.topic ?? null, lastPrompt: p.lastPrompt ?? null, sessionId: p.sessionId ?? null,
        online: true, conflict: conflict.has(p.window),
      });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.node.localeCompare(b.node));
}

// One lane by name: exactly one online window of that name, else a refusal (no such lane, or two windows claim it).
async function laneNamed(client: FleetClient, name: string): Promise<LaneRow & { workerId: string }> {
  const named = (await lanesNow(client)).filter(l => l.name === name);
  const online = named.filter((l): l is LaneRow & { workerId: string } => l.online && l.workerId !== null);
  if (named.length > 1 || named.some(l => l.conflict)) throw new NotDone(`refused: lane_conflict: two windows are named "${name}"`);
  const lane = online[0];
  if (!lane) throw new NotDone(named.length ? `refused: node_offline: "${name}" is on a node that isn't online` : `refused: no_pane: no lane "${name}"`);
  return lane;
}

async function list(client: FleetClient, io: LanesIo, rest: string[], v: Values): Promise<number> {
  none(rest, "lanes");
  const rows = await lanesNow(client);
  if (v.json) { await io.out(JSON.stringify(rows)); return EXIT.ok; }
  const cells = [["NAME", "NODE", "WORKER", "STATUS", "PID", "FOLDER", "TITLE"],
    ...rows.map(r => [r.name, r.online ? r.node : `${r.node} (offline)`, r.workerId ?? "-", r.status ?? "-", r.pid === null ? "-" : String(r.pid), r.cwd ?? "-", r.topic ?? r.title ?? ""])];
  const widths = cells[0]?.map((_, i) => Math.max(...cells.map(c => (c[i] ?? "").length))) ?? [];
  await io.out(cells.map(c => c.map((x, i) => (i === c.length - 1 ? x : x.padEnd(widths[i] ?? 0))).join("  ").trimEnd()).join("\n"));
  return EXIT.ok;
}

async function peek(client: FleetClient, io: LanesIo, rest: string[], v: Values): Promise<number> {
  const [name, ...more] = rest;
  if (!name) throw new Usage("peek needs a lane");
  none(more, "peek");
  const lines = v.lines === undefined ? DEFAULT_LINES : Number(v.lines);
  if (!Number.isInteger(lines) || lines < 1 || lines > LIMITS.captureMaxLines) throw new Usage(`--lines is a whole number from 1 to ${LIMITS.captureMaxLines}`);
  const lane = await laneNamed(client, name);
  const r = await client.op({ workerId: lane.workerId }, "pane.capture", { workerId: lane.workerId, lines }, { timeoutMs: 5000 });
  if (!r.ok) throw new FleetOpFailed("pane.capture", r.error);
  if (r.result.text === null) throw new NotDone(`refused: no_pane: "${name}" has no pane any more`);
  await io.out(v.json ? JSON.stringify(r.result) : r.result.text);
  return EXIT.ok;
}

// A delivery's id: the one given (namespaced "lanes:" unless it names its client), or a new one.
function deliveryId(given: string | undefined): string {
  const id = given === undefined ? `lanes:${randomUUID()}` : /^[a-z]+:/.test(given) ? given : `lanes:${given}`;
  if (id.length > LIMITS.maxDeliveryId) throw new Usage(`--id is at most ${LIMITS.maxDeliveryId} characters, its client's name included`);
  return id;
}
const FINAL = new Set(["delivered", "uncertain", "given_up"]);
const describe = (d: Delivery) =>
  `${d.id}: ${d.state}${d.state === "queued" && d.waiting ? ` (waiting: ${d.waiting.reason})` : ""}${d.state === "given_up" && d.why ? ` (${d.why})` : ""}`;
const codeOf = (d: Delivery, waited: boolean) =>
  d.state === "given_up" || d.state === "uncertain" ? EXIT.notDelivered : d.state === "delivered" || !waited ? EXIT.ok : EXIT.late;

async function send(client: FleetClient, io: LanesIo, rest: string[], v: Values): Promise<number> {
  const [name, arg, ...more] = rest;
  if (!name || arg === undefined) throw new Usage("send needs a lane and a text (or - to read it from stdin)");
  none(more, "send");
  // From stdin, the one newline a shell's echo or a here-string ends it with is not part of the text.
  const text = arg === "-" ? (await io.stdin()).replace(/\r?\n$/, "") : arg;
  if (!text) throw new Usage("the text is empty");
  if (text.length > LIMITS.maxSendText) throw new Usage(`the text is over ${LIMITS.maxSendText} characters`);
  const id = deliveryId(v.id);
  if (v.direct) {
    if (v.wait !== undefined) throw new Usage("--wait waits for a delivery; --direct types at once");
    return direct(client, io, name, text, id, v);
  }
  const waitS = v.wait === undefined ? 0 : Number(v.wait);
  if (!Number.isFinite(waitS) || waitS < 0 || waitS > 86_400) throw new Usage("--wait is a number of seconds, at most a day");
  let d: Delivery;
  try {
    d = await client.deliver({ id, lane: name, text });
    const end = Date.now() + waitS * 1000;
    while (waitS > 0 && !FINAL.has(d.state) && Date.now() < end) {
      await new Promise(r => setTimeout(r, Math.min(WAIT_STEP_MS, Math.max(1, end - Date.now()))));
      d = (await client.delivery(id)) ?? d;
    }
  } catch (e) {
    // The fleet took it and never answered: it may be queued, under this id. The same id again is safe (§4.1: it is
    // never queued twice); typing it by hand is not (ruling 49).
    if (e instanceof FleetUnavailable && e.reached) throw new InDoubt(inDoubtLine(id, e));
    throw e;
  }
  await io.out(v.json ? JSON.stringify(d) : describe(d));
  return codeOf(d, waitS > 0);
}

const inDoubtLine = (id: string, e: Error) =>
  `in doubt: the fleet took ${id} and never answered (${e.message}); run it again with the same --id (--id ${id}): it is never sent twice`;

// Typed at once, without the queue (spec §9.2 --direct): pane.send under the id as its key, with the window's session.
// In doubt (no answer, or the node's "uncertain"), the same --id again answers its stored outcome and never types twice.
async function direct(client: FleetClient, io: LanesIo, name: string, text: string, id: string, v: Values): Promise<number> {
  const lane = await laneNamed(client, name);
  const server = parseWorkerId(lane.workerId)?.server ?? "";
  const expect = { server, window: lane.window, ...(lane.sessionId !== null ? { sessionId: lane.sessionId } : {}) };
  let r;
  try { r = await client.op({ workerId: lane.workerId }, "pane.send", { workerId: lane.workerId, text, expect }, { key: id, timeoutMs: 10_000 }); }
  catch (e) { if (e instanceof FleetUnavailable && e.reached) throw new InDoubt(inDoubtLine(id, e)); throw e; }
  if (!r.ok && r.error.code === "uncertain") throw new InDoubt(inDoubtLine(id, new Error(refusedLine(r.error))));
  if (!r.ok) throw new FleetOpFailed("pane.send", r.error);
  if (r.result.problem !== null) throw new NotDone(`not typed into ${name}: ${r.result.problem}${r.result.problem === "not_submitted" ? " (the text is in its input box)" : ""}`);
  await io.out(v.json ? JSON.stringify({ id, typedAt: r.result.typedAt }) : `${id}: typed into ${name}`);
  return EXIT.ok;
}

async function keys(client: FleetClient, io: LanesIo, rest: string[]): Promise<number> {
  const [name, ...names] = rest;
  if (!name || !names.length) throw new Usage("keys needs a lane and at least one key name");
  const bad = names.filter(k => !KEYS.has(k));
  if (bad.length) throw new Usage(`not a key name: ${bad.join(" ")}`);
  const lane = await laneNamed(client, name);
  const server = parseWorkerId(lane.workerId)?.server ?? "";
  const r = await client.op({ workerId: lane.workerId }, "pane.keys", { workerId: lane.workerId, names: names as KeyName[], expect: { server, window: lane.window } }, { timeoutMs: 5000 });
  if (!r.ok) throw new FleetOpFailed("pane.keys", r.error);
  if (!r.result.ok) throw new NotDone(`refused: the keys weren't sent to ${name}`);
  await io.out(`${names.join(" ")} sent to ${name}`);
  return EXIT.ok;
}

async function start(client: FleetClient, io: LanesIo, rest: string[], v: Values): Promise<number> {
  const [name, ...more] = rest;
  if (!name) throw new Usage("start needs the new lane's name");
  none(more, "start");
  if (!v.cwd) throw new Usage("start needs --cwd, the folder the lane works in");
  let node = v.node;
  if (node === undefined) {
    const online = (await client.nodes()).filter(n => n.status === "online");
    if (online.length !== 1) throw new Usage(`name the node with --node (${online.length ? `online: ${online.map(n => n.name).join(", ")}` : "none is online"})`);
    node = online[0]?.name ?? "";
  }
  const args = { name, cwd: v.cwd, ...(v.account !== undefined ? { account: v.account } : {}), ...(v.resume !== undefined ? { resume: v.resume } : {}),
    ...(v.prompt !== undefined ? { prompt: v.prompt } : {}) };
  let r;
  try { r = await client.op({ node }, "lane.start", args, { key: `lanes:start:${randomUUID()}`, timeoutMs: 60_000 }); }
  catch (e) {
    // No --id here: a start run again is a new start. So it says to look first.
    if (e instanceof FleetUnavailable && e.reached) throw new InDoubt(`in doubt: the fleet took the start of ${name} and never answered (${e.message}); it may have started: look with morndo lanes before starting it again`);
    throw e;
  }
  if (!r.ok) throw new FleetOpFailed("lane.start", r.error);
  if (v.json) { await io.out(JSON.stringify({ node, ...r.result })); return EXIT.ok; }
  const lines = [`started ${name} on ${node}: ${r.result.workerId}`];
  if (r.result.waiting === "trust") lines.push("it waits at Claude Code's folder-trust dialog: accept it with morndo lanes keys");
  if (r.result.prompt) lines.push(`its first prompt: ${r.result.prompt} (morndo lanes status ${r.result.prompt})`);
  await io.out(lines.join("\n"));
  return EXIT.ok;
}

async function stop(client: FleetClient, io: LanesIo, rest: string[], v: Values): Promise<number> {
  const [name, ...more] = rest;
  if (!name) throw new Usage("stop needs a lane");
  none(more, "stop");
  const mode = v.kill ? "kill" : "exit";
  const r = await client.op({ lane: name }, "lane.stop", { name, mode }, { key: `lanes:stop:${randomUUID()}`, timeoutMs: LIMITS.laneStopWaitMs + 15_000 });
  // Not seen to close or reach its shell within its 30 s: it may still be stopping. --kill may follow (a new key).
  if (!r.ok && r.error.code === "uncertain") {
    await io.err(`${refusedLine(r.error)}\n${name} may still be stopping; morndo lanes stop ${name} --kill closes its window`);
    return EXIT.late;
  }
  if (!r.ok) throw new FleetOpFailed("lane.stop", r.error);
  await io.out(`${mode === "kill" ? "killed" : "stopped"} ${name}`);
  return EXIT.ok;
}

async function status(client: FleetClient, io: LanesIo, rest: string[], v: Values): Promise<number> {
  const [id, ...more] = rest;
  if (!id) throw new Usage("status needs a delivery id");
  none(more, "status");
  const d = await client.delivery(id);
  if (!d) throw new NotDone(`no delivery ${id}`);
  await io.out(v.json ? JSON.stringify(d) : `${describe(d)}${d.stale ? " (its node isn't answering: as last heard)" : ""}`);
  return codeOf(d, false);
}

const eventLine = (e: LaneEvent) => [new Date(e.at).toISOString(), `${e.lane ?? e.window ?? "?"}@${e.node}`, e.event,
  ...(e.status ? [e.status] : []), ...(e.question ? [`"${e.question}"`] : []), ...(e.firstLine ? [e.firstLine] : []), ...(e.error ? [e.error] : [])].join(" ");

async function events(client: FleetClient, io: LanesIo, rest: string[], v: Values): Promise<number> {
  none(rest, "events");
  await client.caps();                                   // the fleet answers, or this is 69 at once
  const stop = client.events(e => {
    if (e.t !== "lane") return;
    const body = e.body as LaneEvent;
    void io.out(v.json ? JSON.stringify(body) : eventLine(body));
  });
  await io.interrupted();
  stop();
  return EXIT.ok;
}
```

In `main.ts` (the import next to `import { fileStore }`, which Task 12 leaves as it is, ruling 85), the command runs before `loadConfig()` and `openStore()`: it needs neither, runs on machines with no hub, and must not fail on a hub setting (`MORNDO_ORIGIN`) or create the hub's data directory. It writes every line before it exits (`processIo`; writes to a pipe are asynchronous on POSIX, https://nodejs.org/docs/latest-v24.x/api/process.html#a-note-on-process-io, read 2026-10-08).

In `apps/hub/src/main.ts` (1 of 3), replace:

```ts
import { fileStore } from "./adapters/files.ts";
import { uploadInbox } from "./adapters/uploads.ts";
```

with:

```ts
import { fileStore } from "./adapters/files.ts";
import { processIo, runLanes } from "./console/lanes.ts";
import { uploadInbox } from "./adapters/uploads.ts";
```

In `apps/hub/src/main.ts` (2 of 3), replace:

```ts
  morndo audit            the latest device and session events
  morndo agent-token new <name> --role manager|worker
```

with:

```ts
  morndo audit            the latest device and session events
  morndo lanes …          every node's lanes through the fleet: list, peek, send, keys, start, stop, status,
                          events (morndo lanes --help)
  morndo agent-token new <name> --role manager|worker
```

In `apps/hub/src/main.ts` (3 of 3), replace:

```ts
exitOnCrash(log);
const EXIT_CONFIG = 78;                                  // EX_CONFIG (sysexits.h): a setting or the data needs fixing, not a restart
```

with:

```ts
exitOnCrash(log);
// `morndo lanes` (fleet-clients §9.2) runs before the hub's settings and database are read: it needs neither, and runs
// on a machine with no hub. Every line it writes is out before the exit (console/lanes.ts processIo).
if (process.argv[2] === "lanes") process.exit(await runLanes(process.argv.slice(3), processIo()));
const EXIT_CONFIG = 78;                                  // EX_CONFIG (sysexits.h): a setting or the data needs fixing, not a restart
```

- [ ] **Step 14.5: Run it and see it pass, then the hub's suites, the types and the linter**

Run: `npx vitest run apps/hub/test/lanes-console.test.ts`
Expected: PASS, 18 tests (about 15 s: the in-doubt test waits out the client's 7 s answer deadline).

Run: `npx vitest run apps/hub/test/config-fleet.test.ts apps/hub/test/migrations.test.ts apps/hub/test/webpush.test.ts apps/hub/test/manager-queue-main.test.ts`
Expected: PASS: `serve`, `devices` and `audit` run as before.

Run: `npm run check`
Expected: exit 0 once Tasks 1 to 3 are in.

Run: `npm run lint`
Expected: no problems.

- [ ] **Step 14.6: Commit, then the negative controls**

```bash
git add apps/hub/src/console/lanes.ts apps/hub/src/main.ts apps/hub/test/helpers/fake-fleet.ts apps/hub/test/lanes-console.test.ts
```

```bash
git commit -m "feat(hub): morndo lanes, every node's lanes through the fleet"
```

Add to `scripts/negative-controls.ts`, at the end of `CONTROLS` (each seen to bite):

```ts
  // ---- fleet-clients Task 14: morndo lanes (plan/04-hub-web.md)
  { id: "fc14-unnamed-client", task: "fc14", file: "apps/hub/src/console/lanes.ts",
    find: "  const client = new FleetClient(socket, { client: \"lanes\" });", replace: "  const client = new FleetClient(socket);",
    run: ["apps/hub/test/lanes-console.test.ts"], expect: "expected Set{ 'hub' } to deeply equal Set{ 'lanes' }" },
  { id: "fc14-no-topic", task: "fc14", file: "apps/hub/src/console/lanes.ts",
    find: "topic: p.topic ?? null, lastPrompt: p.lastPrompt ?? null,", replace: "topic: null, lastPrompt: null,",
    run: ["apps/hub/test/lanes-console.test.ts"], expect: "ruling 13" },
  { id: "fc14-stop-late-as-refused", task: "fc14", file: "apps/hub/src/console/lanes.ts",
    find: "  if (!r.ok && r.error.code === \"uncertain\") {", replace: "  if (false) {",
    run: ["apps/hub/test/lanes-console.test.ts"], expect: "ruling 29" },
  { id: "fc14-in-doubt-as-unavailable", task: "fc14", file: "apps/hub/src/console/lanes.ts",
    find: "    if (e instanceof InDoubt) { await io.err(e.message); return EXIT.inDoubt; }", replace: "    if (e instanceof InDoubt) { await io.err(e.message); return EXIT.unavailable; }",
    run: ["apps/hub/test/lanes-console.test.ts"], expect: "ruling 49" },
  { id: "fc14-any-key-name", task: "fc14", file: "apps/hub/src/console/lanes.ts",
    find: "  if (bad.length) throw new Usage(`not a key name: ${bad.join(\" \")}`);\n", replace: "",
    run: ["apps/hub/test/lanes-console.test.ts"], expect: "allow-list" },
  { id: "fc14-stdin-newline-kept", task: "fc14", file: "apps/hub/src/console/lanes.ts",
    find: "  const text = arg === \"-\" ? (await io.stdin()).replace(/\\r?\\n$/, \"\") : arg;", replace: "  const text = arg === \"-\" ? await io.stdin() : arg;",
    run: ["apps/hub/test/lanes-console.test.ts"], expect: "stdin" },
  { id: "fc14-wait-never-late", task: "fc14", file: "apps/hub/src/console/lanes.ts",
    find: "  d.state === \"given_up\" || d.state === \"uncertain\" ? EXIT.notDelivered : d.state === \"delivered\" || !waited ? EXIT.ok : EXIT.late;",
    replace: "  d.state === \"given_up\" || d.state === \"uncertain\" ? EXIT.notDelivered : EXIT.ok;",
    run: ["apps/hub/test/lanes-console.test.ts"], expect: "--wait" },
```

Run: `node scripts/negative-controls.ts --only fc14-unnamed-client --only fc14-no-topic --only fc14-stop-late-as-refused --only fc14-in-doubt-as-unavailable --only fc14-any-key-name --only fc14-stdin-newline-kept --only fc14-wait-never-late`
Expected: `bit` for each. "needs no hub" is a control of its own (named so): `morndo lanes` reached after `openStore()` would create `~/.local/share/morndo` and fail it.

```bash
git add scripts/negative-controls.ts
```

```bash
git commit -m "test: negative controls for morndo lanes"
```

---

## Contract additions, as reconciled

This part's requests and how `plan/RECONCILIATION.md` settled each; this file follows the rulings.

1. **Negative-control ids** `fc<task>-<what>`, `task: "fc<task>"`: ruling 1. Controls run after their task's commit: ruling 50 (Steps 11.5, 12.57, 13.6, 14.6). The fleet core's `t5-answer-key-*`, which Step 12.39 would leave found twice, are updated there: ruling 51.
2. **The fleet's queue is the only queue** (ruling 81): Step 12.3 removes #29's inbox (its adapter, `MORNDO_MANAGER_INBOX`, the services' inbox branches, `withdrawOverdue`, the store's pending-answer helpers, the feed's `inbox`, `e2e/inbox.e2e.ts` and its CI step, fifteen tests), and Task 13 the outbox's inbox fields and labels; `fc12-inbox-switch-back`, `fc12-spool-writer-back` and `fc12-adr-0010-not-superseded` guard it; ADR-0010 gets a status line, superseded by ADR-0014 (Step 12.3). `pending_answers` stays, unused. `qa/`'s records of #29 stay as they are (ruling 91). #29's review cases B3, B5, B7, B8, B9 and B10, and its notices, are ported to the queue in Steps 12.37 and 12.42.
3. **The domain's E13**: #29's `Delivery`, `Decision.delivery?`, `Escalations.queue`, `delivered`, `withdraw`, `sameDecision` and `answered`, kept, with `uncertain` added (Step 12.8); E13, the paragraph under it, `Send state` and S5 in `docs/domain.md` say queue: rulings 26, 53, 81 and 87.
4. **An answer typed and never seen taken stays given** ("May have been delivered"); one never typed is "Not delivered" and its ask opens again; #29's "Answer again" for a typed answer goes: ruling 82; notices last as their rows, 7 days: ruling 90; a restored queued Decision with no row reads "May have been delivered", and none exists on the PC: ruling 89 (`fc12-uncertain-reopens`, `fc12-given-up-kept`, `fc12-given-up-no-notice`, `fc12-given-up-repeat-requeued`, `fc12-inbox-leftover-queued`).
5. **A message to a busy manager waits up to 24 hours**, with why it waits and a Cancel; #29's two-minute deadline and Retry go: ruling 83 (`fc12-message-two-minutes`, `fc12-no-cancel`, `fc13-queued-retried`, `fc13-cancel-once-typed`, `fc13-no-cancel-button`).
6. **The hub's migration is 16** (`manager_deliveries`): ruling 84.
7. **The feed's** `delivery` (with `uncertain`), `DecisionItem.waiting?` (in place of #29's `inbox`), `QueuedCommandSchema`, `QueuedCommand` and the `deliveries` frame; `CancelBody` and `POST /api/manager/cancel`, with no fresh passkey: rulings 26, 83 and 88.
8. **`Config.managerQueue?`**, the only switch: rulings 26 and 81.
9. **`hub:<key>~<n>`** for an answer sent again after its delivery was given up: ruling 26.
10. **`caps()` answers `{ api, stickyLanes }`**, an older fleet's `[]`: ruling 8.
11. **The delivery routes' answers** (refusals 200 `{ ok: false, error }`, an unknown id 404 `no_such_delivery`, the list's newest 1000 of 7 days); the fake fleet follows them: ruling 3. `cancelDelivery`'s `null` for an unknown id, the hub's `CancelAnswer` `unknown`: ruling 56.
12. **`morndo lanes`**: `start --node`, `send --direct --id`, options after the lane name, `--json`'s fields with `topic` and `lastPrompt`, `start --json` with `waiting: "trust"`, `stop`'s 0, 3 and 4, refusal codes on stderr: rulings 13 and 29; **5 in doubt** and 69 only when the fleet wasn't reached: ruling 49; the tests of an `uncertain` delivery (4) and `start --resume`: ruling 60. Its `main.ts` edit anchored on `import { fileStore }`: ruling 85.
13. **The wording "Not delivered"**, and Task 13's tables with `unavailable`'s words: rulings 15 and 26. Task 13's `WAITING` table is the one kira copies (ruling 55); it has every `WaitingReason` of the Contract, `unavailable` included, and `typed` and `held`.
14. **The FakeFleet's additions**: ruling 26; it changes `fleet-adapters.test.ts` and Task 3's `fleet-client.test.ts` in the same step: ruling 53.
15. **The answer withdrawn too late (ADR-0010 H1)** is recorded against the ask it answered, and its echo skipped: ruling 27 (Step 12.39, `fc12-echo-taken-as-tap`).
16. **`CommandSent` when the hub queues a message**: ruling 28 (Step 12.44, `fc12-commandsent-only-answered`).
17. **The start line `manager queue: on|off`**: ruling 39 (Step 12.54).
18. **In doubt is never typed by hand**, the hub's switch-off path included: ruling 49 (Steps 12.39 and 12.44); `fc12-uncertain-reopens`: ruling 61.
19. **Quoted as `main` and Tasks 1 to 3 leave it** (`new FleetClient(socket, { log })` in `main.ts`): rulings 52 and 85.
20. **The fleet drills' hub runs the queue as it ships**, `drills-retry` and `duplicate-names` with `managerQueue: false`: ruling 66 (Step 12.54).

## Open questions

1. **The phone's catch-up card** offers no "Check again" for an answer that is "uncertain" from the queue (none is possible: never typed again). It says "May have been delivered" only. Confirm with the owner's wording review.
