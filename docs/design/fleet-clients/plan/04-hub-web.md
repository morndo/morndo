## Lane notes (hub-web: Tasks 11 to 14)

**Reconciled** with `plan/RECONCILIATION.md`: rulings 1, 3, 8, 13, 15, 26, 27, 28, 29 and 39, and in the review round 49, 50, 51, 52, 53, 55, 56, 60, 61 and 66, change this part. Every step was run again after each round.

**How this part was checked** (the review round's run, 2026-10-08). Every code block below was taken from a scratch copy where each step was applied in order, its test run before its code ("see it fail") and after it ("see it pass"), and every negative control listed was applied and seen to bite. Node 26.3.1 on macOS (the repo's engines say `>=24.12`; CI runs 24); vitest 5.0.3; Playwright 1.63 with its Chromium for the web tests. The blocks in this file were generated from that copy's history, and every "replace … with …" block was checked to apply in order, its old text exactly once, giving the copy's file.

The copy's base is **Tasks 1 to 3 as part 01's own scratch tree has them** (its commit "rulings", taken read-only), with one stand-in on top: `cancelDelivery` answers `null` on a 404 (`no_such_delivery`), as the Contract says since ruling 56 and part 01 is changing. So every "replace" here quotes the text as Tasks 1 to 3 leave it (ruling 52: `new FleetClient(socket, { log })` in `main.ts`; Task 1's and Task 2's `status` and `pid` lines in `fake-fleet.ts`).

What that means for the executor:
- After Task 14, every suite passed: `npx vitest run` (the fleet drills in `test/fleet` included) gave 279 files and 2003 tests (2 skipped), all passing but `packages/node-ops/test/pane-lock.test.ts`'s two (macOS has no `flock(1)`; they pass on Linux, as before Task 4 of the fleet core).
- `npx tsc -p apps/hub`, `npx tsc -p tsconfig.tests.json`, `npx tsc -p tsconfig.web-tests.json`, `svelte-check` (686 files, 0 errors) and `npx oxlint` reported nothing.
- The run was repeated on a tree built only from this file's text: the same base, then every "Create" and "replace … with …" block of this file applied in order, and the negative-control entries added. It gave the same files, byte for byte; `node scripts/negative-controls.ts --check` found every entry's text exactly once (the fleet core's `t5-answer-key-*` included, which Step 12.34 updates, ruling 51), and the `--only` runs named in Steps 12.52, 13.6 and 14.6 bit.
- Not run here: `e2e/gallery.e2e.ts` (it needs the production build; Step 13.4 changes its count), `e2e/fleet-two-node.e2e.ts` (its hub, from the harness, now has the queue on; it answers no manager), and anything against a real fleet with deliveries (Tasks 4 to 9). `morndo lanes` and the hub's queue run here against the fake fleet; the real-fleet drills of spec §12 (`morndo lanes` against a real fleet, ruling 57) are Task 16's, on the same commands, as are the drills of the hub's queue against a real fleet (part 05, ruling 66).

**Decided here**, each since settled by a ruling:
- **An answer given up goes again under a new id** (ruling 26). A delivery id names one delivery for its 7 days (spec §4.1), so the same answer to the same ask after its delivery was given up (expired, or cancelled by the switch) can't reuse its key. Its next delivery is `hub:<key>~2`, then `~3`. Nothing under a given-up id was ever typed, so the direct path's key (`hub:<key>`) stays free on the node, and the switch still never types an answer twice (spec §9.1). Every first delivery is `hub:<key>` exactly.
- **"Uncertain" is not recorded.** E13 records a Decision once it reached the manager; one typed and never seen taken may not have. It stays given (never asked again), its card says "May have been delivered", and no `EscalationAnswered` is written.
- **A message given up reads "Not delivered"** (ruling 26), with why, and only Dismiss: its id is spent (§4.1), so the principal writes it again. While the switch is off, its repeat is typed directly (nothing of it was typed).
- **The answer's rules from ADR-0010 kept here:** queued counts as given (E8); recorded at its delivery's time (E13); given up opens the ask again; a queued answer whose ask was settled, expired or asked again is withdrawn (`delivery.cancel`, ADR-0010 B1 and H2); and, by ruling 27, an answer typed before its withdrawal could stop it is recorded against the ask it answered, and its echo (the first tap line equal to it from its queueing on) is never taken as a tap on the newer ask (ADR-0010 H1).
- **`CommandSent` when the hub queues a message** (ruling 28): at its first attempt the fleet didn't refuse, in doubt included, so a message found queued later is never left unaudited.
- **`morndo lanes` runs before the hub's settings and database** (main.ts, Step 14.4): it needs neither, runs on machines with no hub, and must not fail on a hub setting (`MORNDO_ORIGIN`) or create `~/.local/share/morndo`. It is still the console's `lanes` command.
- **The hub's start line** is `manager queue: on`, or `manager queue: off (MORNDO_MANAGER_QUEUE)`, once (ruling 39).
- **The fleet drills' hub follows what ships** (ruling 66; `test/fleet-harness.ts`, Step 12.49): the queue is on, unless a drill says `startHub(fleet, { managerQueue: false })`. `drills-retry` and `duplicate-names` say so: they drill the hub's keyed `pane.send` and its done keys, which the hub still uses with the switch off (step 2's rollback) and for every other lane.

---

### Task 11: Hub: answers to open asks restored whatever their age (issue #20)

**Files:**
- Modify: `apps/hub/src/adapters/store.ts` (`decisions()`)
- Create: `apps/hub/test/escalation-restore-age.test.ts`
- Modify: `scripts/negative-controls.ts` (two entries)

**Interfaces:**
- Consumes: `Store.saveDecision(id, decision)`, `Store.decisions()` (store.ts); `EscalationService`'s constructor, which restores `store.decisions()` (escalation-service.ts:109); `Escalations.restore()` (packages/domain), which applies a restored Decision only to its own ask, sighted again and not asked again since; `menuEscalationId(workerId)` (packages/protocol, `menu-…`).
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
Expected: FAIL, 1 of 3: "a list item answered 8 days ago and still open is still answered after a restart; a second answer is refused" with `AssertionError: expected { id: 'ny-21', asker: { …(3) }, …(27) } to match object { status: 'answered', …(1) }` (received `"decision": null, "status": "open"`). The two menu tests pass: the window is there today.

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
Expected: PASS, every test (on Tasks 1–3 plus this task, at 12c2811 on 2026-10-09: 103 files, 752 tests; Task 3 moved 26 tests into `packages/fleet-client`).

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

### Task 12: Hub: the manager's answers and commands through the queue

**Files:**
- Modify: `packages/domain/src/escalation.ts` (`DecisionDelivery`, `Decision.delivery`; `Escalations.queue`, `delivered`, `uncertain`, `withdraw`; `sameDecision`, `answered`) and `docs/domain.md` (E13, ruling 26)
- Modify: `packages/protocol/src/feed.ts` (a Decision's `delivery` and `waiting`; `QueuedCommandSchema`; the `deliveries` frame) and `apps/web/src/lib/feed.svelte.ts` (the frame kept, so the app's switch stays exhaustive)
- Modify: `apps/hub/src/adapters/migrations.ts` (migration 13) and `apps/hub/src/adapters/store.ts` (`manager_deliveries` rows; `replaceDecisionIf`, `dropDecisionIf`)
- Modify: `apps/hub/src/config.ts` (`managerQueue`)
- Modify: `apps/hub/test/helpers/fake-fleet.ts` (deliveries as ruling 3 answers them, sticky names, `pane.capture`, keys by name, each session's topic and last prompt, lane events), and the two tests its session default changes (ruling 53): `apps/hub/test/fleet-adapters.test.ts`, `packages/fleet-client/test/fleet-client.test.ts`
- Modify: `apps/hub/src/application/ports.ts` (`Deliveries`, `DeliverAnswer`)
- Create: `apps/hub/src/adapters/fleet-deliveries.ts`
- Create: `apps/hub/src/application/manager-queue.ts`
- Modify: `apps/hub/src/application/escalation-service.ts`, `apps/hub/src/application/steering-service.ts`
- Modify: `apps/hub/src/adapters/http.ts` (the `deliveries` frame; a duplicate's `delivery`), `apps/hub/src/main.ts` (wiring), `apps/hub/test/inprocess-hub.ts` (`queue`)
- Modify: `test/fleet-harness.ts` (`startHub`'s `managerQueue: false`; the queue stays on by default, as it ships, ruling 66), `test/fleet/drills-retry.test.ts` and `test/fleet/duplicate-names.test.ts` (they turn it off: they drill the direct path)
- Modify: `apps/hub/test/migrations.test.ts` (migration 12's test runs to 12 only)
- Create (tests): `packages/domain/test/escalation-delivery.test.ts`, `packages/protocol/test/feed-deliveries.test.ts`, `apps/hub/test/manager-deliveries-store.test.ts`, `apps/hub/test/config-manager-queue.test.ts`, `apps/hub/test/fleet-deliveries.test.ts`, `apps/hub/test/manager-queue.test.ts`, `apps/hub/test/escalation-queue.test.ts`, `apps/hub/test/steering-queue.test.ts`, `apps/hub/test/http-manager-queue.test.ts`, `apps/hub/test/manager-queue-main.test.ts`
- Modify: `scripts/negative-controls.ts` (the fleet core's `t5-answer-key-random` and `t5-answer-key-without-ask`, which Step 12.34 would leave found twice, ruling 51; this task's entries)

**Interfaces:**
- Consumes (plan.md Contracts):
  - **Task 1 (`@morndo/protocol`):** `Delivery`, `DeliveryState`, `WaitingReason` (with `unavailable`, ruling 15), `GiveUpReason`, `ErrorCode` with `id_conflict`, `no_session`, `already_typed`, `ERROR_EXECUTED`, `LIMITS.maxDeliveryId`, `LIMITS.deliveryTtlMs`, `LIMITS.maxSendText`, `LaneEvent`, `SessionStatus`, `Pane.status`, `Pane.pid`, `Pane.topic`, `Pane.lastPrompt` (ruling 13).
  - **Task 2 (`@morndo/node-ops`):** `SessionInfo.status` (fake-fleet.ts only).
  - **Task 3 (`@morndo/fleet-client`):** `FleetClient.deliver`, `delivery`, `cancelDelivery` (`Delivery | null`: `null` for an id the fleet doesn't know, ruling 56), `events` (`t: "delivery"`, body `Delivery & { stale }`), `caps()` with `stickyLanes`; `FleetOpFailed`, `FleetUnavailable` (`reached`: whether the request left this process, ruling 49), `FleetMismatch`.
  - **Client API routes** (ruling 3): `POST /v1/deliveries` and `POST /v1/deliveries/<id>/cancel` (a refusal is 200 `{ ok: false, error }`), `GET /v1/deliveries/<id>` (an unknown id is 404 `{ error: "no_such_delivery" }`), `GET /v1/deliveries?lane=&state=` (the newest 1000 of the last 7 days), `GET /v1/caps` (`{ api, stickyLanes }`, ruling 8).
  - **Config:** `MORNDO_MANAGER_QUEUE` ("off" or "0" turn it off; on by default when `MORNDO_FLEET_SOCKET` is set).
  - **Databases:** hub `morndo.db` migration 13, `manager_deliveries` with exactly the Contract's columns, `NORMAL` like the hub's other tables.
  - The hub's own: `answerKey`, `askPrefix` (escalation-service.ts), the send key `${endpoint}:${request}` (steering-service.ts), `hubKey` (`hub:<key>`, fleet-adapters.ts), `Store.send`, `managerOf`.
- Produces:
  ```ts
  // packages/domain/src/escalation.ts
  export type DecisionDelivery = { state: "queued" | "delivered" | "uncertain"; at: number | null };
  Decision.delivery?: DecisionDelivery | undefined;
  Escalations.queue(id, decided: DecidedChoice, by: { endpointId; sessionId }, now): Result<Decision, AnswerRefusal>;
  Escalations.delivered(id, expected: Decision, at: number): EscalationAnswered | null;
  Escalations.uncertain(id, expected: Decision): boolean;
  Escalations.withdraw(id, expected: Decision): boolean;
  export function sameDecision(a: Decision | null | undefined, b: Decision): boolean;
  export function answered(id: EscalationId, d: Decision): EscalationAnswered;
  // packages/protocol/src/feed.ts
  DecisionItem = Escalation & { answerable; version; waiting?: string };          // decision.delivery as above
  export const QueuedCommandSchema; export type QueuedCommand = { requestId: string; state: "queued" | "delivered" | "uncertain" | "given_up"; waiting: string | null; why: string | null };
  ServerFeedFrames.deliveries: { t: "deliveries"; items: QueuedCommand[] }
  // apps/hub/src/adapters/store.ts (migration 13)
  export type ManagerDeliveryState = "sending" | DeliveryState;
  export type ManagerDeliveryRow = { deliveryId; kind: "answer" | "command"; escalationId; ask; choice; endpointId; sessionId; requestId; queuedAt; state: ManagerDeliveryState; updatedAt };
  Store.saveManagerDelivery(row), managerDelivery(id), managerDeliveryOfRequest(endpointId, requestId), answerDelivery(escalationId, queuedAt),
    managerDeliveryAttempts(base), managerDeliveriesWithPrefix(prefix), openManagerDeliveries(), commandDeliveriesOf(endpointId, since),
    setManagerDeliveryState(id, state, at), dropManagerDelivery(id), pruneManagerDeliveries(before), replaceDecisionIf(id, at, decision), dropDecisionIf(id, at);
  // apps/hub/src/config.ts
  Config.managerQueue?: boolean;
  // apps/hub/src/application/ports.ts
  export type DeliverAnswer = { ok: true; delivery: Delivery } | { ok: false; refused: ErrorCode } | { ok: false; inDoubt: true };
  export type CancelAnswer = DeliverAnswer | { ok: false; unknown: true };   // unknown: cancelDelivery's null (ruling 56)
  export type Deliveries = { deliver(d: { id; lane; text }): Promise<DeliverAnswer>; cancel(id): Promise<CancelAnswer>;
    get(id): Promise<Delivery | null | "unavailable">; subscribe(on, onOpen): () => void; stickyLanes(): Promise<string[] | null> };
  // apps/hub/src/adapters/fleet-deliveries.ts
  export function fleetDeliveries(client: FleetClient): Deliveries;  export const isDelivery;
  // apps/hub/src/application/manager-queue.ts
  export class ManagerQueue { constructor(p: { store; deliveries: Deliveries; lane: string; on: boolean; now?; pollMs? });
    readonly lane; readonly on; subscribe(fn: (c: QueueChange) => void); idFor(key): string; put(d: NewDelivery, text): Promise<PutResult>;
    view(id): QueueView | null; row(id); byRequest(endpointId, requestId); answerRow(escalationId, queuedAt); sendingOf(prefix); openAnswers(); answersTo(escalationId);
    commandsOf(endpointId): QueuedCommand[]; forget(id); cancel(id): Promise<void>; poll(): Promise<void>; start(): Promise<void>; stop() }
  export type QueueView = { state: DeliveryState; reason: WaitingReason | null; why: GiveUpReason | null; at: number | null };
  export type QueueChange; export type NewDelivery; export type PutResult; export function viewOf(d); export function queuedCommand(row, view): QueuedCommand;
  // apps/hub/src/application/escalation-service.ts
  constructor's p gains queue?: ManagerQueue | null;  EscalationView gains waiting?: string
  // apps/hub/src/application/steering-service.ts
  constructor(store, tmux, now, policy, inbox, waitingOn, nameOf, uploads, status, manager: { queue: ManagerQueue; isManager(workerId): boolean } | null = null)
  SendResult's ok and "duplicate" gain delivery?: QueuedCommand
  // apps/hub/src/adapters/http.ts
  startHttp's p gains queue?: ManagerQueue | null
  // apps/hub/test/helpers/fake-fleet.ts
  startFakeFleet's o gains stickyLanes?: string[] (default ["manager"]);  FakeFleet gains deliveries, deliveryCalls, cancels, moveDelivery,
    quietDeliveries, loseDeliveryAnswers, laneEvent;  MemoryPane gains status?, pid?, topic?, lastPrompt?;  MemoryBackend gains keyNamesTyped;  NodeBackend gains keyNames?, topicOf?
  // apps/hub/test/inprocess-hub.ts
  startInProcessHub's o gains queue?: (store: Store) => ManagerQueue
  ```

**Behaviour, in one place:**
- **When.** With a fleet and `MORNDO_MANAGER_QUEUE` not "off" or "0", an answer whose asker is the manager, and a message to the manager's pane (`managerOf`, as today), go through the fleet's delivery queue to the lane named `MORNDO_MANAGER_WINDOW`. Messages to other lanes stay typed directly (`pane.send`). Without a fleet nothing changes (legacy mode).
- **Ids.** An answer's delivery id is `hub:` and its answer key, `hub:answer:<escalation>:<ask>:<choice>`; a message's is `hub:<endpoint>:<request>`. These are the keys the fleet adapters type under today (`hubKey`), so a direct send after the switch finds the delivery's key on the node: `done` is a duplicate, `started` is in doubt, and nothing is typed twice (spec §9.1). Only after a given-up delivery does an answer go again under `~2`, `~3` (Decided here).
- **The row first.** Each delivery's `manager_deliveries` row is written ("sending") before the fleet is asked, so a hub that stops then still follows it. The fleet's answer gives it its state.
  - Refused (executed "no", or the fleet never reached: `node_offline`, spec §10): nothing was queued, and a row this call wrote goes.
  - No answer (the fleet took it and never answered): the row stays "sending", unless the fleet's own `delivery` event said meanwhile that it is queued. The answer or message is "uncertain" (409), and its repeat asks again under the same id, which the fleet answers with its state and never queues twice (spec §4.1). Another answer to the same ask is refused `answer_in_doubt` meanwhile (E8).
- **Following.** The queue hears the fleet's `delivery` events, and asks about every delivery not final every 5 s and on each events reconnect (an event sent while the hub wasn't subscribed is not replayed). A word older than one applied never moves a delivery back.
  - Each change of state, or of the reason it waits, is heard once by its listeners, in one transaction with the row's new state: a change acted on (an answer recorded, an ask opened again) is acted on once across restarts.
  - A listener that throws rolls the row back, and the next round hears it again.
- **An answer's states** (ADR-0010's domain rules, E13):
  - queued, typed or held: the Decision counts as given (E8: a second answer is refused), its card says "Queued, it will be delivered" with why it waits (`waiting`: the queue's reason, or "typed", "held"), and nothing is recorded;
  - delivered: `EscalationAnswered` is recorded once, at the delivery's `deliveredAt` (the manager's machine's clock), with the row's own provenance (A1) and, for words, their length and digest (E9). An answer whose ask was asked again since is still recorded (the manager has it), and the newer ask is left alone;
  - uncertain: the card says "May have been delivered"; it stays given and is never opened again; it is not recorded (Decided here);
  - given up: nothing reached the manager, so the ask opens again; the same answer may be given again (under `~2`).
  - A queued answer whose ask was settled, expired or asked again meanwhile is withdrawn (`delivery.cancel`, once); one typed already is followed to its end.
  - One typed for an ask asked again since answers the ask it was given for, and is recorded against it, never the new one (ruling 27, ADR-0010 H1). Its echo in the manager's conversation (the first principal message equal to its tap line, from its queueing on, less 5 s for the clocks) is never read as a tap on the newer ask; a later tap with the same line is a new answer. An answer in words has no tap line, so no echo to skip.
- **A message's states** reach the app as the send's answer (`{ ok: true, at, delivery }`; a repeat's 200 `duplicate` carries `delivery` too) and then as `deliveries` feed frames: every one of this device's messages to the manager of the last day after each hello, then each change; never another device's. The `at` is when it was queued, or typed, or delivered, on the manager's machine's clock, which the echo is matched on. `CommandSent` is recorded when the hub queues it (ruling 28): once, at its first attempt the fleet didn't refuse, in doubt included; the delivery's outcome is its row's and the fleet's audit (§8).
- **Restarts.** The queue follows every row not final at start. The answers' Decisions come back from `decisions` (Task 11's restore) with their delivery state, and a delivery that moved meanwhile moves them then (a Decision restored and not sighted yet included).
- **In doubt is never typed by hand** (ruling 49). A delivery whose answer never came keeps its row "sending" and is asked again only under its own id. While the switch is off, its repeat is "uncertain" (an answer's or a message's), and another answer to the same ask is refused `answer_in_doubt` (E8): the hub never types one directly while it may be queued.
- **The switch off** (step 2's rollback, spec §13): at start, every delivery still queued (its row "queued" or "sending") is cancelled first, before any answer is taken; one refused `already_typed` is followed to its end, as is everything else not final. A row still "sending" whose delivery the fleet doesn't know (its cancel answers `null`, the route's 404 `no_such_delivery`: rulings 3 and 56) was never queued, and goes. New answers and messages are typed directly. A message given up while the switch is off is typed directly on its repeat.
- **A manager mid-restart** is no refusal: its sticky name waits on its node (spec §4.6). The answer goes to the lane by name even while the hub sees no manager pane.
- **Review Focus 5:** when the queue is on and `GET /v1/caps`'s `stickyLanes` doesn't name the manager's window, the hub says so once in its log at start, and still delivers. A fleet that can't be asked then says nothing; an older fleet without `stickyLanes` reads as `[]` (ruling 8), so the hub says it too.
- **The start line** (ruling 39): `manager queue: on`, or `manager queue: off (MORNDO_MANAGER_QUEUE)`, once, after the queue has started (and, off, cancelled what was still queued).
- Final rows are pruned after 7 days (as the node keeps its final deliveries, spec §4.3), at each start.

- [ ] **Step 12.1: Write the failing domain test (E13)**

Create `packages/domain/test/escalation-delivery.test.ts`:

```ts
// E13 (fleet-clients §9.1; ADR-0010's domain rules): a Decision for the manager handed to the fleet's delivery queue
// counts as given while queued (E8), is recorded once delivered, at the time it reached the manager; "uncertain" keeps
// it given and is never asked again; given up, the ask is open again. Only the Decision that was queued moves: a newer
// one, or an ask asked again since, is left alone. Synthetic asks.
import { describe, expect, it } from "vitest";
import { Escalations, answered, endpointId, escalationId, sameDecision, sessionId, type Ask, type Decision } from "../src/index.ts";

const T0 = Date.UTC(2026, 9, 8, 9);
const BY = { endpointId: endpointId("ep1"), sessionId: sessionId("s1") };
const SHIP = { kind: "option" as const, key: "ship", label: "Ship it" };
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
  const q = x.queue("ny-7", SHIP, BY, T0);
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
    const q = x.queue("ny-7", { kind: "option", key: "hold", label: "Hold" }, BY, T0 + 1000);
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
    expect(sameDecision({ ...d, choice: { label: "Ship it", key: "ship", kind: "option" } }, d)).toBe(true);   // field order
    expect(sameDecision({ ...d, at: T0 + 1 }, d)).toBe(false);
    expect(sameDecision({ ...d, choice: { kind: "words" } }, d)).toBe(false);
    expect(sameDecision(null, d)).toBe(false);
    expect(answered(escalationId("ny-7"), { ...d, delivery: { state: "delivered", at: T0 + 9 } }).at).toBe(T0 + 9);
    expect(answered(escalationId("ny-7"), { ...d, delivery: undefined }).at).toBe(T0);
  });
});
```

- [ ] **Step 12.2: Run it and see it fail**

Run: `npx vitest run packages/domain/test/escalation-delivery.test.ts`
Expected: FAIL, 9 of 9: `TypeError: x.queue is not a function` (six), `TypeError: x.delivered is not a function`, `TypeError: x.withdraw is not a function`, `TypeError: sameDecision is not a function`.

- [ ] **Step 12.3: Implement a Decision's delivery in the domain**

In `packages/domain/src/escalation.ts` (1 of 3), replace:

```ts

export type Decision = {
```

with:

```ts

// Where a Decision for the manager stands in the fleet's delivery queue (E13; fleet-clients §9.1, ADR-0010's rules):
// "queued" until the manager's conversation has it (it counts as given meanwhile, E8), then "delivered" and recorded,
// `at` being when it reached the manager (on the manager's machine's clock). "uncertain": typed and never seen taken, so
// it may have reached the manager: it stays given and is never asked again, and is not recorded. A Decision the queue
// gives up is withdrawn (`withdraw`), never kept. Absent: it reached the asker when it was taken (typed directly, or
// seen at the asker's end).
export type DecisionDelivery = { state: "queued" | "delivered" | "uncertain"; at: number | null };

export type Decision = {
```

In `packages/domain/src/escalation.ts` (2 of 3), replace:

```ts
  sessionId: SessionId | null;
};
```

with:

```ts
  sessionId: SessionId | null;
  delivery?: DecisionDelivery | undefined;
};
```

In `packages/domain/src/escalation.ts` (3 of 3), replace:

```ts
  }
}
```

with:

```ts
  }

  // E13: a Decision handed to the manager's delivery queue. It counts as given at once (E8: a second answer is refused),
  // and is recorded, as EscalationAnswered, only once it reached the manager (`delivered`). Judged as recordTyped is: its
  // choice was checked when it was given (check), so only E8, E10 and E11 are checked now (refusal).
  queue(id: string, decided: DecidedChoice, by: { endpointId: EndpointId; sessionId: SessionId }, now: number): Result<Decision, AnswerRefusal> {
    const e = this.#items.get(id as EscalationId);
    const r = refusal(e, now);
    if (r || !e) return err(r ?? "unknown");
    e.decision = { choice: decided, at: now, via: "here", endpointId: by.endpointId, sessionId: by.sessionId, delivery: { state: "queued", at: null } };
    e.status = "answered";
    e.askedAgain = false;
    return ok(e.decision);
  }

  // The queue has it in the manager's conversation: the queued Decision `expected` is delivered, and its record returned.
  // Null when this ask holds that queued Decision no more (asked again, given up, or delivered already): the caller
  // records the delivery from its own copy, and a newer Decision is left alone. Works on a Decision restored after a
  // restart whose ask isn't sighted yet.
  delivered(id: string, expected: Decision, at: number): EscalationAnswered | null {
    const d = this.#held(id, expected);
    if (!d) return null;
    d.delivery = { state: "delivered", at };
    return answered(id as EscalationId, d);
  }

  // Typed, and never seen taken: it may have reached the manager, so it stays given, is never asked again, and is not
  // recorded. False when this ask holds that queued Decision no more.
  uncertain(id: string, expected: Decision): boolean {
    const d = this.#held(id, expected);
    if (!d) return false;
    d.delivery = { state: "uncertain", at: null };
    return true;
  }

  // The queue gave it up (expired, cancelled, gone, refused): nothing reached the manager, so the ask is open again.
  // Only that Decision: a newer one, or an ask asked again since, is left alone.
  withdraw(id: string, expected: Decision): boolean {
    if (!this.#held(id, expected)) return false;
    const e = this.#items.get(id as EscalationId);
    if (!e) return this.#restored.delete(id as EscalationId);
    e.decision = null;
    if (e.status === "answered") e.status = "open";
    return true;
  }

  // The queued Decision `expected` where this ask holds it: on its Escalation, or restored and not sighted yet.
  #held(id: string, expected: Decision): Decision | null {
    const e = this.#items.get(id as EscalationId);
    const d = e ? e.decision : this.#restored.get(id as EscalationId) ?? null;
    return d && d.delivery?.state === "queued" && sameDecision(d, expected) ? d : null;
  }
}

const sameChoice = (a: DecidedChoice, b: DecidedChoice) =>
  a.kind === "words" ? b.kind === "words" : b.kind === "option" && a.key === b.key && a.label === b.label;

// The same Decision: taken at the same moment, by the same endpoint and session, with the same choice. Its delivery
// state doesn't count: that is where the same Decision stands.
export function sameDecision(a: Decision | null | undefined, b: Decision): boolean {
  return !!a && a.at === b.at && a.endpointId === b.endpointId && a.sessionId === b.sessionId && sameChoice(a.choice, b.choice);
}

// The record of a Decision taken here (A1: who answered, from where), at the time it reached the asker: its delivery's
// for one that went through the queue, else when it was taken.
export function answered(id: EscalationId, d: Decision): EscalationAnswered {
  return { type: "EscalationAnswered", escalationId: id, choice: d.choice, endpointId: d.endpointId as EndpointId, sessionId: d.sessionId as SessionId, at: d.delivery?.at ?? d.at };
}
```

E13 goes into `docs/domain.md` with its code (reconciliation ruling 26; PR #10 never merged it):

In `docs/domain.md`, replace:

```md
| E12 | An answer that names the version of the Ask it was given for (when and in which message it was asked, its wording, options and terms) is refused as changed if the Ask was restated since: it never answers a question the principal didn't see. (ADR-0009: the phone holds an answer 5 seconds.) | F2, F4 |

A Decision is a Command under Access (AC7). It is recorded only after the asker has it (delivered into its pane), with the endpoint, session and time as provenance (A1).

```

with:

```md
| E12 | An answer that names the version of the Ask it was given for (when and in which message it was asked, its wording, options and terms) is refused as changed if the Ask was restated since: it never answers a question the principal didn't see. (ADR-0009: the phone holds an answer 5 seconds.) | F2, F4 |
| E13 | With a fleet, a Decision for the manager goes through the fleet's delivery queue (fleet-clients §9.1; ADR-0010's rules, ADR-0014). Queued until the manager's conversation has it, then Delivered, and recorded then, at the time it reached the manager. Queued, it counts as given (E8). Given up (expired, cancelled, gone, refused), nothing reached the manager: the Escalation is open again and nothing is recorded. Typed and never seen taken ("may have been delivered"), it stays given and is never asked again, and is not recorded. Queued for an Ask that was settled, expired or asked again meanwhile, it is withdrawn; one typed anyway answers the Ask it was given for, and its echo in the conversation is never taken as an answer to the newer Ask. | F1, F2 |

A Decision is a Command under Access (AC7). It is recorded only after the asker has it (delivered into its pane; for the manager with a fleet, Delivered by the queue, E13), with the endpoint, session and time as provenance (A1).

```

- [ ] **Step 12.4: Run it and see it pass, with the domain**

Run: `npx vitest run packages/domain`
Expected: PASS, 17 files, 150 tests.

Run: `npx tsc -p packages/domain`
Expected: no output, exit 0.

- [ ] **Step 12.5: Commit**

```bash
git add packages/domain/src/escalation.ts packages/domain/test/escalation-delivery.test.ts docs/domain.md
```

```bash
git commit -m "feat(domain): a Decision for the manager queued, delivered, uncertain or withdrawn (E13)"
```

- [ ] **Step 12.6: Write the failing feed test**

Create `packages/protocol/test/feed-deliveries.test.ts`:

```ts
// The feed's words for the manager's delivery queue (fleet-clients §9.1, Task 13): a Decision's delivery state and why it
// waits, and the `deliveries` frame (this device's messages to the manager, by request id). A hub from before says
// neither, and an app reads that as before; a state this app doesn't know reads as queued, never as delivered (ADR-0010).
// Synthetic frames only.
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
  it("carries its state and why it waits", () => {
    const d = first(board([item({ waiting: "menu_open" })]));
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

- [ ] **Step 12.7: Run it and see it fail**

Run: `npx vitest run packages/protocol/test/feed-deliveries.test.ts`
Expected: FAIL, 4 of 5: `AssertionError: expected undefined to deeply equal { state: 'queued', at: null }`, `AssertionError: expected undefined to deeply equal { state: 'queued', at: 1791450000000 }`, and twice `AssertionError: expected { kind: 'unknown', t: 'deliveries' } to deeply equal { kind: 'ok', frame: { …(2) } }`. "a hub from before says neither" passes.

- [ ] **Step 12.8: Implement the feed's delivery words, and keep the app's frame switch exhaustive**

In `packages/protocol/src/feed.ts` (1 of 4), replace:

```ts
    sessionId: z.nullable(z.pipe(text(), z.transform(s => s as SessionId))),
  })),
```

with:

```ts
    sessionId: z.nullable(z.pipe(text(), z.transform(s => s as SessionId))),
    // A Decision for the manager in the fleet's delivery queue (E13, fleet-clients §9.1): queued (it counts as given),
    // delivered (recorded then, `at` when it reached the manager), or uncertain (it may have). A state this app doesn't
    // know reads as queued: it never claims a delivery it can't vouch for (ADR-0010).
    delivery: z.optional(z.object({ state: orElse(z.enum(["queued", "delivered", "uncertain"]), "queued"), at: z.nullable(z.number()) })),
  })),
```

In `packages/protocol/src/feed.ts` (2 of 4), replace:

```ts
  version: orElse(text(), ""),                                 // askVersion; a hub that doesn't say: "" (never matches)
});
export const LedgerStateSchema = z.object({ configured: z.boolean(), ok: z.boolean(), at: z.nullable(z.number()) });
```

with:

```ts
  version: orElse(text(), ""),                                 // askVersion; a hub that doesn't say: "" (never matches)
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

In `packages/protocol/src/feed.ts` (3 of 4), replace:

```ts
  fleet: z.object({ t: z.literal("fleet"), available: z.boolean() }),
};
```

with:

```ts
  fleet: z.object({ t: z.literal("fleet"), available: z.boolean() }),
  // Fleet-clients §9.1: where this device's messages to the manager stand in the fleet's delivery queue, every one of the
  // last day after each hello, then each change. An app from before ignores it, as any frame type it doesn't know.
  deliveries: z.object({ t: z.literal("deliveries"), items: each(QueuedCommandSchema, "delivery") }),
};
```

In `packages/protocol/src/feed.ts` (4 of 4), replace:

```ts
export type ClientFeedFrame = { [K in keyof typeof ClientFeedFrames]: z.output<(typeof ClientFeedFrames)[K]> }[keyof typeof ClientFeedFrames];
export type DecisionItem = Escalation & { answerable: AnswerRefusal | null; version: string };
export type LedgerState = z.output<typeof LedgerStateSchema>;
```

with:

```ts
export type ClientFeedFrame = { [K in keyof typeof ClientFeedFrames]: z.output<(typeof ClientFeedFrames)[K]> }[keyof typeof ClientFeedFrames];
export type DecisionItem = Escalation & { answerable: AnswerRefusal | null; version: string; waiting?: string };
export type LedgerState = z.output<typeof LedgerStateSchema>;
```

The app decodes every frame and its switch over `ServerFeedFrame` ends in `unreachable`: without its case, a `deliveries` frame throws there (seen: `TypeError: Unhandled case: {"t":"deliveries",…}`) and `svelte-check` fails. Task 13 makes the outbox use it.

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

- [ ] **Step 12.9: Run it and see it pass**

Run: `npx vitest run packages/protocol apps/web/test/feed-frames.test.ts`
Expected: PASS for `feed-deliveries.test.ts` (5 tests) and every protocol and feed-frame suite.

Run: `npm run check -w @morndo/web`
Expected: no error in `feed.svelte.ts`.

- [ ] **Step 12.10: Commit**

```bash
git add packages/protocol/src/feed.ts packages/protocol/test/feed-deliveries.test.ts apps/web/src/lib/feed.svelte.ts
```

```bash
git commit -m "feat(protocol): the feed carries a Decision's delivery, why it waits, and the deliveries frame"
```

- [ ] **Step 12.11: Write the failing store test (migration 13)**

Create `apps/hub/test/manager-deliveries-store.test.ts`:

```ts
// Migration 13 (fleet-clients §9.1, plan.md Databases): manager_deliveries, one row per delivery of an answer or a
// message to the manager, so a hub restart keeps following it; never the text. And the decisions row of a queued answer,
// changed or dropped only while it is still the Decision that was queued (a newer answer's row is left alone). Real
// SQLite files in a temp dir.
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

describe("migration 13", () => {
  it("gives a database at 12 manager_deliveries, keeps its rows, and changes nothing run again", () => {
    const db = new Database(join(dir, "other.db"));
    migrate(db, MIGRATIONS.slice(0, 12));
    db.prepare("INSERT INTO decisions (escalation_id, at, body) VALUES ('ny-7', 5, '{}')").run();
    expect(migrate(db, MIGRATIONS.slice(0, 13))).toEqual({ from: 12, to: 13 });
    const cols = (db.prepare("PRAGMA table_info(manager_deliveries)").all() as { name: string }[]).map(c => c.name);
    expect(cols).toEqual(["delivery_id", "kind", "escalation_id", "ask", "choice", "endpoint_id", "session_id", "request_id", "queued_at", "state", "updated_at"]);
    expect(db.prepare("SELECT escalation_id FROM decisions").all()).toEqual([{ escalation_id: "ny-7" }]);
    expect(() => MIGRATIONS[12]?.up(db)).not.toThrow();
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

- [ ] **Step 12.12: Run it and see it fail**

Run: `npx vitest run apps/hub/test/manager-deliveries-store.test.ts`
Expected: FAIL, 6 of 6: `AssertionError: expected { from: 12, to: 12 } to deeply equal { from: 12, to: 13 }`; `AssertionError: expected [Function] to throw error matching /CHECK/ but got 'store.saveManagerDelivery is not a fu…'`; `TypeError: store.saveManagerDelivery is not a function` (three); `TypeError: store.replaceDecisionIf is not a function`.

- [ ] **Step 12.13: Implement migration 13 and the store's rows**

In `apps/hub/src/adapters/migrations.ts`, replace:

```ts
  },
];
```

with:

```ts
  },
  {
    version: 13,
    name: "manager_deliveries: the manager's answers and messages in the fleet's delivery queue, followed across hub restarts (fleet-clients §9.1)",
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

// One delivery of an answer or a message to the manager through the fleet's queue (fleet-clients §9.1; migration 13).
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

  // A queued answer's decisions row, changed or dropped only while it is still the Decision taken at `at` (its time on
  // the hub's clock): a newer answer's row, after the ask was asked again or answered anew, is left alone.
  replaceDecisionIf(id: string, at: number, decision: unknown) {
    this.db.prepare("UPDATE decisions SET body = ? WHERE escalation_id = ? AND json_extract(body, '$.at') = ?").run(JSON.stringify(decision), id, at);
  }
  dropDecisionIf(id: string, at: number) {
    this.db.prepare("DELETE FROM decisions WHERE escalation_id = ? AND json_extract(body, '$.at') = ?").run(id, at);
  }

  // The manager's deliveries (fleet-clients §9.1, migration 13), written before the fleet is asked, so a hub that stops
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

Migration 12's test migrated "to the latest", which is now 13: it runs to 12 only.

In `apps/hub/test/migrations.test.ts`, replace:

```ts
    db.prepare("INSERT INTO sends (key, state, at, node_store, worker_id, request) VALUES ('answer:ny-7:m1:option:ship', 'started', 5, 'store-a', 'pc.aaaaaaaa.0', 'ep1:r1')").run();
    expect(migrate(db)).toEqual({ from: 11, to: 12 });
    expect(columns(db, "sends")).toContain("node_store_seq");
```

with:

```ts
    db.prepare("INSERT INTO sends (key, state, at, node_store, worker_id, request) VALUES ('answer:ny-7:m1:option:ship', 'started', 5, 'store-a', 'pc.aaaaaaaa.0', 'ep1:r1')").run();
    expect(migrate(db, MIGRATIONS.slice(0, 12))).toEqual({ from: 11, to: 12 });
    expect(columns(db, "sends")).toContain("node_store_seq");
```

- [ ] **Step 12.14: Run it and see it pass**

Run: `npx vitest run apps/hub/test/manager-deliveries-store.test.ts apps/hub/test/migrations.test.ts apps/hub/test/escalation-restore-age.test.ts`
Expected: PASS, 3 files, 19 tests.

- [ ] **Step 12.15: Commit**

```bash
git add apps/hub/src/adapters/migrations.ts apps/hub/src/adapters/store.ts apps/hub/test/migrations.test.ts apps/hub/test/manager-deliveries-store.test.ts
```

```bash
git commit -m "feat(hub): migration 13, the manager's deliveries followed across restarts"
```

- [ ] **Step 12.16: Write the failing config test**

Create `apps/hub/test/config-manager-queue.test.ts`:

```ts
// MORNDO_MANAGER_QUEUE (fleet-clients §9.1, plan.md Config): with a fleet, the manager's answers and messages go through
// the fleet's delivery queue unless it says "off" or "0"; without a fleet there is no queue, whatever it says.
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
  it("without a fleet there is no queue, whatever it says (negative control)", () => {
    expect(loadConfig({}).managerQueue).toBe(false);
    expect(loadConfig({ MORNDO_MANAGER_QUEUE: "on" }).managerQueue).toBe(false);
  });
});
```

- [ ] **Step 12.17: Run it and see it fail**

Run: `npx vitest run apps/hub/test/config-manager-queue.test.ts`
Expected: FAIL, 3 of 3: `AssertionError: expected undefined to be true`, `AssertionError: off: expected undefined to be false`, and the same for "without a fleet".

- [ ] **Step 12.18: Implement `MORNDO_MANAGER_QUEUE`**

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

- [ ] **Step 12.19: Run it and see it pass**

Run: `npx vitest run apps/hub/test/config-manager-queue.test.ts apps/hub/test/config-fleet.test.ts`
Expected: PASS, 2 files, 7 tests.

- [ ] **Step 12.20: Commit**

```bash
git add apps/hub/src/config.ts apps/hub/test/config-manager-queue.test.ts
```

```bash
git commit -m "feat(hub): MORNDO_MANAGER_QUEUE, on by default with a fleet"
```

- [ ] **Step 12.21: Give the fake fleet deliveries**

This is test infrastructure: Steps 12.22 to 12.51 and Task 14 use it. It keeps each delivery and never types it; a test moves one on as a node's deliverer would (`moveDelivery`), and every subscriber hears each change as a `delivery` event. It also answers `pane.capture` and `pane.keys` by name, reports each pane's session `status`, `pid`, `topic` and `lastPrompt`, keeps lane events, and lists `stickyLanes` in `GET /v1/caps`. Its delivery routes answer as ruling 3 says: a refusal is 200 `{ ok: false, error }` (executed "no"); `GET /v1/deliveries/<id>` and a cancel of an id it doesn't know are 404 `{ error: "no_such_delivery" }` (part 03: "a cancel of an id the fleet doesn't know is 404"); the list is the newest 1000 of the last 7 days.

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

- [ ] **Step 12.22: Write the failing test of the hub's port onto the queue**

Create `apps/hub/test/fleet-deliveries.test.ts`:

```ts
// The hub's port onto the fleet's delivery queue (fleet-clients §4, §8, §9.1), over the fake fleet on a real Unix socket:
// a delivery queued, the same id again (its state now, nothing queued twice), the fleet's refusals (nothing queued),
// a fleet that can't be reached (node_offline: nothing queued, §10) and one that took it and never answered (in doubt),
// a delivery read back, cancelled, followed by its events, and the fleet's sticky names. Synthetic panes only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Delivery } from "@morndo/protocol";
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

- [ ] **Step 12.23: Run it and see it fail**

Run: `npx vitest run apps/hub/test/fleet-deliveries.test.ts`
Expected: FAIL. The suite errors with `Error: Cannot find module '../src/adapters/fleet-deliveries.ts' imported from …/apps/hub/test/fleet-deliveries.test.ts`, and no tests run.

- [ ] **Step 12.24: Implement the port and its fleet adapter**

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
  deliver(d: { id: string; lane: string; text: string }): Promise<DeliverAnswer>;
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
      try { return answered(await client.deliver({ id: d.id, lane: d.lane, text: d.text })); }
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

- [ ] **Step 12.25: Run it and see it pass**

Run: `npx vitest run apps/hub/test/fleet-deliveries.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 12.26: Commit**

```bash
git add apps/hub/src/application/ports.ts apps/hub/src/adapters/fleet-deliveries.ts apps/hub/test/fleet-deliveries.test.ts
```

```bash
git commit -m "feat(hub): a port onto the fleet's delivery queue"
```

- [ ] **Step 12.27: Write the failing test of the manager's queue**

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

- [ ] **Step 12.28: Run it and see it fail**

Run: `npx vitest run apps/hub/test/manager-queue.test.ts`
Expected: FAIL. The suite errors with `Error: Cannot find module '../src/application/manager-queue.ts' imported from …/apps/hub/test/manager-queue.test.ts`, and no tests run.

- [ ] **Step 12.29: Implement the manager's queue**

Create `apps/hub/src/application/manager-queue.ts`:

```ts
// The manager's answers and messages through the fleet's delivery queue (fleet-clients spec §9.1; ADR-0014; ADR-0010's
// domain rules). Each goes to the manager's lane by name (a sticky name: it waits on its node through a manager restart,
// spec §4.6), under the key the hub would type it under (`hub:<key>`), so the switch never types one twice. Each has a
// row (manager_deliveries, migration 13), written before the fleet is asked, so a hub restart keeps following it; and
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
  // heard as usual, and view() has the latest).
  async put(d: NewDelivery, text: string): Promise<PutResult> {
    const known = this.#store.managerDelivery(d.deliveryId);
    if (!known) this.#store.saveManagerDelivery({ ...d, state: "sending", updatedAt: this.#now() });
    const r = await this.#deliveries.deliver({ id: d.deliveryId, lane: this.lane, text });
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
  async cancel(id: string): Promise<void> {
    const r = await this.#deliveries.cancel(id);
    if (r.ok) { this.#safeApply(r.delivery); return; }
    if ("unknown" in r) {
      if (this.#store.managerDelivery(id)?.state === "sending") this.#store.dropManagerDelivery(id);
      else log.warn(`${id}: the fleet knows no such delivery; it is followed until its row is pruned`);
      return;
    }
    if ("inDoubt" in r) { log.warn(`${id}: cancelling it went unanswered; it is followed, and the next start tries again`); return; }
    if (r.refused === "already_typed") { log.info(`${id} was typed already: it is followed to its end`); return; }
    if (this.#store.managerDelivery(id)?.state === "sending" && r.refused !== "node_offline" && r.refused !== "timeout") {
      this.#store.dropManagerDelivery(id);
      return;
    }
    log.warn(`${id}: cancelling it was refused (${r.refused}); it is followed, and may still be delivered`);
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

- [ ] **Step 12.30: Run it and see it pass**

Run: `npx vitest run apps/hub/test/manager-queue.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 12.31: Commit, then the negative controls**

```bash
git add apps/hub/src/application/manager-queue.ts apps/hub/test/manager-queue.test.ts
```

```bash
git commit -m "feat(hub): the manager's deliveries, followed to their end across restarts"
```

The controls of Steps 12.1 to 12.31 are in Step 12.52 (one entry each; every one was seen to bite).

- [ ] **Step 12.32: Write the failing test: the manager's answers through the queue**

Create `apps/hub/test/escalation-queue.test.ts`:

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
```

- [ ] **Step 12.33: Run it and see it fail**

Run: `npx vitest run apps/hub/test/escalation-queue.test.ts`
Expected: FAIL, 12 of 14 (the service takes no `queue` yet, so every answer is typed directly):
- `AssertionError: expected { ok: true, …(1) } to match object { ok: true, item: { …(2) } }` (no delivery state);
- `Error: no delivery hub:answer:ny-7:m1:option:ship` (five: nothing was queued);
- `AssertionError: expected undefined to be 'About ny-7: Ship it after the smoke t…'`;
- `AssertionError: expected { ok: true, …(1) } to match object { ok: false, …(2) }` (the answer in doubt);
- `AssertionError: expected { ok: false, problem: 'no_pane', …(1) } to match object { ok: true }` (the manager mid-restart);
- `AssertionError: expected { ok: true, …(1) } to match object { ok: false, problem: 'uncertain' }` (an answer in doubt typed directly once off);
- `Error: not within 5000 ms` (two: nothing to withdraw or cancel).

The other two "switch off" tests pass: off is today's behaviour.

- [ ] **Step 12.34: Implement the answers through the queue**

In `apps/hub/src/application/escalation-service.ts` (1 of 17), replace:

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

In `apps/hub/src/application/escalation-service.ts` (2 of 17), replace:

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

In `apps/hub/src/application/escalation-service.ts` (3 of 17), replace:

```ts
import { keepInDoubt, settleOutcome, type SendResult } from "./steering-service.ts";
import { log } from "../adapters/log.ts";
```

with:

```ts
import { keepInDoubt, settleOutcome, type SendResult } from "./steering-service.ts";
import type { ManagerQueue, QueueView } from "./manager-queue.ts";
import { log } from "../adapters/log.ts";
```

In `apps/hub/src/application/escalation-service.ts` (4 of 17), replace:

```ts

export type EscalationView = Escalation & { answerable: AnswerRefusal | null; version: string };
type ButtonMessage = { message: Message; body: string; options: ButtonOption[] };
```

with:

```ts

// `waiting`: while a Decision for the manager waits in the fleet's queue, why (a WaitingReason, or "typed", "held").
export type EscalationView = Escalation & { answerable: AnswerRefusal | null; version: string; waiting?: string };
type ButtonMessage = { message: Message; body: string; options: ButtonOption[] };
```

In `apps/hub/src/application/escalation-service.ts` (5 of 17), replace:

```ts
const REQUEST_TTL_MS = 10 * 60_000;
const SETTLED_LEDGER_MS = 3 * 24 * 3_600_000;        // closed list items shown under "Decided" for three days
```

with:

```ts
const REQUEST_TTL_MS = 10 * 60_000;
const ECHO_SLACK_MS = 5000;                           // an echo is no older than its answer's queueing, less this (clocks)
const SETTLED_LEDGER_MS = 3 * 24 * 3_600_000;        // closed list items shown under "Decided" for three days
```

In `apps/hub/src/application/escalation-service.ts` (6 of 17), replace:

```ts
const digest = (words: string) => createHash("sha256").update(words.trim()).digest("hex").slice(0, 16);
// The key an answer carries to the asker's node (fleet core §3.1): one choice for one ask is one key, so a repeat after a
```

with:

```ts
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

In `apps/hub/src/application/escalation-service.ts` (7 of 17), replace:

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

In `apps/hub/src/application/escalation-service.ts` (8 of 17), replace:

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

In `apps/hub/src/application/escalation-service.ts` (9 of 17), replace:

```ts
    return {
      items: this.#x.list().map(e => ({ ...e, answerable: refusal(e, now), version: this.#version(e) })),
      ledger: { configured: this.#ledger !== null, ok: l?.ok ?? false, at: l?.at ?? null },
```

with:

```ts
    return {
      items: this.#x.list().map(e => ({ ...e, answerable: refusal(e, now), version: this.#version(e), ...this.#waiting(e) })),
      ledger: { configured: this.#ledger !== null, ok: l?.ok ?? false, at: l?.at ?? null },
```

In `apps/hub/src/application/escalation-service.ts` (10 of 17), replace:

```ts
    const e = this.#x.get(id);
    return e ? { ...e, answerable: refusal(e, this.#now()), version: this.#version(e) } : null;
  }
```

with:

```ts
    const e = this.#x.get(id);
    return e ? { ...e, answerable: refusal(e, this.#now()), version: this.#version(e), ...this.#waiting(e) } : null;
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

In `apps/hub/src/application/escalation-service.ts` (11 of 17), replace:

```ts
    for (const id of this.#buttons.keys()) if (!this.#x.get(id)) this.#buttons.delete(id);   // kept as long as its ask
    if (changed) this.#notify();
  }
```

with:

```ts
    for (const id of this.#buttons.keys()) if (!this.#x.get(id)) this.#buttons.delete(id);   // kept as long as its ask
    this.#withdrawStale();
    if (changed) this.#notify();
  }

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
```

In `apps/hub/src/application/escalation-service.ts` (12 of 17), replace:

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

In `apps/hub/src/application/escalation-service.ts` (13 of 17), replace:

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

In `apps/hub/src/application/escalation-service.ts` (14 of 17), replace:

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

In `apps/hub/src/application/escalation-service.ts` (15 of 17), replace:

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

In `apps/hub/src/application/escalation-service.ts` (16 of 17), replace:

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

In `apps/hub/src/application/escalation-service.ts` (17 of 17), replace:

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
    const q = this.#x.queue(id, expected.choice, { endpointId: endpointId(r.row.endpointId), sessionId: sessionId(r.row.sessionId) }, expected.at);
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

The fleet core's two `t5-answer-key-*` controls find `answerKey(e.id, e, choice)`, which the queued answer above has too: found twice, `--check` (which CI runs) would call them stale (ruling 51). Each now finds the direct answer's own line, which the queue's (indented four spaces less) doesn't contain:

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

- [ ] **Step 12.35: Run it and see it pass, with the escalation suites**

Run: `npx vitest run apps/hub/test/escalation-queue.test.ts`
Expected: PASS, 14 tests.

Run: `npx vitest run apps/hub/test/escalation-service.test.ts apps/hub/test/escalation-in-doubt.test.ts apps/hub/test/escalation-answer-keys.test.ts apps/hub/test/escalation-window.test.ts apps/hub/test/escalation-menu-ids.test.ts apps/hub/test/fleet-conflicts.test.ts`
Expected: PASS, every test (without a queue nothing changes).

- [ ] **Step 12.36: Commit**

Run: `node scripts/negative-controls.ts --check`
Expected: `ok` for `t5-answer-key-random` and `t5-answer-key-without-ask` (`found 1 time in apps/hub/src/application/escalation-service.ts`).

```bash
git add apps/hub/src/application/escalation-service.ts apps/hub/test/escalation-queue.test.ts scripts/negative-controls.ts
```

```bash
git commit -m "feat(hub): the manager's answers through the fleet's queue: queued counts as given, recorded once delivered"
```

- [ ] **Step 12.37: Write the failing test: the manager's messages through the queue**

Create `apps/hub/test/steering-queue.test.ts`:

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
```

- [ ] **Step 12.38: Run it and see it fail**

Run: `npx vitest run apps/hub/test/steering-queue.test.ts`
Expected: FAIL, 5 of 8: `AssertionError: expected { ok: true, at: … } to deeply equal { ok: true, at: Any<Number>, …(1) }`, `Error: no delivery hub:ep1:r1` (two), and twice `AssertionError: expected { ok: true, at: … } to deeply equal { ok: false, problem: 'uncertain' }` (the message in doubt, and the one in doubt once off). Messages to other lanes, a refusal and the switch off pass already.

- [ ] **Step 12.39: Implement the messages through the queue**

In `apps/hub/src/application/steering-service.ts` (1 of 7), replace:

```ts
import type { SendProblem } from "@morndo/node-ops";
import { LIMITS } from "@morndo/protocol";
import { ownerFileNote } from "../adapters/attachment-note.ts";
```

with:

```ts
import type { SendProblem } from "@morndo/node-ops";
import { LIMITS, type QueuedCommand } from "@morndo/protocol";
import { ownerFileNote } from "../adapters/attachment-note.ts";
```

In `apps/hub/src/application/steering-service.ts` (2 of 7), replace:

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
```

In `apps/hub/src/application/steering-service.ts` (3 of 7), replace:

```ts
  #status: SendStatus | null;                                // the fleet's op.status; null: the legacy hub, nobody else knows

```

with:

```ts
  #status: SendStatus | null;                                // the fleet's op.status; null: the legacy hub, nobody else knows
  // The manager's queue (fleet-clients §9.1) and which worker is the manager; null without a fleet.
  #manager: { queue: ManagerQueue; isManager: (workerId: string) => boolean } | null;

```

In `apps/hub/src/application/steering-service.ts` (4 of 7), replace:

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

In `apps/hub/src/application/steering-service.ts` (5 of 7), replace:

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

In `apps/hub/src/application/steering-service.ts` (6 of 7), replace:

```ts

    if (!this.#store.startSend(key, now)) return { ok: false, problem: "uncertain" };
```

with:

```ts

    if (this.#manager?.queue.on && this.#manager.isManager(workerId)) return this.#queueCommand(a, key, workerId, body, uploads.length, now);
    if (!this.#store.startSend(key, now)) return { ok: false, problem: "uncertain" };
```

In `apps/hub/src/application/steering-service.ts` (7 of 7), replace:

```ts
    return this.#type(key, workerId, body, audit);
  }
```

with:

```ts
    return this.#type(key, workerId, body, audit);
  }

  // A message to the manager through the fleet's queue (fleet-clients §9.1), under the key a direct send types it under
  // (`hub:<endpoint>:<request>`), so the switch never types it twice. CommandSent is recorded when the hub queues it (its
  // provenance, ADR-0006; reconciliation ruling 28): once, at its first attempt the fleet didn't refuse, whether or not
  // its answer came back. The delivery's outcome is its own (its row, the fleet's audit, §8).
  async #queueCommand(a: Authenticated, key: string, workerId: string, body: string, attachments: number, now: number): Promise<SendResult> {
    const queue = (this.#manager as { queue: ManagerQueue }).queue;
    const requestId = key.slice(a.endpoint.id.length + 1);
    const first = queue.row(`hub:${key}`) === null;
    const r = await queue.put({
      deliveryId: `hub:${key}`, kind: "command", escalationId: null, ask: null, choice: null,
      endpointId: a.endpoint.id, sessionId: a.session.id, requestId, queuedAt: now,
    }, body);
    if (first && (r.ok || r.problem === "uncertain")) this.#store.record([this.#commandSent(a, workerId, body, attachments, now)]);
    if (!r.ok) {
      log.warn(`send to ${workerId} not queued for the manager: ${r.problem}`);   // never the text
      return { ok: false, problem: r.problem === "timeout" ? "busy" : r.problem };
    }
    log.info(`send to ${workerId} queued for the manager`);
    return { ok: true, at: r.view.at ?? r.delivery.queuedAt, delivery: queuedCommand(r.row, r.view) };
  }
```

- [ ] **Step 12.40: Run it and see it pass, with the steering suites**

Run: `npx vitest run apps/hub/test/steering-queue.test.ts apps/hub/test/steering.test.ts apps/hub/test/steering-durable.test.ts apps/hub/test/steering-keys.test.ts apps/hub/test/fleet-steering.test.ts`
Expected: PASS, every test.

- [ ] **Step 12.41: Commit**

```bash
git add apps/hub/src/application/steering-service.ts apps/hub/test/steering-queue.test.ts
```

```bash
git commit -m "feat(hub): the principal's messages to the manager through the fleet's queue"
```

- [ ] **Step 12.42: Write the failing feed test**

Create `apps/hub/test/http-manager-queue.test.ts`:

```ts
// The feed tells each device where its messages to the manager stand in the fleet's delivery queue (fleet-clients §9.1;
// the app's words are Task 13's): every one of the last day after a hello, then each change, by request id; never
// another device's. A real hub HTTP server in this process, its queue over the fake fleet on a real Unix socket.
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
```

- [ ] **Step 12.43: Run it and see it fail**

Run: `npx vitest run apps/hub/test/http-manager-queue.test.ts`
Expected: FAIL, 2 of 2: `TypeError: Cannot read properties of null (reading 'start')` (the in-process hub doesn't make the queue yet).

- [ ] **Step 12.44: Implement the feed's deliveries and a duplicate's delivery**

In `apps/hub/src/adapters/http.ts` (1 of 6), replace:

```ts
import type { NotificationService } from "../application/notification-service.ts";
import { bridgeDesktop } from "./rfb.ts";
```

with:

```ts
import type { NotificationService } from "../application/notification-service.ts";
import type { ManagerQueue } from "../application/manager-queue.ts";
import { queuedCommand } from "../application/manager-queue.ts";
import { bridgeDesktop } from "./rfb.ts";
```

In `apps/hub/src/adapters/http.ts` (2 of 6), replace:

```ts
  push?: { publicKey: Buffer; notifications: NotificationService } | null;   // web push (phase F); null: off
}) {
```

with:

```ts
  push?: { publicKey: Buffer; notifications: NotificationService } | null;   // web push (phase F); null: off
  queue?: ManagerQueue | null;      // the manager's delivery queue (fleet-clients §9.1); null without a fleet
}) {
```

In `apps/hub/src/adapters/http.ts` (3 of 6), replace:

```ts
      if (r.ok) return json(res, 200, r);
      if (r.problem === "duplicate") return json(res, 200, { error: "duplicate", ok: true, at: r.at });
      return json(res, r.problem === "step_up" ? 403 : r.problem === "no_pane" ? 404 : 409, { error: r.problem });
```

with:

```ts
      if (r.ok) return json(res, 200, r);
      if (r.problem === "duplicate") return json(res, 200, { error: "duplicate", ok: true, at: r.at, ...(r.delivery ? { delivery: r.delivery } : {}) });
      return json(res, r.problem === "step_up" ? 403 : r.problem === "no_pane" ? 404 : 409, { error: r.problem });
```

In `apps/hub/src/adapters/http.ts` (4 of 6), replace:

```ts
      const unsubscribeBoard = escalations.subscribe(board => send({ t: "decisions", ...board }));
      // Older pages, one at a time per connection (fleet core §3.1): each waits for the one before it.
```

with:

```ts
      const unsubscribeBoard = escalations.subscribe(board => send({ t: "decisions", ...board }));
      // Where this device's messages to the manager stand in the fleet's queue (fleet-clients §9.1): each change, by
      // request id; never another device's.
      const unsubscribeQueue = p.queue?.subscribe(c => {
        if (c.row.kind === "command" && c.row.endpointId === conn.auth.endpoint.id) send({ t: "deliveries", items: [queuedCommand(c.row, c.view)] });
      }) ?? (() => false);
      // Older pages, one at a time per connection (fleet core §3.1): each waits for the one before it.
```

In `apps/hub/src/adapters/http.ts` (5 of 6), replace:

```ts
      ws.on("pong", () => { conn.alive = true; });
      ws.on("close", () => { conns.delete(conn); unsubscribe(); unsubscribeBoard(); unsubscribeReading(); p.push?.notifications.left(conn.id); });
      // Every frame is decoded (ADR-0008, A2): malformed closes with 1003, a type this hub doesn't know is ignored.
```

with:

```ts
      ws.on("pong", () => { conn.alive = true; });
      ws.on("close", () => { conns.delete(conn); unsubscribe(); unsubscribeBoard(); unsubscribeQueue(); unsubscribeReading(); p.push?.notifications.left(conn.id); });
      // Every frame is decoded (ADR-0008, A2): malformed closes with 1003, a type this hub doesn't know is ignored.
```

In `apps/hub/src/adapters/http.ts` (6 of 6), replace:

```ts
            send({ t: "decisions", ...escalations.board() });
            if (p.reading) send(p.reading.state());           // all marks and mutes: they may have moved while away
```

with:

```ts
            send({ t: "decisions", ...escalations.board() });
            if (p.queue) send({ t: "deliveries", items: p.queue.commandsOf(conn.auth.endpoint.id) });   // all of the last day
            if (p.reading) send(p.reading.state());           // all marks and mutes: they may have moved while away
```

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
// `observation`: the service the feed reads from, when a test needs its own (default: one over an empty tmux).
export async function startInProcessHub(o: { limits?: Limits; heartbeatMs?: number; now?: () => number; observation?: ObservationService } = {}): Promise<InProcessHub> {
  const dir = mkdtempSync(join(tmpdir(), "morndo-inproc-"));
```

with:

```ts
// `observation`: the service the feed reads from, when a test needs its own (default: one over an empty tmux).
// `queue`: the manager's delivery queue, made on the hub's own store (fleet-clients §9.1; default none).
export async function startInProcessHub(o: { limits?: Limits; heartbeatMs?: number; now?: () => number; observation?: ObservationService; queue?: (store: Store) => ManagerQueue } = {}): Promise<InProcessHub> {
  const dir = mkdtempSync(join(tmpdir(), "morndo-inproc-"));
```

In `apps/hub/test/inprocess-hub.ts` (3 of 3), replace:

```ts
    steering: new SteeringService(store, tmux, o.now ?? Date.now, () => access.policy(), inbox), escalations, remote, inbox, reading: new ReadingService(store),
    push: { publicKey: vapid.publicKey, notifications },
    ...(o.limits ? { limits: o.limits } : {}), ...(o.heartbeatMs ? { heartbeatMs: o.heartbeatMs } : {}), ...(o.now ? { now: o.now } : {}),
```

with:

```ts
    steering: new SteeringService(store, tmux, o.now ?? Date.now, () => access.policy(), inbox), escalations, remote, inbox, reading: new ReadingService(store),
    push: { publicKey: vapid.publicKey, notifications }, ...(o.queue ? { queue: o.queue(store) } : {}),
    ...(o.limits ? { limits: o.limits } : {}), ...(o.heartbeatMs ? { heartbeatMs: o.heartbeatMs } : {}), ...(o.now ? { now: o.now } : {}),
```

- [ ] **Step 12.45: Run it and see it pass**

Run: `npx vitest run apps/hub/test/http-manager-queue.test.ts apps/hub/test/http.test.ts apps/hub/test/http-protocol.test.ts apps/hub/test/catchup.test.ts`
Expected: PASS, every test.

- [ ] **Step 12.46: Commit**

```bash
git add apps/hub/src/adapters/http.ts apps/hub/test/inprocess-hub.ts apps/hub/test/http-manager-queue.test.ts
```

```bash
git commit -m "feat(hub): the feed tells each device where its messages to the manager stand"
```

- [ ] **Step 12.47: Write the failing test of `morndo serve` with the queue**

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

- [ ] **Step 12.48: Run it and see it fail**

Run: `npx vitest run apps/hub/test/manager-queue-main.test.ts`
Expected: FAIL, 3 of 4: `AssertionError: Target cannot be null or undefined.` twice (no `manager queue: on` line, no sticky warning) and `AssertionError: expected [] to deeply equal [ 'hub:ep1:r1' ]` (nothing cancelled). The negative control ("on, the same delivery is left queued") passes.

- [ ] **Step 12.49: Wire the queue into `morndo serve`**

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
VNC server), MORNDO_VNC_PASSWORD_FILE, MORNDO_FLEET_SOCKET (the fleet service's client socket; unset, this
machine's tmux and Claude Code directly), MORNDO_ENGINE_SESSIONS (engine-lane registry directory; off unless set)
and MORNDO_ENGINE_NODE (this machine's fleet node name, required with a fleet).`;

```

with:

```ts
VNC server), MORNDO_VNC_PASSWORD_FILE, MORNDO_FLEET_SOCKET (the fleet service's client socket; unset, this
machine's tmux and Claude Code directly), MORNDO_ENGINE_SESSIONS (engine-lane registry directory; off unless set),
MORNDO_ENGINE_NODE (this machine's fleet node name, required with a fleet) and MORNDO_MANAGER_QUEUE (with a fleet,
the manager's answers and messages go through the fleet's delivery queue; "off" types them directly).`;

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
    // The manager's answers and messages through the fleet's delivery queue (fleet-clients §9.1): with a fleet, on unless
    // MORNDO_MANAGER_QUEUE is off. Off, what is still queued is cancelled at start and the rest followed to its end.
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
    });
    const http = startHttp({ config, identity, access, observation, steering, escalations, remote, files, inbox, reading, push: { publicKey: vapid.publicKey, notifications } });
    const sweepInbox = setInterval(() => inbox.sweep(), 3_600_000);
```

with:

```ts
    });
    const http = startHttp({ config, identity, access, observation, steering, escalations, remote, files, inbox, reading, push: { publicKey: vapid.publicKey, notifications }, queue });
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

- [ ] **Step 12.50: Run it and see it pass, then every suite, the types and the linter**

Run: `npx vitest run apps/hub/test/manager-queue-main.test.ts apps/hub/test/config-fleet.test.ts apps/hub/test/migrations.test.ts`
Expected: PASS, every test (`manager-queue-main.test.ts`: 4).

Run: `npx vitest run apps/hub packages/domain packages/protocol`
Expected: PASS, every test.

Run: `npx vitest run test/fleet/drills-retry.test.ts test/fleet/duplicate-names.test.ts`
Expected: PASS, 20 tests (a few minutes). Without their `managerQueue: false`, the hub queues what these drills expect it to type: in the scratch copy (whose fleet has no deliveries, Tasks 4 to 9 not being in its base) 14 of them failed, most waiting for the manager's pane.

Run: `npx vitest run test/fleet`
Expected: PASS, every drill; the others run with the queue on.

Run: `npm run check`
Expected: exit 0 once Tasks 1 to 3 are in.

Run: `npm run lint`
Expected: no problems.

- [ ] **Step 12.51: Commit**

```bash
git add apps/hub/src/main.ts apps/hub/test/manager-queue-main.test.ts test/fleet-harness.ts test/fleet/drills-retry.test.ts test/fleet/duplicate-names.test.ts
```

```bash
git commit -m "feat(hub): morndo serve sends the manager's answers and messages through the queue; the switch off cancels first"
```

- [ ] **Step 12.52: Add the negative controls of Task 12**

Add to `scripts/negative-controls.ts`, at the end of `CONTROLS` (every one was applied in the scratch copy and bit, with the `expect` text in its failure):

```ts
  // ---- fleet-clients Task 12: the manager's answers and commands through the queue (plan/04-hub-web.md)
  { id: "fc12-held-any-decision", task: "fc12", file: "packages/domain/src/escalation.ts",
    find: "return d && d.delivery?.state === \"queued\" && sameDecision(d, expected) ? d : null;",
    replace: "return d && d.delivery?.state === \"queued\" ? d : null;",
    run: ["packages/domain/test/escalation-delivery.test.ts"], expect: "to be null" },
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
    find: "    if (this.#manager?.queue.on && this.#manager.isManager(workerId)) return this.#queueCommand(a, key, workerId, body, uploads.length, now);\n", replace: "",
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

Run: `node scripts/negative-controls.ts --list | awk -F'\t' '$1 ~ /^fc12-/ {print "--only " $1}' | xargs node scripts/negative-controls.ts` (all 30 `fc12-` entries)
Expected: `bit` for each. (The full run takes minutes; CI runs it with the rest.)

```bash
git add scripts/negative-controls.ts
```

```bash
git commit -m "test: negative controls for the manager's queue in the hub"
```

---

### Task 13: Web: Queued, Delivered and May-have-been-delivered for the manager

**Files:**
- Create: `apps/web/src/lib/queue-words.ts` (the words, and the table of reasons)
- Modify: `apps/web/src/lib/outbox/state.ts` (`CommandDelivery`, `OutboxRecord.delivery`, `commandDelivery`), `apps/web/src/lib/outbox/outbox.ts` (`PostOutcome.delivery`, `Outbox.deliveries`), `apps/web/src/lib/outbox/device.ts` (the send answer's `delivery`), `apps/web/src/lib/outbox/words.ts` (labels, `deliveryNote`)
- Modify: `apps/web/src/lib/desktop/Desktop.svelte`, `apps/web/src/lib/phone/Phone.svelte` (frames to the outbox), `apps/web/src/lib/desktop/MessageList.svelte`, `apps/web/src/lib/phone/UpdateCard.svelte` (the note)
- Modify: `apps/web/src/lib/desktop/decisions.ts` (`deliveryLine`), `apps/web/src/lib/desktop/DecisionCard.svelte`, `apps/web/src/lib/phone/DecisionCard.svelte`, `apps/web/src/lib/phone/horizon.ts`
- Modify: `apps/web/src/lib/gallery/data.ts` (three cards), `e2e/gallery.e2e.ts` (13 cards, their words)
- Create (tests): `apps/web/test/queue-words.test.ts`, `apps/web/test/outbox-deliveries.test.ts`, `apps/web/test/manager-queue-web.test.ts` (Chromium)
- Modify: `scripts/negative-controls.ts`

**Interfaces:**
- Consumes: Task 12's `QueuedCommand`, `DecisionItem.waiting`, `Decision.delivery`, the `deliveries` frame and `LiveFeed.deliveries` (Step 12.8), the send route's `delivery`; Task 1's `WaitingReason` (with `unavailable`, ruling 15) and `GiveUpReason` (types only, for the tables' exhaustiveness).
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
  // apps/web/src/lib/outbox/outbox.ts
  PostOutcome "typed" gains delivery?: CommandDelivery;  Outbox.deliveries(items: readonly QueuedCommand[]): Promise<void>
  // apps/web/src/lib/outbox/words.ts
  export function deliveryNote(o: OutboxRecord): string
  // apps/web/src/lib/desktop/decisions.ts
  export type DeliveryLine; export function deliveryLine(d: DecisionItem): DeliveryLine | null
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
- **A message (the desktop's conversation, the phone's update card):** its time label is the delivery's word (a day queued still says "Queued, it will be delivered", never "not seen yet"); a note under the text says why it waits, why it never went, or what "may have been" means; Dismiss as for any Sent entry. The echo still ends it.
- **An answer's card:**
  - desktop: "Queued, it will be delivered: <why>.", "Delivered · <time>. The manager closes this when it's done.", or "May have been delivered: it was typed, but never seen in the manager's conversation. It stays answered; look at the manager's screen to be sure.";
  - phone: "Answered. Queued, it will be delivered: <why>.", "Answered. Delivered to the manager.", "Answered. May have been delivered: …";
  - the phone's Today row: "… Queued, it will be delivered." or "… May have been delivered."
- From PR #10 (ADR-0010) this reuses the card's `deliveryLine` and the phone's `answeredHere`, with this queue's states and reasons in place of the inbox's.

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
// later finds queued is Sent. A frame for a request this device doesn't hold changes nothing. A memory store.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Outbox, type PostOutcome } from "../src/lib/outbox/outbox.ts";
import { memoryStore, type OutboxStore } from "../src/lib/outbox/store.ts";
import { commandDelivery } from "../src/lib/outbox/state.ts";

const T0 = Date.UTC(2026, 9, 8, 9);
let store: OutboxStore;
let answer: () => PostOutcome;
let n = 0;
const outbox = () => new Outbox({
  store, post: async () => answer(), connected: () => true, onChange: () => {},
  timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) },
  newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
});
const cmd = { worker: "pc.aaaaaaaa.0", workerName: "manager", text: "status please", uploads: [], seen: "none" };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); store = memoryStore(); n = 0; });
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
// be delivered" with why it waits, then "Delivered", "May have been delivered" or "Not delivered" as the hub's
// `deliveries` frames say; an answer's card reads the same on the desktop and on the phone. The real Desktop client and
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

type SendWin = FeedWin & { __posts: { requestId: string; text: string }[]; __delivery: unknown };
// Runs in the page before the app: POST /api/workers/<id>/send answers as a fleet hub does for the manager (spec §9.1):
// ok, with where the message stands in the queue; never an echo (it isn't in the conversation yet).
function fakeQueueSend() {
  const w = globalThis as unknown as SendWin & { fetch: typeof fetch };
  w.__posts = [];
  w.__delivery = { state: "queued", waiting: "menu_open", why: null };
  const inner = w.fetch.bind(w);
  w.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
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
});
```

- [ ] **Step 13.2: Run them and see them fail**

Run: `npx vitest run apps/web/test/queue-words.test.ts apps/web/test/outbox-deliveries.test.ts`
Expected: FAIL. `queue-words.test.ts` errors with `Error: Cannot find module '../src/lib/queue-words.ts' imported from …/apps/web/test/queue-words.test.ts` and runs no tests; `outbox-deliveries.test.ts` fails 4 of 4: `AssertionError: expected { …(13) } to match object { state: 'sent', delivery: { …(2) } }`, `TypeError: o.deliveries is not a function` (two), `TypeError: commandDelivery is not a function`.

Run: `npx vitest run apps/web/test/manager-queue-web.test.ts`
Expected: FAIL: the suite doesn't load (`Cannot find module '../src/lib/queue-words.ts'`), so none of its 4 tests runs.

- [ ] **Step 13.3: Implement the words, the outbox's deliveries and the cards**

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

In `apps/web/src/lib/outbox/state.ts` (1 of 2), replace:

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

In `apps/web/src/lib/outbox/state.ts` (2 of 2), replace:

```ts
  hubAt?: number | null;
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

In `apps/web/src/lib/outbox/outbox.ts` (1 of 4), replace:

```ts
// Design reference, not code: Signal-Desktop ts/jobs/JobQueue.std.ts and conversationJobQueue.preload.ts.
import { ATTEMPT_TIMEOUT_MS, BUDGET_MS, advance, canRetry, matchEchoes, retryDelay, type Echo, type OutboxRecord } from "./state.ts";
import type { OutboxStore } from "./store.ts";
```

with:

```ts
// Design reference, not code: Signal-Desktop ts/jobs/JobQueue.std.ts and conversationJobQueue.preload.ts.
import type { QueuedCommand } from "@morndo/protocol";
import { ATTEMPT_TIMEOUT_MS, BUDGET_MS, advance, canRetry, matchEchoes, retryDelay, type CommandDelivery, type Echo, type OutboxRecord } from "./state.ts";
import type { OutboxStore } from "./store.ts";
```

In `apps/web/src/lib/outbox/outbox.ts` (2 of 4), replace:

```ts
export type PostOutcome =
  | { kind: "typed"; at?: number }
  | { kind: "uncertain" }
```

with:

```ts
export type PostOutcome =
  | { kind: "typed"; at?: number; delivery?: CommandDelivery }   // delivery: the manager's queue has it (fleet-clients §9.1)
  | { kind: "uncertain" }
```

In `apps/web/src/lib/outbox/outbox.ts` (3 of 4), replace:

```ts
    if (outcome.kind !== "typed") return;
    if (!(await this.#save({ ...r, state: advance(r.state, "sent"), sentAt: this.#timers.now(), typedAt: outcome.at ?? null, error: null }))) return;
    this.#kick(r.worker);                                             // what was written after it goes now
  }
```

with:

```ts
    if (outcome.kind !== "typed") return;
    if (!(await this.#save({ ...r, state: advance(r.state, "sent"), sentAt: this.#timers.now(), typedAt: outcome.at ?? null, error: null, ...(outcome.delivery ? { delivery: outcome.delivery } : {}) }))) return;
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
```

In `apps/web/src/lib/outbox/outbox.ts` (4 of 4), replace:

```ts
        case "typed":
          await this.#save({ ...now, state: advance(now.state, "sent"), sentAt: this.#timers.now(), typedAt: outcome.at ?? null, error: null });
          return;
```

with:

```ts
        case "typed":
          await this.#save({ ...now, state: advance(now.state, "sent"), sentAt: this.#timers.now(), typedAt: outcome.at ?? null, error: null, ...(outcome.delivery ? { delivery: outcome.delivery } : {}) });
          return;
```

In `apps/web/src/lib/outbox/device.ts` (1 of 2), replace:

```ts
import { Outbox, type PostOutcome } from "./outbox.ts";
import type { OutboxRecord } from "./state.ts";
import { openStore } from "./store.ts";
```

with:

```ts
import { Outbox, type PostOutcome } from "./outbox.ts";
import { commandDelivery, type OutboxRecord } from "./state.ts";
import { openStore } from "./store.ts";
```

In `apps/web/src/lib/outbox/device.ts` (2 of 2), replace:

```ts
  try {
    const res = await api.post<{ at?: unknown }>(`/api/workers/${encodeURIComponent(r.worker)}/send`, { text: r.text, requestId: r.id, uploads: r.uploads, seen: r.seen, name: r.workerName }, signal);
    // ok, or 200 "duplicate": typed before. `at` is the hub's time of the typing (review M2).
    return typeof res.at === "number" ? { kind: "typed", at: res.at } : { kind: "typed" };
  } catch (e) {
```

with:

```ts
  try {
    const res = await api.post<{ at?: unknown; delivery?: unknown }>(`/api/workers/${encodeURIComponent(r.worker)}/send`, { text: r.text, requestId: r.id, uploads: r.uploads, seen: r.seen, name: r.workerName }, signal);
    // ok, or 200 "duplicate": typed before. `at` is the hub's time of the typing (review M2). `delivery`: the manager's
    // queue has it (fleet-clients §9.1), and where it stands there.
    const delivery = commandDelivery(res.delivery);
    return { kind: "typed", ...(typeof res.at === "number" ? { at: res.at } : {}), ...(delivery ? { delivery } : {}) };
  } catch (e) {
```

In `apps/web/src/lib/outbox/words.ts` (1 of 3), replace:

```ts
import { UNSEEN_AFTER_MS, type OutboxRecord } from "./state.ts";

```

with:

```ts
import { UNSEEN_AFTER_MS, type OutboxRecord } from "./state.ts";
import { DELIVERED, GIVEN_UP, MAY_HAVE_BEEN, NOT_DELIVERED, QUEUED, queuedLine } from "../queue-words.ts";

```

In `apps/web/src/lib/outbox/words.ts` (2 of 3), replace:

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

In `apps/web/src/lib/outbox/words.ts` (3 of 3), replace:

```ts
    case "sending": return "Sending…";
    case "sent": return o.sentAt !== null && now - o.sentAt > UNSEEN_AFTER_MS ? "Sent, not seen in the conversation yet" : "Sent";
    case "failed": return "Not sent";
```

with:

```ts
    case "sending": return "Sending…";
    case "sent":
      if (o.delivery) return DELIVERY_LABELS[o.delivery.state];               // the manager's queue has it (fleet-clients §9.1)
      return o.sentAt !== null && now - o.sentAt > UNSEEN_AFTER_MS ? "Sent, not seen in the conversation yet" : "Sent";
    case "failed": return "Not sent";
```

In `apps/web/src/lib/desktop/Desktop.svelte`, replace:

```svelte
  $effect(() => { if (feed.status === "live") outbox?.connected(); });

```

with:

```svelte
  $effect(() => { if (feed.status === "live") outbox?.connected(); });
  // Messages to the manager in the fleet's queue move on as the hub says (fleet-clients §9.1).
  $effect(() => { const items = feed.deliveries; if (items.length) void outboxReady.then(o => o.deliveries(items)); });

```

In `apps/web/src/lib/phone/Phone.svelte`, replace:

```svelte
  $effect(() => { if (feed.status === "live") outbox?.connected(); });

```

with:

```svelte
  $effect(() => { if (feed.status === "live") outbox?.connected(); });
  // Messages to the manager in the fleet's queue move on as the hub says (fleet-clients §9.1).
  $effect(() => { const items = feed.deliveries; if (items.length) void device$.ready.then(o => o.deliveries(items)); });

```

In `apps/web/src/lib/desktop/MessageList.svelte` (1 of 2), replace:

```svelte
  import { canRetry, type OutboxRecord } from "../outbox/state.ts";
  import { sendLabel, sendReason } from "../outbox/words.ts";
  import { dividerBefore, scrollAnchor, showJump, type Anchor, type TimelineChange } from "./timeline.ts";
```

with:

```svelte
  import { canRetry, type OutboxRecord } from "../outbox/state.ts";
  import { deliveryNote, sendLabel, sendReason } from "../outbox/words.ts";
  import { dividerBefore, scrollAnchor, showJump, type Anchor, type TimelineChange } from "./timeline.ts";
```

In `apps/web/src/lib/desktop/MessageList.svelte` (2 of 2), replace:

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

In `apps/web/src/lib/phone/UpdateCard.svelte` (1 of 2), replace:

```svelte
  import { canRetry, type OutboxRecord } from "../outbox/state.ts";
  import { sendLabel, sendReason } from "../outbox/words.ts";
  import { headline, sinceLabel, spanLabel } from "./words.ts";
```

with:

```svelte
  import { canRetry, type OutboxRecord } from "../outbox/state.ts";
  import { deliveryNote, sendLabel, sendReason } from "../outbox/words.ts";
  import { headline, sinceLabel, spanLabel } from "./words.ts";
```

In `apps/web/src/lib/phone/UpdateCard.svelte` (2 of 2), replace:

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

In `apps/web/src/lib/desktop/decisions.ts` (1 of 2), replace:

```ts
import type { DecisionItem, LedgerState } from "@morndo/protocol";

```

with:

```ts
import type { DecisionItem, LedgerState } from "@morndo/protocol";
import { WAITING } from "../queue-words.ts";

```

In `apps/web/src/lib/desktop/decisions.ts` (2 of 2), replace:

```ts
  return days === 1 ? "yesterday" : `${days} days ago`;
}
```

with:

```ts
  return days === 1 ? "yesterday" : `${days} days ago`;
}

// An answer for the manager in the fleet's delivery queue (E13; fleet-clients §9.1): queued (with why it waits, in words),
// delivered (and when), or may have been delivered. Null for an answer that went straight in.
export type DeliveryLine = { state: "queued"; why: string | null } | { state: "delivered"; at: number | null } | { state: "uncertain" };
export function deliveryLine(d: DecisionItem): DeliveryLine | null {
  const del = d.decision?.delivery;
  if (!del) return null;
  if (del.state === "delivered") return { state: "delivered", at: del.at };
  if (del.state === "uncertain") return { state: "uncertain" };
  return { state: "queued", why: d.waiting ? WAITING[d.waiting] ?? null : null };
}
```

In `apps/web/src/lib/desktop/DecisionCard.svelte` (1 of 3), replace:

```svelte
  import Avatar from "./Avatar.svelte";
  import { ago, dueLabel, REFUSALS, urgency, type DecisionItem } from "./decisions.ts";
  import { clock } from "./grouping.ts";
```

with:

```svelte
  import Avatar from "./Avatar.svelte";
  import { ago, deliveryLine, dueLabel, REFUSALS, urgency, type DecisionItem } from "./decisions.ts";
  import { DELIVERED, MAY_HAVE_BEEN, QUEUED } from "../queue-words.ts";
  import { clock } from "./grouping.ts";
```

In `apps/web/src/lib/desktop/DecisionCard.svelte` (2 of 3), replace:

```svelte
    {@const d = item.decision}
    <div class="state ok" role="status">
```

with:

```svelte
    {@const d = item.decision}
    {@const dl = deliveryLine(item)}
    <div class="state ok" role="status">
```

In `apps/web/src/lib/desktop/DecisionCard.svelte` (3 of 3), replace:

```svelte
        </p>
        <p class="sub">{item.asker.kind === "manager" ? "The manager has it and closes this when it's done." : "Sent."}</p>
      </div>
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
          <p class="sub">{item.asker.kind === "manager" ? "The manager has it and closes this when it's done." : "Sent."}</p>
        {/if}
      </div>
```

In `apps/web/src/lib/phone/DecisionCard.svelte` (1 of 2), replace:

```svelte
  import { renderMarkdown } from "../markdown.ts";
  import { REFUSALS, ago, type DecisionItem } from "../desktop/decisions.ts";
  import { byLabel } from "./horizon.ts";
```

with:

```svelte
  import { renderMarkdown } from "../markdown.ts";
  import { REFUSALS, ago, deliveryLine, type DecisionItem } from "../desktop/decisions.ts";
  import { DELIVERED, MAY_HAVE_BEEN, QUEUED } from "../queue-words.ts";
  import { byLabel } from "./horizon.ts";
```

In `apps/web/src/lib/phone/DecisionCard.svelte` (2 of 2), replace:

```svelte
  // Not on the board: gone, if the board is current; otherwise nothing can be said yet (review of PR #7, finding 8).
  const closed = $derived(!item ? (primed ? "This decision isn't on the hub's list anymore." : null)
    : item.status === "answered" ? (item.decision?.via === "elsewhere" ? `Answered on another device: ${item.decision.choice.kind === "option" ? `“${item.decision.choice.label}”` : "in words"}.` : "Answered.")
    : item.status === "settled" ? `Settled${item.resolution ? `: ${item.resolution}` : "."}`
```

with:

```svelte
  // Not on the board: gone, if the board is current; otherwise nothing can be said yet (review of PR #7, finding 8).
  // An answer for the manager in the fleet's queue (fleet-clients §9.1, E13): where it stands until it is in the conversation.
  function answeredHere(d: DecisionItem): string {
    const dl = deliveryLine(d);
    if (dl?.state === "queued") return `Answered. ${QUEUED}${dl.why ? `: ${dl.why}` : ""}.`;
    if (dl?.state === "delivered") return `Answered. ${DELIVERED} to the manager.`;
    if (dl?.state === "uncertain") return `Answered. ${MAY_HAVE_BEEN}: look at the manager's screen to be sure.`;
    return "Answered.";
  }
  const closed = $derived(!item ? (primed ? "This decision isn't on the hub's list anymore." : null)
    : item.status === "answered" ? (item.decision?.via === "elsewhere" ? `Answered on another device: ${item.decision.choice.kind === "option" ? `“${item.decision.choice.label}”` : "in words"}.` : answeredHere(item))
    : item.status === "settled" ? `Settled${item.resolution ? `: ${item.resolution}` : "."}`
```

In `apps/web/src/lib/phone/horizon.ts` (1 of 2), replace:

```ts
import type { RosterEntry } from "@morndo/domain";
import type { DecisionItem } from "../desktop/decisions.ts";
import { clause } from "./brief.ts";
```

with:

```ts
import type { RosterEntry } from "@morndo/domain";
import { deliveryLine, type DecisionItem } from "../desktop/decisions.ts";
import { MAY_HAVE_BEEN, QUEUED } from "../queue-words.ts";
import { clause } from "./brief.ts";
```

In `apps/web/src/lib/phone/horizon.ts` (2 of 2), replace:

```ts
        : here ? `You said “${here.label}” at ${hm(dec.at)}.` : `You answered in words at ${hm(dec.at)}.`;
      rows.push({ key: `d:${d.id}`, needsYou: false, at: d.deadline, title: short(d), detail: `${said} ${asker(d)} takes it from here.`, decisionId: null, item: d });
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

- [ ] **Step 13.4: The gallery's three new cards, and its check**

In `apps/web/src/lib/gallery/data.ts`, replace:

```ts
    { label: "Answered here", item: d("answered", { status: "answered", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 5 * MIN, via: "here", endpointId: null, sessionId: null } }) },
    { label: "Settled", item: d("settled", { status: "settled", decision: { choice: { kind: "option", key: "b", label: "Wait a week" }, at: now - 2 * HOUR, via: "elsewhere", endpointId: null, sessionId: null }, resolution: "Moved to next week.", settledAt: now - HOUR }) },
```

with:

```ts
    { label: "Answered here", item: d("answered", { status: "answered", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 5 * MIN, via: "here", endpointId: null, sessionId: null } }) },
    // The manager's queue (fleet-clients §9.1, E13): queued with why it waits, delivered, and may have been delivered.
    { label: "Answered, queued for the manager (its input box has someone's text)", item: d("queued", { status: "answered", answerable: "already_answered", waiting: "draft_present", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 2 * MIN, via: "here", endpointId: null, sessionId: null, delivery: { state: "queued", at: null } } }) },
    { label: "Answered, delivered to the manager", item: d("delivered", { status: "answered", answerable: "already_answered", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 9 * MIN, via: "here", endpointId: null, sessionId: null, delivery: { state: "delivered", at: now - 8 * MIN } } }) },
    { label: "Answered, may have been delivered", item: d("uncertain", { status: "answered", answerable: "already_answered", decision: { choice: { kind: "option", key: "b", label: "Wait a week" }, at: now - 3 * HOUR, via: "here", endpointId: null, sessionId: null, delivery: { state: "uncertain", at: null } } }) },
    { label: "Settled", item: d("settled", { status: "settled", decision: { choice: { kind: "option", key: "b", label: "Wait a week" }, at: now - 2 * HOUR, via: "elsewhere", endpointId: null, sessionId: null }, resolution: "Moved to next week.", settledAt: now - HOUR }) },
```

In `e2e/gallery.e2e.ts` (1 of 2), replace:

```ts
      // Each decision card in its state (review L2).
      assert(await page.locator('[data-shot="decisions"] figure').count() === 10, "not 10 decision cards");
      const card = (caption: string) => page.locator('[data-shot="decisions"] figure').filter({ has: page.locator("figcaption", { hasText: caption }) }).locator("article.dc");
```

with:

```ts
      // Each decision card in its state (review L2).
      assert(await page.locator('[data-shot="decisions"] figure').count() === 13, "not 13 decision cards");
      const card = (caption: string) => page.locator('[data-shot="decisions"] figure').filter({ has: page.locator("figcaption", { hasText: caption }) }).locator("article.dc");
```

In `e2e/gallery.e2e.ts` (2 of 2), replace:

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
      // Answering, by clicking as a person would (review L3): the confirmation, words, sending, refused.
```

- [ ] **Step 13.5: Run them and see them pass, then every web suite and the checks**

Run: `npx vitest run apps/web/test/queue-words.test.ts apps/web/test/outbox-deliveries.test.ts apps/web/test/manager-queue-web.test.ts`
Expected: PASS, 3 files, 16 tests (8, 4 and 4).

Run: `npx vitest run apps/web`
Expected: PASS, every test (54 files, 335 tests in the scratch copy, the Chromium ones included).

Run: `npm run check -w @morndo/web`
Expected: no error in this task's files.

Run: `npm run build && node e2e/gallery.e2e.ts`
Expected: `gallery.e2e.ts` passes 5 of 5: 13 decision cards and the three new words. (Run it on its own: `npm run e2e` stops earlier at `desktop.e2e.ts` on a machine without TigerVNC, unrelated to this task.)

- [ ] **Step 13.6: Commit, then the negative controls**

```bash
git add apps/web/src/lib/queue-words.ts apps/web/src/lib/outbox/state.ts apps/web/src/lib/outbox/outbox.ts apps/web/src/lib/outbox/device.ts apps/web/src/lib/outbox/words.ts apps/web/src/lib/desktop/Desktop.svelte apps/web/src/lib/phone/Phone.svelte apps/web/src/lib/desktop/MessageList.svelte apps/web/src/lib/phone/UpdateCard.svelte apps/web/src/lib/desktop/decisions.ts apps/web/src/lib/desktop/DecisionCard.svelte apps/web/src/lib/phone/DecisionCard.svelte apps/web/src/lib/phone/horizon.ts apps/web/src/lib/gallery/data.ts e2e/gallery.e2e.ts apps/web/test/queue-words.test.ts apps/web/test/outbox-deliveries.test.ts apps/web/test/manager-queue-web.test.ts
```

```bash
git commit -m "feat(web): Queued, it will be delivered; Delivered; May have been delivered, for the manager's messages and answers"
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
```

Run: `node scripts/negative-controls.ts --only fc13-label-ignores-delivery --only fc13-unavailable-unworded --only fc13-uncertain-stays --only fc13-frames-not-applied --only fc13-today-ignores-delivery`
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
  - Task 12's fake fleet (`pane.capture`, `keyNamesTyped`, deliveries, `laneEvent`).
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

In `main.ts`, the command runs before `loadConfig()` and `openStore()`: it needs neither, runs on machines with no hub, and must not fail on a hub setting (`MORNDO_ORIGIN`) or create the hub's data directory. It writes every line before it exits (`processIo`; writes to a pipe are asynchronous on POSIX, https://nodejs.org/docs/latest-v24.x/api/process.html#a-note-on-process-io, read 2026-10-08).

In `apps/hub/src/main.ts` (1 of 3), replace:

```ts
import { fleetDeliveries } from "./adapters/fleet-deliveries.ts";
import { fileStore } from "./adapters/files.ts";
```

with:

```ts
import { fleetDeliveries } from "./adapters/fleet-deliveries.ts";
import { processIo, runLanes } from "./console/lanes.ts";
import { fileStore } from "./adapters/files.ts";
```

In `apps/hub/src/main.ts` (2 of 3), replace:

```ts
  morndo audit            the latest device and session events

```

with:

```ts
  morndo audit            the latest device and session events
  morndo lanes …          every node's lanes through the fleet: list, peek, send, keys, start, stop, status,
                          events (morndo lanes --help)

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

1. **Negative-control ids** `fc<task>-<what>`, `task: "fc<task>"`: ruling 1. Controls run after their task's commit: ruling 50 (Steps 11.5, 12.52, 13.6, 14.6). The fleet core's `t5-answer-key-*`, which Step 12.34 would leave found twice, are updated there: ruling 51.
2. **The domain's E13** (`DecisionDelivery`, `Decision.delivery?`, `Escalations.queue`, `delivered`, `uncertain`, `withdraw`, `sameDecision`, `answered`), and E13 in `docs/domain.md` in Task 12 (Step 12.3, committed in Step 12.5): rulings 26 and 53.
3. **The feed's** `delivery`, `DecisionItem.waiting?`, `QueuedCommandSchema`, `QueuedCommand` and the `deliveries` frame: ruling 26.
4. **`Config.managerQueue?`**: ruling 26.
5. **`hub:<key>~<n>`** for an answer sent again after its delivery was given up: ruling 26.
6. **`caps()` answers `{ api, stickyLanes }`**, an older fleet's `[]`: ruling 8.
7. **The delivery routes' answers** (refusals 200 `{ ok: false, error }`, an unknown id 404 `no_such_delivery`, the list's newest 1000 of 7 days); the fake fleet follows them: ruling 3. `cancelDelivery`'s `null` for an unknown id, the hub's `CancelAnswer` `unknown`: ruling 56.
8. **`morndo lanes`**: `start --node`, `send --direct --id`, options after the lane name, `--json`'s fields with `topic` and `lastPrompt`, `start --json` with `waiting: "trust"`, `stop`'s 0, 3 and 4, refusal codes on stderr: rulings 13 and 29; **5 in doubt** and 69 only when the fleet wasn't reached: ruling 49; the tests of an `uncertain` delivery (4) and `start --resume`: ruling 60.
9. **The wording "Not delivered"**, and Task 13's tables with `unavailable`'s words: rulings 15 and 26. Task 13's `WAITING` table is the one kira copies (ruling 55); it has every `WaitingReason` of the Contract, `unavailable` included, and `typed` and `held`.
10. **The FakeFleet's additions**: ruling 26; it changes `fleet-adapters.test.ts` and Task 3's `fleet-client.test.ts` in the same step: ruling 53.
11. **The answer withdrawn too late (ADR-0010 H1)** is recorded against the ask it answered, and its echo skipped: ruling 27 (Step 12.34, `fc12-echo-taken-as-tap`).
12. **`CommandSent` when the hub queues a message**: ruling 28 (Step 12.39, `fc12-commandsent-only-answered`).
13. **The start line `manager queue: on|off`**: ruling 39 (Step 12.49).
14. **In doubt is never typed by hand**, the hub's switch-off path included: ruling 49 (Steps 12.34 and 12.39); `fc12-uncertain-reopens`: ruling 61.
15. **Quoted as Tasks 1 to 3 leave it** (`new FleetClient(socket, { log })` in `main.ts`): ruling 52.
16. **The fleet drills' hub runs the queue as it ships**, `drills-retry` and `duplicate-names` with `managerQueue: false`: ruling 66.

## Open questions

1. **The phone's catch-up card** offers no "Check again" for an answer that is "uncertain" from the queue (none is possible: never typed again). It says "May have been delivered" only. Confirm with the owner's wording review.
