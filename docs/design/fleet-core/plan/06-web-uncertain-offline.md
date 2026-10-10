### Task 15b: web: offline marker and 'Check again' for uncertain sends

Lane Hub-fleet, wave 2. It runs after Task 15.

**Needs:**
- **Task 15:** `Worker.node` in the domain, the protocol's `worker` fields with `node`, and worker IDs (`pc.3fa2c1d0.12`) in every frame. The tests here use fleet worker IDs.
- **Task 4 (reconciled):** each `Tmux.listWorkers()` item has `offline: boolean` (`apps/hub/src/application/ports.ts`). The local adapter (`localTmux`) and every test fake say `offline: false`.
- **Task 5:** the outbox's `OutboxRecord.typedAt`, `PostOutcome` `{ kind: "typed"; at? }`, and the words for `node_offline`.
- **Task 14:** the fleet adapters list an offline node's workers with `offline: true`. Its `op.status` repeat path is what really resolves an uncertain send: `done` → `duplicate`, `unknown` from the same store → judged and typed now (or refused now). Without Task 14 (a legacy hub), every Check again answers `409 uncertain`, and the entry stays Uncertain. Parts A–C don't need Task 14; they use fakes of the port and of the send endpoint.
- **Tasks 5 and 14, for Part F:** an escalation answer may be refused `node_offline` (Task 5) or `lane_conflict` (Task 14: 409 `{ error: "lane_conflict", item }` while two windows claim the manager's name).
- **Task 14, for Parts D and E** (plan.md, "Fleet unavailable"; Contracts, the hub's `Terminal.keys`): `ObservationService.fleet(): "ok" | "unavailable"` with its change told to each subscriber (`Listener.fleet?(status: "ok" | "unavailable")`; a legacy hub never calls it), and the terminal route's `{ t: "error", error: "keys_uncertain" }` for keys the node may have typed. Part D's hub step sends the first as the feed's `fleet` frame; Part E only words the second.

**What it does:**
1. A worker whose node doesn't answer shows as offline: a plug icon and "offline" on its desktop sidebar row, "Offline" in its conversation's header, and "offline" in place of its state in the phone's agents list. It stays listed (spec §7, "offline marker"; FL12).
2. An Uncertain send offers **Check again**. It sends the same request again, with the same request id, so the hub can ask the worker's machine. The hub's answers:
   - 200 `{ error: "duplicate", ok: true, at }`: the machine had typed it. The entry is Sent, with `typedAt: at`.
   - 200 `{ ok: true, at }`: the machine never had it, and the hub typed it now. The entry is Sent.
   - A definite refusal (`404 no_pane`, `403 step_up`, or a `409` with any problem but `uncertain`): the machine never had it, and the hub refused it now, so nothing was typed. The entry is Not sent, with that refusal's words, and offers what any Not sent entry of that kind offers (Retry, Edit for `stale`, Verify and send for `step_up`).
   - Anything else (`409 { error: "uncertain" }`, a 5xx, a 429, no answer): the entry stays Uncertain.
3. While the hub can't reach the fleet service, both layouts show a "Fleet unavailable" banner: the feed's `fleet` frame says so after every hello and on every change, and the hub lists every worker offline meanwhile (Task 14). A hub that never sends the frame (one from before the fleet) shows none.
4. Keys typed in the terminal view that the worker's machine may have typed before the hub lost touch (`keys_uncertain`) read "Those keys may have been typed.", not "The pane didn't take those keys." (that stays for a refusal).
5. An answer to a Decision refused because the manager's machine doesn't answer (`node_offline`) or because two windows claim the manager's name (`lane_conflict`) gets words, on the desktop and the phone alike, instead of the hub's bare code.

**Decisions:**
1. **`offline` is roster state, not part of `Worker`.** `Worker` names a worker; `offline` changes with its node, like `state`. So `RosterEntry` gains `offline`, and `WorkerAppeared` carries it next to `state`. The listing the Roster takes is `ListedWorker = Worker & { offline: boolean }`. Nothing outside the hub's listing changes shape.
2. **One feed event, `WorkerOfflineChanged { workerId, offline }`,** shaped like `WorkerNeedsYouChanged`. An app from before it skips it: an unknown event type keeps its place in the sequence (O1). A hub from before it doesn't say: the protocol reads `offline` as `false`.
3. **Check again is the principal's Retry on an Uncertain entry.** `canRetry` takes `uncertain` too, the button says "Check again", and `Outbox.retry` sends one POST with the same id. `Desktop.svelte` and `Phone.svelte` already wire `onRetry` to `outbox.retry`, so no callback is added anywhere.
4. **Check again is one POST, never repeated on its own.** It is offered only within `RETRY_WINDOW_MS`, as Retry is. After that the hub may have dropped the request's record, and a "check" could type a day-old message.
5. **The hub's HTTP answers don't change.** An uncertain send is `409 { error: "uncertain" }` (`http.ts`). `device.ts` already maps the code `uncertain` to `{ kind: "uncertain" }`.
6. **The phone's order doesn't change** (`lanes.ts`). An offline worker's screen stops changing, so it turns quiet after `quietAfterMs` and sorts with the idle ones.
7. **A definite refusal on Check again ends it Not sent** (round-2 review, item 30). The hub answers a repeat of a request in doubt before it judges anything else (`SteeringService.send`: the repeat path comes first). It answers `409 uncertain` while the worker's machine can't say, and a 5xx when it threw. Only once the machine said it never had the request (`op.status` `unknown` from the store the request went to, Task 14) does the hub judge the send anew; a refusal then means nothing was typed, then or now. So a `404 no_pane`, a `403 step_up` or any other `409` is Not sent, by its status (`PostOutcome.refused` now carries it), and a 5xx, a 429 or a refusal without a status keeps it Uncertain.
8. **"Fleet unavailable" is its own frame, not a roster event.** It is the hub's link to the fleet, like the board's ledger state: sent after every hello, since a resumed feed may have missed a change, and on every change. One banner component serves both layouts, fixed at the top (below the desktop's 40px bar), with an icon and words in the warning colours (COLOR.md 2); it lets clicks through and has nothing to dismiss, since it goes when its cause does.
9. **Keys in doubt are worded, not refused** (round-2 review, item 25). Keystrokes are never retried (spec §5.3), so there is nothing to offer; the words say what is known.

**Files:**

Line numbers are those of the verification tree (Tasks 4, 5 and 15 applied). Match on the quoted text.

- Modify: `packages/domain/src/observation.ts`:
  - `:5-6` (after `Worker`: `ListedWorker`);
  - `:12`, `:19` (`FeedBody`);
  - `:57` (`RosterEntry`);
  - `:75-89` (`Roster.observeListing`).
- Modify: `packages/protocol/src/feed.ts:45-61` (`offline`, `RosterEntrySchema`, `FeedBodySchema`)
- Modify: `apps/hub/src/application/observation-service.ts:172` (the listing handed to `observeListing`)
- Modify: `apps/web/src/lib/feed.svelte.ts:423`, `:440-444` (`#apply`)
- Modify: `apps/web/src/lib/desktop/Sidebar.svelte:2-3`, `:10`, `:67-70`, `:84-87`, `:143-146`
- Modify: `apps/web/src/lib/desktop/ChannelView.svelte:46`, `:59`
- Modify: `apps/web/src/lib/phone/Agents.svelte:90-94`, `:142`
- Modify: `apps/web/src/lib/gallery/data.ts:14`, `:18`, `:29`; `apps/web/src/lib/gallery/Gallery.svelte:66`, `:131`
- Modify: `apps/web/src/lib/outbox/state.ts:29-35`, `:54`
- Modify: `apps/web/src/lib/outbox/outbox.ts:12-19` (`PostOutcome`, `definiteRefusal`), `:102-108` (`retry`, `#check`)
- Modify: `apps/web/src/lib/outbox/device.ts:20` (a refusal carries its status)
- Modify: `apps/web/src/lib/outbox/words.ts:30`
- Modify: `apps/web/src/lib/desktop/MessageList.svelte:264`; `apps/web/src/lib/phone/UpdateCard.svelte:112`
- Modify (Part D): `packages/protocol/src/feed.ts` (`ServerFeedFrames.fleet`), `apps/hub/src/adapters/http.ts` (the feed sends it), `apps/web/src/lib/feed.svelte.ts` (`fleetAvailable`), `apps/web/src/lib/desktop/Desktop.svelte`, `apps/web/src/lib/phone/Phone.svelte`, `apps/web/test/harness.ts` (an alias for `$app/navigation`)
- Modify (Part E): `apps/web/src/lib/desktop/TerminalView.svelte` (the `error` frame's words)
- Modify (Part F): `apps/web/src/lib/desktop/decisions.ts` (`REFUSALS`: `node_offline`, `lane_conflict`)
- Modify: `docs/domain.md` (Steering: Send state, S5, S7, S8; Observation: the Offline term and the events line)
- Modify (tests):
  - `packages/domain/test/observation.test.ts:47` and a new `describe` at the end;
  - `packages/domain/test/waiting-on.test.ts:19`, `packages/domain/test/conversation.test.ts:45`;
  - `apps/web/test/horizon.test.ts:15`, `apps/web/test/lanes.test.ts:6-8`;
  - `apps/web/test/harness.ts:60-64` (`FeedOptions`);
  - `apps/web/test/outbox-state.test.ts:30-34`, `:45-51`;
  - `apps/web/test/outbox.test.ts:7`, `:97-106`;
  - `apps/web/test/outbox-words.test.ts:19`;
  - `apps/web/test/outbox-web.test.ts:1-9`, `:37-41`, `:186-197`.
- Create:
  - `packages/protocol/test/worker-offline.test.ts`;
  - `apps/hub/test/observation-offline.test.ts`;
  - `apps/web/test/worker-offline-web.test.ts` (Chromium);
  - `apps/web/test/update-card-check-web.test.ts` (Chromium);
  - Part D: `apps/web/src/lib/FleetNotice.svelte`, `apps/web/test/app-navigation.stub.ts`, `packages/protocol/test/feed-fleet.test.ts`, `apps/hub/test/feed-fleet.test.ts`, `apps/web/test/fleet-unavailable-web.test.ts` (Chromium);
  - Part E: `apps/web/test/terminal-keys-web.test.ts` (Chromium);
  - Part F: `apps/web/test/decision-refusals.test.ts`.
- Unchanged, and still right: `http.ts`' send route (409 `uncertain`), `Desktop.svelte` and `Phone.svelte`'s `onRetry` → `outbox.retry`, `e2e/signal.e2e.ts:378` (an uncertain send still offers no "Retry").

**Interfaces:**
- Consumes:
  - from Task 4: `Tmux.listWorkers(): Promise<{ id: string; name: string; location: string; node: string; offline: boolean }[]>`;
  - from Task 5: `OutboxRecord.typedAt: number | null`; `PostOutcome` `{ kind: "typed"; at?: number } | { kind: "uncertain" } | …`; `post()` mapping 200 `duplicate` with `at` to `typed`;
  - from Task 15: `Worker = { id: WorkerId; name: string; location: string; node: string }`; the protocol's `worker` fields with `node: orElse(text(), "")`;
  - from Task 14 (behaviour, not code): a repeat of a `started` request asks `op.status`;
  - from Task 14 (code, Parts D and E): `ObservationService.fleet(): "ok" | "unavailable"`, `Listener.fleet?(status: "ok" | "unavailable"): void` (called on every change; a fleet hub's listing that fails makes it "unavailable"), and the terminal route's `keys_uncertain`.
- Produces:
  ```ts
  // packages/domain/src/observation.ts
  export type ListedWorker = Worker & { offline: boolean };
  export type RosterEntry = Worker & WorkerDetails & { state: WorkerState; changedAt: number; offline: boolean };
  // FeedBody: WorkerAppeared gains `offline: boolean`; new:
  | { type: "WorkerOfflineChanged"; workerId: WorkerId; offline: boolean }
  Roster.observeListing(listing: ListedWorker[], now: number): FeedBody[];   // WorkerOfflineChanged once per change
  // packages/protocol/src/feed.ts: RosterEntrySchema.offline and WorkerAppeared.offline (a hub that doesn't say: false);
  // WorkerOfflineChanged with a required boolean.
  // apps/web/src/lib/outbox/state.ts
  advance("uncertain", "sent") === "sent"; advance("uncertain", "failed") === "failed";   // every other move from "uncertain" stays
  canRetry(r, now): (r.state === "failed" || r.state === "uncertain") && now - r.createdAt < RETRY_WINDOW_MS;
  // apps/web/src/lib/outbox/outbox.ts
  PostOutcome: { kind: "refused"; code: string; status?: number } | …;   // status: the hub's HTTP status (device.ts sets it)
  definiteRefusal(o): o.status === 409 || (o.status === 404 && o.code === "no_pane") || (o.status === 403 && o.code === "step_up");
  Outbox.retry(id): on an Uncertain entry, Check again: one POST with the same request id; typed → Sent; a definite refusal → Not sent.
  // packages/protocol/src/feed.ts (Part D)
  ServerFeedFrames.fleet: { t: "fleet"; available: boolean };   // after every hello, and on every change; an older hub never sends it
  // apps/web/src/lib/feed.svelte.ts (Part D)
  LiveFeed.fleetAvailable: boolean;                             // true until the hub says otherwise
  // apps/web/src/lib/FleetNotice.svelte (Part D): props { available: boolean }; the banner while it is false
  ```

#### Part A: `offline` on the wire (domain, protocol, hub, the app's feed)

- [ ] **Step 15b.1: Write the failing domain, protocol and hub tests**

In `packages/domain/test/observation.test.ts`, replace line 47:

```ts
  const w = (id: string, name = id) => ({ id: workerId(id), name, location: "/tmp", node: "local" });
```

with:

```ts
  const w = (id: string, name = id) => ({ id: workerId(id), name, location: "/tmp", node: "local", offline: false });
```

Append at the end of the same file:

```ts

// Fleet core §7: a node that stops answering keeps its workers listed, marked offline, never gone (spec "offline marker").
describe("a worker whose machine doesn't answer", () => {
  const w = (id: string, offline: boolean) => ({ id: workerId(id), name: id, location: "/tmp", node: "pc", offline });
  const changed = (id: string, offline: boolean): FeedBody => ({ type: "WorkerOfflineChanged", workerId: workerId(id), offline });
  it("stays listed and is marked offline, then online again: one event each way, none while it stays", () => {
    const r = new Roster(10_000);
    r.observeListing([w("a", false)], 0);
    expect(r.observeListing([w("a", true)], 1)).toEqual([changed("a", true)]);
    expect(r.observeListing([w("a", true)], 2)).toEqual([]);
    expect(r.entries().map(e => [e.id, e.offline])).toEqual([["a", true]]);
    expect(r.observeListing([w("a", false)], 3)).toEqual([changed("a", false)]);
    expect(r.entries()[0]?.offline).toBe(false);
  });
  it("one first seen offline appears offline", () => {
    const r = new Roster(10_000);
    expect(r.observeListing([w("b", true)], 0)).toEqual([
      { type: "WorkerAppeared", worker: { id: workerId("b"), name: "b", location: "/tmp", node: "pc" }, state: "quiet", changedAt: 0, offline: true },
    ]);
    expect(r.entries()[0]?.offline).toBe(true);
  });
});
```

The two other domain literals passed to `observeListing` gain `offline: false`:
- `packages/domain/test/waiting-on.test.ts:19`:
  ```ts
      r.observeListing([{ id: workerId("%1"), name: "builder", location: "/w", node: "local", offline: false }], 0);
  ```
- `packages/domain/test/conversation.test.ts:45`:
  ```ts
      r.observeListing([{ id: workerId("%1"), name: "builder", location: "x", node: "local", offline: false }], 0);
  ```

Create `packages/protocol/test/worker-offline.test.ts`:

```ts
// A worker whose machine doesn't answer (fleet core §7: its workers stay listed, shown offline). A roster entry and a
// worker appearing carry `offline`; a hub from before it doesn't say, which reads as online. WorkerOfflineChanged says
// when it changes; an older app skips it as a type it doesn't know and keeps its place in the sequence (O1).
// Synthetic frames only.
import { describe, expect, it } from "vitest";
import { ServerFeedFrames, decode, decodeEvent } from "../src/index.ts";

const entry = { id: "pc.3fa2c1d0.12", name: "alpha", location: "alpha", node: "pc", title: null, lastMessageAt: null, needsYou: false, waitingOn: null, state: "quiet", changedAt: 0 };
const event = (body: unknown) => ({ epoch: "e1", seq: 1, at: 1, body });

describe("offline on the roster", () => {
  it("keeps each entry's offline; an entry from a hub that doesn't say is online", () => {
    const d = decode(ServerFeedFrames, JSON.stringify({ t: "snapshot", epoch: "e1", seq: 0, workers: [{ ...entry, offline: true }, { ...entry, id: "%1" }] }));
    expect(d.kind === "ok" && d.frame.t === "snapshot" ? d.frame.workers.map(w => [w.id, w.offline]) : null).toEqual([["pc.3fa2c1d0.12", true], ["%1", false]]);
  });
  it("a worker appearing says whether it is offline; one from a hub that doesn't say is online", () => {
    const worker = { id: "box.0a0a0a0a.3", name: "beta", location: "beta", node: "box" };
    const offline = (extra: object) => {
      const d = decodeEvent(event({ type: "WorkerAppeared", worker, state: "quiet", changedAt: 1, ...extra }));
      return d.kind === "event" && d.event.body.type === "WorkerAppeared" ? d.event.body.offline : null;
    };
    expect(offline({ offline: true })).toBe(true);
    expect(offline({})).toBe(false);
  });
});

describe("WorkerOfflineChanged", () => {
  it("decodes both ways", () => {
    for (const offline of [true, false]) {
      const body = { type: "WorkerOfflineChanged", workerId: "pc.3fa2c1d0.12", offline };
      expect(decodeEvent(event(body))).toEqual({ kind: "event", event: event(body) });
    }
  });
  it("one without a boolean flag is malformed (negative control)", () => {
    expect(decodeEvent(event({ type: "WorkerOfflineChanged", workerId: "pc.3fa2c1d0.12" })).kind).toBe("malformed");
    expect(decodeEvent(event({ type: "WorkerOfflineChanged", workerId: "pc.3fa2c1d0.12", offline: "yes" })).kind).toBe("malformed");
  });
});
```

Create `apps/hub/test/observation-offline.test.ts`:

```ts
// A worker on a node that doesn't answer (fleet core §3.1, §7): the port lists it with `offline: true`, and the roster
// keeps it, marked offline, never gone. The feed says so once each way, and a worker listed offline from the start
// appears offline. Fake port; no tmux, no transcripts.
import { describe, expect, it } from "vitest";
import type { FeedEvent } from "@morndo/domain";
import { ObservationService, type Listener } from "../src/application/observation-service.ts";
import type { Tmux } from "../src/application/ports.ts";

const PC = "pc.3fa2c1d0.1";
const BOX = "box.0a0a0a0a.2";
// The nodes in `down` don't answer: their workers are listed with offline true, as the fleet adapters list them.
function port(down: Set<string>): Pick<Tmux, "listWorkers" | "captureMany"> {
  return {
    listWorkers: async () => [
      { id: PC, name: "alpha", location: "a", node: "pc", offline: down.has("pc") },
      { id: BOX, name: "beta", location: "b", node: "box", offline: down.has("box") },
    ],
    captureMany: async ids => new Map(ids.map(id => [id, "$ "])),
  };
}
const listener = (events: FeedEvent[]): Listener => ({ events: e => { events.push(...e); }, screen: () => {}, messages: () => {}, history: () => {}, watching: () => null });

describe("a worker on a node that doesn't answer", () => {
  it("stays listed, marked offline, and the feed says so once each way; the other node's worker is untouched", async () => {
    const down = new Set<string>();
    const svc = new ObservationService(port(down), 60_000);
    const events: FeedEvent[] = [];
    svc.subscribe(listener(events));
    await svc.poll();
    expect(svc.snapshot().workers.map(w => [w.id, w.offline])).toEqual([[PC, false], [BOX, false]]);
    down.add("pc");
    await svc.poll();
    await svc.poll();                                                   // still offline: no second event
    expect(svc.snapshot().workers.map(w => [w.id, w.offline])).toEqual([[PC, true], [BOX, false]]);
    down.delete("pc");
    await svc.poll();
    expect(events.map(e => e.body).filter(b => b.type === "WorkerOfflineChanged" || b.type === "WorkerGone")).toEqual([
      { type: "WorkerOfflineChanged", workerId: PC, offline: true },
      { type: "WorkerOfflineChanged", workerId: PC, offline: false },
    ]);
  });
  it("one listed offline from the start appears offline", async () => {
    const svc = new ObservationService(port(new Set(["box"])), 60_000);
    const events: FeedEvent[] = [];
    svc.subscribe(listener(events));
    await svc.poll();
    expect(events.flatMap(e => (e.body.type === "WorkerAppeared" ? [[e.body.worker.id, e.body.offline]] : []))).toEqual([[PC, false], [BOX, true]]);
    expect(svc.snapshot().workers.find(w => w.id === BOX)?.offline).toBe(true);
  });
});
```

- [ ] **Step 15b.2: Run them and see them fail**

Run: `npx vitest run packages/domain/test/observation.test.ts packages/protocol/test/worker-offline.test.ts apps/hub/test/observation-offline.test.ts`

Expected: FAIL, 8 tests (10 pass):
- domain, "stays listed and is marked offline…": `expected [] to deeply equal [ { …(3) } ]`;
- domain, "one first seen offline appears offline": `expected [ { type: 'WorkerAppeared', …(3) } ] to deeply equal [ { type: 'WorkerAppeared', …(4) } ]`;
- protocol, "keeps each entry's offline…": received `[ [ 'pc.3fa2c1d0.12', undefined ], [ '%1', undefined ] ]`;
- protocol, "a worker appearing says…": `expected undefined to be true`;
- protocol, "decodes both ways": received `{ kind: 'unknown', epoch: 'e1', seq: 1 }`;
- protocol, "one without a boolean flag is malformed": `expected 'unknown' to be 'malformed'`;
- hub, "stays listed, marked offline…": received `[ [ 'pc.3fa2c1d0.1', undefined ], [ 'box.0a0a0a0a.2', undefined ] ]`;
- hub, "one listed offline from the start…": the same, `undefined` for both.

- [ ] **Step 15b.3: Implement `offline` in the domain, the protocol, the hub and the app's feed**

In `packages/domain/src/observation.ts`:

1. After the `Worker` line (`export type Worker = { id: WorkerId; name: string; location: string; node: string };`), insert:
   ```ts
   // A worker as a listing reports it. offline: its machine doesn't answer now; it stays listed, never gone (fleet core §7).
   export type ListedWorker = Worker & { offline: boolean };
   ```
2. In `FeedBody`, replace
   ```ts
     | { type: "WorkerAppeared"; worker: Worker; state: WorkerState; changedAt: number }
   ```
   with
   ```ts
     | { type: "WorkerAppeared"; worker: Worker; state: WorkerState; changedAt: number; offline: boolean }
   ```
   and replace its last member
   ```ts
     | { type: "WorkerNeedsYouChanged"; workerId: WorkerId; needsYou: boolean; waitingOn: string | null };
   ```
   with
   ```ts
     | { type: "WorkerNeedsYouChanged"; workerId: WorkerId; needsYou: boolean; waitingOn: string | null }
     | { type: "WorkerOfflineChanged"; workerId: WorkerId; offline: boolean };
   ```
3. Replace
   ```ts
   export type RosterEntry = Worker & WorkerDetails & { state: WorkerState; changedAt: number };
   ```
   with
   ```ts
   export type RosterEntry = Worker & WorkerDetails & { state: WorkerState; changedAt: number; offline: boolean };
   ```
4. In `Roster`, replace
   ```ts
     observeListing(listing: Worker[], now: number): FeedBody[] {
       const out: FeedBody[] = [];
       const seen = new Set<WorkerId>();
       for (const w of listing) {
         seen.add(w.id);
         const known = this.#workers.get(w.id);
         if (!known) {
           const entry: RosterEntry = { ...w, state: "quiet", changedAt: now, title: null, lastMessageAt: null, needsYou: false, waitingOn: null };
           this.#workers.set(w.id, entry);
           out.push({ type: "WorkerAppeared", worker: { ...w }, state: entry.state, changedAt: now });
         } else if (known.name !== w.name) {
           known.name = w.name;
           out.push({ type: "WorkerRenamed", workerId: w.id, name: w.name });
         }
       }
   ```
   with
   ```ts
     observeListing(listing: ListedWorker[], now: number): FeedBody[] {
       const out: FeedBody[] = [];
       const seen = new Set<WorkerId>();
       for (const { offline, ...w } of listing) {
         seen.add(w.id);
         const known = this.#workers.get(w.id);
         if (!known) {
           const entry: RosterEntry = { ...w, offline, state: "quiet", changedAt: now, title: null, lastMessageAt: null, needsYou: false, waitingOn: null };
           this.#workers.set(w.id, entry);
           out.push({ type: "WorkerAppeared", worker: { ...w }, state: entry.state, changedAt: now, offline });
         } else if (known.name !== w.name) {
           known.name = w.name;
           out.push({ type: "WorkerRenamed", workerId: w.id, name: w.name });
         }
         if (known && known.offline !== offline) {
           known.offline = offline;
           out.push({ type: "WorkerOfflineChanged", workerId: w.id, offline });
         }
       }
   ```
   The rest of the method (the `WorkerGone` loop) stays as it is.

In `packages/protocol/src/feed.ts`:

1. Replace
   ```ts
   // What a worker waits for (S6); a hub that doesn't say reads as waiting on nothing.
   const waitingOnField = orElse(z.nullable(text()), null);

   export const RosterEntrySchema = z.object({
     ...worker, title: z.nullable(text()), lastMessageAt: z.nullable(count()), needsYou: z.boolean(), waitingOn: waitingOnField, state, changedAt: count(),
   });
   ```
   with
   ```ts
   // What a worker waits for (S6); a hub that doesn't say reads as waiting on nothing.
   const waitingOnField = orElse(z.nullable(text()), null);
   // Its machine doesn't answer now (fleet core §7); a hub from before the fleet doesn't say: online.
   const offline = orElse(z.boolean(), false);

   export const RosterEntrySchema = z.object({
     ...worker, title: z.nullable(text()), lastMessageAt: z.nullable(count()), needsYou: z.boolean(), waitingOn: waitingOnField, state, changedAt: count(),
     offline,
   });
   ```
2. In `FeedBodySchema`, replace
   ```ts
     z.object({ type: z.literal("WorkerAppeared"), worker: z.object(worker), state, changedAt: count() }),
   ```
   with
   ```ts
     z.object({ type: z.literal("WorkerAppeared"), worker: z.object(worker), state, changedAt: count(), offline }),
   ```
   and after its last member
   ```ts
     z.object({ type: z.literal("WorkerNeedsYouChanged"), workerId: anyWorkerId, needsYou: z.boolean(), waitingOn: waitingOnField }),
   ```
   insert
   ```ts
     z.object({ type: z.literal("WorkerOfflineChanged"), workerId: anyWorkerId, offline: z.boolean() }),
   ```

In `apps/hub/src/application/observation-service.ts:172`, replace

```ts
      const bodies = this.#roster.observeListing(listing.map(w => ({ id: workerId(w.id), name: w.name, location: w.location, node: w.node })), now);
```

with

```ts
      const bodies = this.#roster.observeListing(listing.map(w => ({ id: workerId(w.id), name: w.name, location: w.location, node: w.node, offline: w.offline })), now);
```

(If Task 15 left that line in another form, keep it and add `offline: w.offline` to the object.)

In `apps/web/src/lib/feed.svelte.ts`, `#apply`:

1. Replace
   ```ts
           if (!find(b.worker.id)) this.workers.push({ ...b.worker, state: b.state, changedAt: b.changedAt, title: null, lastMessageAt: null, needsYou: false, waitingOn: null });
   ```
   with
   ```ts
           if (!find(b.worker.id)) this.workers.push({ ...b.worker, offline: b.offline, state: b.state, changedAt: b.changedAt, title: null, lastMessageAt: null, needsYou: false, waitingOn: null });
   ```
2. After the `WorkerRenamed` case
   ```ts
         case "WorkerRenamed": {
           const w = find(b.workerId);
           if (w) w.name = b.name;
           break;
         }
   ```
   insert
   ```ts
         case "WorkerOfflineChanged": {
           const w = find(b.workerId);
           if (w) w.offline = b.offline;
           break;
         }
   ```

Every `RosterEntry` literal gains `offline: false`:
- `apps/web/src/lib/gallery/data.ts:14`: replace `location: "%0", node: MARK, title: null,` with `location: "%0", node: MARK, offline: false, title: null,`;
- `apps/web/test/horizon.test.ts:15`: replace `location: "/work", node: "local", title: null,` with `location: "/work", node: "local", offline: false, title: null,`;
- `apps/web/test/lanes.test.ts:7`: replace `location: "demo", node: "local", title: null,` with `location: "demo", node: "local", offline: false, title: null,`.

- [ ] **Step 15b.4: Run them and see them pass; type-check**

Each command on its own:
- Run: `npx vitest run packages/domain packages/protocol apps/hub/test/observation-offline.test.ts apps/hub/test/observation-nodes.test.ts apps/hub/test/protocol-contract.test.ts apps/web/test/lanes.test.ts apps/web/test/horizon.test.ts apps/web/test/feed-frames.test.ts`
  Expected: PASS, every file. `observation.test.ts` has 2 more tests, `worker-offline.test.ts` runs 4 and `observation-offline.test.ts` runs 2.
- Run: `npm run check`
  Expected: exit 0. It proves the wire and the app agree:
  - `check<Same<z.output<typeof RosterEntrySchema>, RosterEntry>>` and the `FeedBody` check in `feed.ts` fail if the protocol and the domain differ on `offline`;
  - without the `feed.svelte.ts` case, svelte-check reports `Argument of type '{ type: "WorkerOfflineChanged"; … }' is not assignable to parameter of type 'never'` at `unreachable(b)`;
  - without a literal's `offline`, it reports `Property 'offline' is missing` (or `Type 'boolean | undefined' is not assignable to type 'boolean'` for the gallery).

- [ ] **Step 15b.5: Commit**

```bash
git add packages/domain/src/observation.ts packages/domain/test packages/protocol/src/feed.ts packages/protocol/test/worker-offline.test.ts apps/hub/src/application/observation-service.ts apps/hub/test/observation-offline.test.ts apps/web/src/lib/feed.svelte.ts apps/web/src/lib/gallery/data.ts apps/web/test/horizon.test.ts apps/web/test/lanes.test.ts
git commit -m "feat(observation): workers of a node that doesn't answer stay listed, marked offline"
```

#### Part B: the offline marker

- [ ] **Step 15b.6: Write the failing Chromium test (narrow and wide)**

In `apps/web/test/harness.ts`, replace

```ts
// at hello. Read and mute frames are told back, as the hub tells every feed.
export type FeedOptions = {
  workers: { id: string; name: string; lastMessageAt?: number }[];
```

with

```ts
// at hello. Read and mute frames are told back, as the hub tells every feed. A worker's `offline` goes into the snapshot.
export type FeedOptions = {
  workers: { id: string; name: string; lastMessageAt?: number; offline?: boolean }[];
```

(`fakeFeed` already spreads each worker into its roster entry; only the type changes.)

Create `apps/web/test/worker-offline-web.test.ts`:

```ts
// The offline marker (fleet core §7): a worker whose machine doesn't answer stays listed, with the word "offline", on the
// desktop's sidebar and in its conversation's header (wide) and in the phone's agents list (narrow). From the snapshot,
// then live as WorkerOfflineChanged events come, without a resync. The real Desktop, and the real Agents tab with the
// real LiveFeed, in headless Chromium; the hub faked at the browser's edge (harness.ts). Synthetic workers.
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

// The phone's Agents tab on its own, with its own LiveFeed as Phone.svelte gives it (Phone itself needs SvelteKit).
const PHONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import { LiveFeed } from "/src/lib/feed.svelte.ts";
  import Agents from "/src/lib/phone/Agents.svelte";
  const feed = new LiveFeed();
  feed.start();
  mount(Agents, { target: document.body, props: { feed, device: "phone-1" } });
</script></body></html>`;

const WORKERS = [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha", offline: true }, { id: "%2", name: "beta" }];
const change = (seq: number, workerId: string, offline: boolean) =>
  ({ t: "events", events: [{ epoch: "e1", seq, at: 1, body: { type: "WorkerOfflineChanged", workerId, offline } }] });

let desk: Web;
let phone: Web;
beforeAll(async () => { [desk, phone] = await Promise.all([startWeb(), startWeb(PHONE_PAGE)]); }, 60_000);
afterAll(async () => { await Promise.all([desk?.close(), phone?.close()]); });

async function open(web: Web, viewport: { width: number; height: number }) {
  const tab = await web.browser.newPage({ viewport });
  const errors: string[] = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.addInitScript(fakeFeed, { workers: WORKERS });
  await tab.goto(web.url);
  return { tab, errors };
}
const push = (tab: Page, m: unknown) => tab.evaluate(x => (globalThis as unknown as FeedWin).__feedPush(x), m);
const hellos = (tab: Page) => tab.evaluate(() => (globalThis as unknown as FeedWin).__feedSent.filter(m => (m as { t: string }).t === "hello").length);

describe("the offline marker", () => {
  it("wide: a sidebar row and the conversation's header say offline; live both ways, the manager's row too", { timeout: 30_000 }, async () => {
    const { tab, errors } = await open(desk, { width: 1600, height: 900 });
    const row = (name: string) => tab.locator("aside.side button.row", { hasText: name }).first();
    await row("beta").waitFor();
    expect(await row("alpha").innerText()).toContain("offline");
    expect(await row("beta").innerText()).not.toContain("offline");
    await row("alpha").click();
    await tab.locator(".state", { hasText: "Offline" }).waitFor({ timeout: 5000 });
    await push(tab, change(1, "%2", true));
    await row("beta").getByText("offline", { exact: true }).waitFor({ timeout: 5000 });
    await push(tab, change(2, "%1", false));
    await row("alpha").getByText("offline", { exact: true }).waitFor({ state: "detached", timeout: 5000 });
    await tab.locator(".state", { hasText: "Idle" }).waitFor({ timeout: 5000 });
    await push(tab, change(3, "%0", true));
    await row("Manager").getByText("offline", { exact: true }).waitFor({ timeout: 5000 });
    expect(await hellos(tab)).toBe(1);                                 // applied as events: no resync
    expect(errors).toEqual([]);
    await tab.close();
  });
  it("narrow: the phone's agents list says offline in place of its state; live both ways", { timeout: 30_000 }, async () => {
    const { tab, errors } = await open(phone, { width: 390, height: 844 });
    const when = (name: string) => tab.locator("ul.list button", { hasText: name }).first().locator(".when");
    await when("beta").waitFor();
    expect(await when("alpha").innerText()).toBe("offline");
    expect(await when("beta").innerText()).toMatch(/^quiet /);
    await push(tab, change(1, "%2", true));
    await expect.poll(() => when("beta").innerText(), { timeout: 5000 }).toBe("offline");
    await push(tab, change(2, "%1", false));
    await expect.poll(() => when("alpha").innerText(), { timeout: 5000 }).toMatch(/^quiet /);
    expect(await hellos(tab)).toBe(1);
    expect(errors).toEqual([]);
    await tab.close();
  });
});
```

- [ ] **Step 15b.7: Run it and see it fail**

Run: `npx vitest run apps/web/test/worker-offline-web.test.ts`

Expected: FAIL, 2 tests, both in the `chromium` project:
- wide: `AssertionError: expected 'alpha' to contain 'offline'`;
- narrow: `AssertionError: expected 'quiet …h' to be 'offline'` (the hours since `changedAt` 0).

- [ ] **Step 15b.8: Implement the marker**

In `apps/web/src/lib/desktop/Sidebar.svelte`:

1. Replace the header comment's two lines
   ```svelte
     // Slack's sidebar: 49px header (900 18px title), 28px filter (radius 8), 28px rows inset 8px (radius 6, 15px/28px),
     // section headings 500 15px with a caret. Sections here follow what agents do: the manager, working, idle.
   ```
   with
   ```svelte
     // Slack's sidebar: 49px header (900 18px title), 28px filter (radius 8), 28px rows inset 8px (radius 6, 15px/28px),
     // section headings 500 15px with a caret. Sections here follow what agents do: the manager, working, idle.
     // A worker whose machine doesn't answer keeps its row, with a plug icon and the word "offline" (fleet core §7;
     // COLOR.md 2: an icon plus the state in words).
   ```
2. After `import Signpost from "@lucide/svelte/icons/signpost";`, insert:
   ```svelte
     import Unplug from "@lucide/svelte/icons/unplug";
   ```
   (`@lucide/svelte` 1.49.0, already a dependency, ships `icons/unplug`: `node_modules/@lucide/svelte/dist/icons/unplug.svelte`.)
3. In the manager's row, replace
   ```svelte
             <span class="nm">Manager</span>
   ```
   with
   ```svelte
             <span class="nm">Manager</span>
             {#if manager.offline}<span class="off">offline</span>{/if}
   ```
4. In each section's rows, replace
   ```svelte
                 <span class="ic">{#if w.state === "active"}<i class="spin"></i>{:else}<Hash size={16} />{/if}</span>
                 <span class="nm">{w.name}</span>
   ```
   with
   ```svelte
                 <span class="ic">{#if w.offline}<Unplug size={16} />{:else if w.state === "active"}<i class="spin"></i>{:else}<Hash size={16} />{/if}</span>
                 <span class="nm">{w.name}</span>
                 {#if w.offline}<span class="off">offline</span>{/if}
   ```
5. In `<style>`, after the `.badge { … }` rule (it ends `font: 700 12px/18px var(--font); text-align: center; flex: none;` and `}`), insert:
   ```css
     /* Muted text, which a tinted row turns to full text (COLOR.md 8); a needs-you badge follows it. */
     .off { margin-left: auto; font: 400 12px/18px var(--font); color: var(--muted); flex: none; }
     .off + .badge { margin-left: 0; }
   ```

In `apps/web/src/lib/desktop/ChannelView.svelte`:

1. `:46`: replace
   ```ts
     const stateLabel = $derived(worker.needsYou ? "Needs you" : worker.state === "active" ? "Working" : "Idle");
   ```
   with
   ```ts
     const stateLabel = $derived(worker.offline ? "Offline" : worker.needsYou ? "Needs you" : worker.state === "active" ? "Working" : "Idle");
   ```
2. `:59`: replace
   ```svelte
         <span class="state {worker.needsYou ? 'needs' : worker.state}">{stateLabel}</span>
   ```
   with
   ```svelte
         <span class="state {worker.offline ? 'offline' : worker.needsYou ? 'needs' : worker.state}">{stateLabel}</span>
   ```
   `.state.offline` has no rule of its own: it keeps the neutral chip (`--muted-bg` with full text).

In `apps/web/src/lib/phone/Agents.svelte`:

1. Replace
   ```svelte
             <button onclick={() => open(w.id)}>
               <span class="dot {w.state}" aria-hidden="true"></span>
               <span class="name">{w.name}</span>
               <span class="where muted">{w.location}</span>
               {#if w.needsYou}<span class="when needs">needs you</span>
   ```
   with
   ```svelte
             <button class:offline={w.offline} onclick={() => open(w.id)}>
               <span class="dot {w.offline ? 'offline' : w.state}" aria-hidden="true"></span>
               <span class="name">{w.name}</span>
               <span class="where muted">{w.location}</span>
               {#if w.offline}<span class="when muted">offline</span>
               {:else if w.needsYou}<span class="when needs">needs you</span>
   ```
   The next line (`{:else}<span class="when muted">…</span>{/if}`) stays. The dot's `offline` class has no rule: it is the plain grey dot, without the active pulse.
2. In `<style>`, after
   ```css
     .when.needs { color: var(--danger-text); font-weight: 700; }
   ```
   insert
   ```css
     /* Its machine doesn't answer (fleet core §7): the name in muted text, no pulse, "offline" in place of its state.
        Muted, not faded (phone.css: no opacity); the tinted row turns it to full text (COLOR.md 8). */
     .offline .name { color: var(--muted); }
   ```

The state gallery gets an offline row:
- `apps/web/src/lib/gallery/data.ts:18`: replace `// Sidebar rows: unread, muted, selected, needs-you, working, idle, starred.` with `// Sidebar rows: unread, muted, selected, needs-you, working, idle, starred, offline.`;
- after `    worker("release", { title: "Release notes (starred)", lastMessageAt: now - 2 * HOUR }),` (the last entry of `workers`), insert:
  ```ts
      worker("nightly", { title: "Nightly build (offline)", offline: true, lastMessageAt: now - 4 * HOUR }),
  ```
- `apps/web/src/lib/gallery/Gallery.svelte:66`: replace `<h2>Sidebar rows: needs you, unread, muted, selected, starred, working, idle</h2>` with `<h2>Sidebar rows: needs you, unread, muted, selected, starred, working, idle, offline</h2>`;
- `apps/web/src/lib/gallery/Gallery.svelte:131`: replace `.side { width: 260px; height: 520px;` with `.side { width: 260px; height: 560px;`. One more 28px row; every row stays on screen, none scrolled away.

- [ ] **Step 15b.9: Run it and see it pass; the gallery; type-check**

Each command on its own:
- Run: `npx vitest run apps/web/test/worker-offline-web.test.ts apps/web/test/feed-frames.test.ts apps/web/test/lanes.test.ts apps/web/test/composer-target.test.ts apps/web/test/reading-web.test.ts`
  Expected: PASS, every file; `worker-offline-web.test.ts` runs 2 tests in the `chromium` project.
- Run: `E2E_OUT=$(mktemp -d) node e2e/gallery.e2e.ts`
  Expected: `5/5 checks passed`. In `g-light-sidebar.png` and `g-dark-sidebar.png`, "nightly" has the plug icon and "offline" at the right, and "onboarding" is still fully on screen below it.
- Run: `npm run check`
  Expected: exit 0.

- [ ] **Step 15b.10: Commit**

```bash
git add apps/web/src/lib/desktop/Sidebar.svelte apps/web/src/lib/desktop/ChannelView.svelte apps/web/src/lib/phone/Agents.svelte apps/web/src/lib/gallery/data.ts apps/web/src/lib/gallery/Gallery.svelte apps/web/test/harness.ts apps/web/test/worker-offline-web.test.ts
git commit -m "feat(web): offline marker on the sidebar, the conversation header and the phone's agents list"
```

- [ ] **Step 15b.11: Negative control: the marker removed**

Two controls, one per layout, each one edit (so `scripts/negative-controls.ts` can run them, Task 18), each restored before the next:
- In `apps/web/src/lib/desktop/Sidebar.svelte`, delete the row's line `              {#if w.offline}<span class="off">offline</span>{/if}`, run `npx vitest run apps/web/test/worker-offline-web.test.ts`, and restore with `git checkout HEAD -- apps/web/src/lib/desktop/Sidebar.svelte`. Expected: FAIL, 1 test (1 passes), "wide: …": `AssertionError: expected 'alpha' to contain 'offline'`.
- In `apps/web/src/lib/phone/Agents.svelte`, replace `{#if w.offline}<span class="when muted">offline</span>` and the line after it, `            {:else if w.needsYou}`, with `{#if w.needsYou}`, run the same, and restore with `git checkout HEAD -- apps/web/src/lib/phone/Agents.svelte`. Expected: FAIL, 1 test (1 passes), "narrow: …": `AssertionError: expected 'quiet …h' to be 'offline'` (the hours since `changedAt` 0).

Then `git status --short` prints nothing.

#### Part C: Check again on an uncertain send

- [ ] **Step 15b.12: Write the failing tests**

In `apps/web/test/outbox-state.test.ts`, replace

```ts
  it("Uncertain stays Uncertain: no retry, no late success", () => {
    expect(advance("sending", "uncertain")).toBe("uncertain");
    expect(advance("uncertain", "sent")).toBe("uncertain");
    expect(advance("uncertain", "queued", true)).toBe("uncertain");
  });
```

with

```ts
  it("Uncertain moves only to what Check again finds: Sent (typed then or now) or Not sent (never typed, refused now)", () => {
    expect(advance("sending", "uncertain")).toBe("uncertain");
    expect(advance("uncertain", "queued", true)).toBe("uncertain");
    expect(advance("uncertain", "sending")).toBe("uncertain");
    expect(advance("uncertain", "queued")).toBe("uncertain");
    expect(advance("uncertain", "sent")).toBe("sent");
    expect(advance("uncertain", "failed")).toBe("failed");
  });
```

and replace

```ts
  it("offers Retry only for Not sent, and only while a full 2 minutes would still end inside the hub's record (L1)", () => {
    expect(canRetry(rec("a", 0, "x", "failed"), RETRY_WINDOW_MS - 1)).toBe(true);
    expect(canRetry(rec("a", 0, "x", "failed"), RETRY_WINDOW_MS)).toBe(false);
    expect(RETRY_WINDOW_MS).toBeLessThanOrEqual(HUB_KEEPS_MS - BUDGET_MS);
    expect(canRetry(rec("a", 0, "x", "uncertain"), 1)).toBe(false);
    expect(canRetry(rec("a", 0, "x", "sent"), 1)).toBe(false);
  });
```

with

```ts
  it("offers Retry for Not sent and Check again for Uncertain, only while a full 2 minutes would still end inside the hub's record (L1)", () => {
    expect(canRetry(rec("a", 0, "x", "failed"), RETRY_WINDOW_MS - 1)).toBe(true);
    expect(canRetry(rec("a", 0, "x", "failed"), RETRY_WINDOW_MS)).toBe(false);
    expect(RETRY_WINDOW_MS).toBeLessThanOrEqual(HUB_KEEPS_MS - BUDGET_MS);
    expect(canRetry(rec("a", 0, "x", "uncertain"), RETRY_WINDOW_MS - 1)).toBe(true);
    expect(canRetry(rec("a", 0, "x", "uncertain"), RETRY_WINDOW_MS)).toBe(false);
    expect(canRetry(rec("a", 0, "x", "sent"), 1)).toBe(false);
  });
```

In `apps/web/test/outbox.test.ts`:

1. Replace the import `import type { OutboxRecord } from "../src/lib/outbox/state.ts";` with:
   ```ts
   import { ATTEMPT_TIMEOUT_MS, RETRY_WINDOW_MS, type OutboxRecord } from "../src/lib/outbox/state.ts";
   ```
2. Replace
   ```ts
     it("uncertain is final, and Retry doesn't move it", async () => {
       answer = async () => ({ kind: "uncertain" });
       const o = outbox();
       const r = await o.enqueue(cmd());
       await flush();
       await o.retry(r.id);
       await advance(10_000);
       expect(posts).toHaveLength(1);
       expect(state(o, r.id)?.state).toBe("uncertain");
     });
   ```
   with
   ```ts
     it("uncertain is never sent again on its own, and holds what was written after it", async () => {
       answer = async (_r, attempt) => (attempt === 1 ? { kind: "uncertain" } : { kind: "typed" });
       const o = outbox();
       const r = await o.enqueue(cmd("%1", "first"));
       await o.enqueue(cmd("%1", "second"));
       await advance(10 * 60_000);
       expect(posts.map(p => p.id)).toEqual([r.id]);
       expect(state(o, r.id)).toMatchObject({ state: "uncertain", error: "uncertain" });
     });
     // Check again (fleet core §3.1, §7): the same request id once more, so the hub asks the worker's machine (op.status).
     it("Check again sends the same request id once; typed then or now, it is Sent with that time, and what waited goes", async () => {
       answer = async (r, attempt) => (r.text === "first" && attempt === 1 ? { kind: "uncertain" } : { kind: "typed", at: T0 - 42 });
       const o = outbox();
       const r = await o.enqueue(cmd("%1", "first"));
       const b = await o.enqueue(cmd("%1", "second"));
       await advance(10_000);
       await o.retry(r.id);
       await flush();
       expect(posts.map(p => p.id)).toEqual([r.id, r.id, b.id]);
       expect(state(o, r.id)).toMatchObject({ state: "sent", typedAt: T0 - 42, error: null, sentAt: T0 + 10_000 });
       expect(state(o, b.id)?.state).toBe("sent");
     });
     it.each<[string, PostOutcome]>([
       ["still uncertain (409)", { kind: "uncertain" }],
       ["500 internal error", { kind: "refused", code: "internal error", status: 500 }],
       ["502 from a proxy", { kind: "refused", code: "bad_gateway", status: 502 }],
       ["a refusal with no status", { kind: "refused", code: "no_pane" }],
       ["no answer", { kind: "unanswered" }],
       ["wait", { kind: "wait", ms: 1000 }],
     ])("Check again answered %s leaves it Uncertain, sent once, not again on its own", async (_name, second) => {
       answer = async (_r, attempt) => (attempt === 1 ? { kind: "uncertain" } : second);
       const o = outbox();
       const r = await o.enqueue(cmd());
       await flush();
       await o.retry(r.id);
       await advance(10 * 60_000);
       expect(posts.map(p => p.id)).toEqual([r.id, r.id]);
       expect(state(o, r.id)).toMatchObject({ state: "uncertain", error: "uncertain" });
     });
     // The hub answers a repeat in doubt before it judges anything else; a refusal means its machine never had it and the
     // hub refused it now: nothing was typed (fleet core §3.1). Not sent, with the refusal's words, and Retry.
     it.each<[string, PostOutcome]>([
       ["409 stale", { kind: "refused", code: "stale", status: 409 }],
       ["409 menu_open", { kind: "refused", code: "menu_open", status: 409 }],
       ["409 node_offline", { kind: "refused", code: "node_offline", status: 409 }],
       ["404 no_pane", { kind: "refused", code: "no_pane", status: 404 }],
       ["403 step_up", { kind: "refused", code: "step_up", status: 403 }],
     ])("Check again answered %s: Not sent with that reason, held what came after, and Retry sends the same id", async (_name, second) => {
       answer = async (r, attempt) => (r.text !== "first" ? { kind: "typed" } : attempt === 1 ? { kind: "uncertain" } : attempt === 2 ? second : { kind: "typed" });
       const o = outbox();
       const r = await o.enqueue(cmd("%1", "first"));
       const b = await o.enqueue(cmd("%1", "second"));
       await flush();
       await o.retry(r.id);
       await advance(60_000);                                             // inside the 2 minutes: nothing goes on its own
       expect(posts.map(p => p.id)).toEqual([r.id, r.id]);
       expect(state(o, r.id)).toMatchObject({ state: "failed", error: (second as { code: string }).code });
       expect(state(o, b.id)?.state).toBe("queued");                       // still held behind the Not sent one
       await o.retry(r.id);
       await advance(10_000);
       expect(posts.map(p => p.id)).toEqual([r.id, r.id, r.id, b.id]);
       expect(state(o, r.id)?.state).toBe("sent");
     });
     it("Check again only one at a time, and only while the hub still holds its record (L1)", async () => {
       answer = async (_r, attempt) => (attempt === 1 ? { kind: "uncertain" } : new Promise<PostOutcome>(() => {}));
       const o = outbox();
       const r = await o.enqueue(cmd());
       await flush();
       void o.retry(r.id);
       void o.retry(r.id);
       await flush();
       expect(posts).toHaveLength(2);                                     // the second press finds one in flight
       await advance(ATTEMPT_TIMEOUT_MS);                                 // given up: still Uncertain
       expect(state(o, r.id)?.state).toBe("uncertain");
       vi.setSystemTime(T0 + RETRY_WINDOW_MS);
       await o.retry(r.id);
       await flush();
       expect(posts).toHaveLength(2);
     });
   ```

In `apps/web/test/outbox-words.test.ts`, before `  it("a message held behind a Not sent one says so, not Queued", () => {`, insert:

```ts
  it("an Uncertain send says it may have gone, and what Check again does (fleet core §7)", () => {
    const r = rec("u", { state: "uncertain", error: "uncertain" });
    expect(sendLabel(r, [r], 2000)).toBe("May have been sent");
    expect(sendReason(r, "builder")).toBe("May have been sent: the hub lost touch while typing it. Check again asks whether it went in, and sends it if it didn't; it is never typed twice.");
  });
```

In `apps/web/test/outbox-web.test.ts`:

1. Replace the header's last line `// the hub's "stale" and "uncertain" answers.` with:
   ```ts
   // the hub's "stale" and "uncertain" answers, and Check again on an uncertain one (fleet core §3.1, §7).
   ```
2. Replace `type Answer = "ok" | "hang" | "stale" | "uncertain" | "step_up";` with:
   ```ts
   // "maybe": the worker's machine typed it, but the hub lost touch before it could say so (409 uncertain); a repeat of
   // the same request id then answers "duplicate", as the hub's op.status path does. "error": the hub threw (500).
   type Answer = "ok" | "hang" | "stale" | "uncertain" | "step_up" | "maybe" | "error";
   ```
   and in `fakeSend`, after `    if (answer === "step_up") return json({ error: "step_up" }, 403);`, insert:
   ```ts
       if (answer === "error") return json({ error: "internal error" }, 500);
   ```
3. In `fakeSend`, after the line that pushes the echo (`w.__feedPush({ t: "messages", worker: decodeURIComponent(m[1] ?? ""), messages: [{ id: \`echo-${body.requestId}\`, …`), insert before `return json({ ok: true });`:
   ```ts
       if (answer === "maybe") return json({ error: "uncertain" }, 409);
   ```
4. Replace the test
   ```ts
     it("uncertain: may have been sent, Discard only, and nothing is retried", { timeout: 30_000 }, async () => {
       await openAlpha();
       await answers(["uncertain"]);
       await write("did it go?");
       const e = entry("did it go?");
       await e.getByText(/May have been sent/).first().waitFor();
       expect(await e.getByRole("button", { name: "Retry" }).count()).toBe(0);
       await tab.waitForTimeout(2000);
       expect(await page(() => (globalThis as unknown as SendWin).__posts.length)).toBe(1);
       await e.getByRole("button", { name: "Discard" }).click();
       await entry("did it go?").waitFor({ state: "detached" });
     });
   ```
   with
   ```ts
     it("uncertain: may have been sent, Check again or Discard, and nothing is sent again on its own", { timeout: 30_000 }, async () => {
       await openAlpha();
       await answers(["uncertain"]);
       await write("did it go?");
       const e = entry("did it go?");
       await e.getByText(/May have been sent/).first().waitFor();
       expect(await e.getByRole("button", { name: "Retry" }).count()).toBe(0);
       expect(await e.getByRole("button", { name: "Check again" }).count()).toBe(1);
       await tab.waitForTimeout(2000);
       expect(await page(() => (globalThis as unknown as SendWin).__posts.length)).toBe(1);
       await e.getByRole("button", { name: "Discard" }).click();
       await entry("did it go?").waitFor({ state: "detached" });
     });
     const sent = () => page(() => { const w = globalThis as unknown as SendWin; return { posts: w.__posts.map(p => p.requestId), typed: w.__typed.length }; });
     it("Check again: the machine had typed it, so the hub says duplicate; Sent and ended by its echo, typed once", { timeout: 30_000 }, async () => {
       await openAlpha();
       await answers(["maybe"]);
       await write("did it land?");
       const e = entry("did it land?");
       await e.getByRole("button", { name: "Check again" }).click({ timeout: 10_000 });
       await e.waitFor({ state: "detached", timeout: 10_000 });             // Sent, then ended by the echo already shown
       await echoed("did it land?").waitFor();
       const s = await sent();
       expect(s.posts).toHaveLength(2);
       expect(new Set(s.posts).size).toBe(1);                               // the same request id
       expect(s.typed).toBe(1);
       expect(errors).toEqual([]);
     });
     it("Check again: the machine never had it, so the hub types it now; Sent and echoed, typed once", { timeout: 30_000 }, async () => {
       await openAlpha();
       await answers(["uncertain"]);
       await write("never arrived");
       await entry("never arrived").getByRole("button", { name: "Check again" }).click({ timeout: 10_000 });
       await echoed("never arrived").waitFor({ timeout: 10_000 });
       await entry("never arrived").waitFor({ state: "detached" });
       const s = await sent();
       expect(s.posts).toHaveLength(2);
       expect(new Set(s.posts).size).toBe(1);
       expect(s.typed).toBe(1);
     });
     it("Check again: still not sure, so it stays May have been sent, with Check again, and nothing is typed", { timeout: 30_000 }, async () => {
       await openAlpha();
       await answers(["uncertain", "uncertain"]);
       await write("still unsure");
       const e = entry("still unsure");
       await e.getByRole("button", { name: "Check again" }).click({ timeout: 10_000 });
       await tab.waitForFunction(() => (globalThis as unknown as SendWin).__posts.length === 2);
       await tab.waitForTimeout(1000);
       expect(await e.getAttribute("data-state")).toBe("uncertain");
       expect(await e.getByRole("button", { name: "Check again" }).count()).toBe(1);
       const s = await sent();
       expect(new Set(s.posts).size).toBe(1);
       expect(s.typed).toBe(0);
     });
     it("Check again: the machine never had it and the hub refused it now (409 stale): Not sent, its words, Edit", { timeout: 30_000 }, async () => {
       await openAlpha();
       await answers(["uncertain", "stale"]);
       await write("never typed");
       const e = entry("never typed");
       await e.getByRole("button", { name: "Check again" }).click({ timeout: 10_000 });
       await e.getByText("The question changed: review before sending.").waitFor({ timeout: 10_000 });
       expect(await e.getAttribute("data-state")).toBe("failed");
       expect(await e.getByText("Not sent", { exact: true }).count()).toBe(1);
       expect(await e.getByRole("button", { name: "Edit" }).count()).toBe(1);   // as any stale refusal: review it first
       const s = await sent();
       expect(s.posts).toHaveLength(2);
       expect(new Set(s.posts).size).toBe(1);
       expect(s.typed).toBe(0);
       expect(errors).toEqual([]);
     });
     it("Check again: the hub threw (500), which says nothing: it stays May have been sent, with Check again", { timeout: 30_000 }, async () => {
       await openAlpha();
       await answers(["uncertain", "error"]);
       await write("hub threw");
       const e = entry("hub threw");
       await e.getByRole("button", { name: "Check again" }).click({ timeout: 10_000 });
       await tab.waitForFunction(() => (globalThis as unknown as SendWin).__posts.length === 2);
       await tab.waitForTimeout(1000);
       expect(await e.getAttribute("data-state")).toBe("uncertain");
       expect(await e.getByRole("button", { name: "Check again" }).count()).toBe(1);
       expect((await sent()).typed).toBe(0);
     });
   ```

The fake answers a repeat of a typed id with `{ error: "duplicate", ok: true }` (no `at`), as before; `typedAt` from a `duplicate`'s `at` is checked in `outbox.test.ts`.

Create `apps/web/test/update-card-check-web.test.ts`:

```ts
// The phone's update card offers Check again on an Uncertain reply, as the desktop does (fleet core §7; outbox/words.ts):
// it says what Check again does, has no Retry, and hands the entry's own id to the outbox's retry (Phone.svelte wires
// onRetry to outbox.retry). The real UpdateCard in headless Chromium at a phone's size; synthetic data only.
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import UpdateCard from "/src/lib/phone/UpdateCard.svelte";
  const now = Date.now();
  const view = { worker: "%1", name: "alpha", mark: null, messages: [], count: 1, firstAt: now - 60_000, lastAt: now - 60_000, tools: 0, toolNames: [], files: 0, claim: null };
  const reply = { id: "00000000-0000-4000-8000-000000000001", worker: "%1", workerName: "alpha", text: "did it go?", uploads: [], createdAt: now - 30_000,
    budgetFrom: now - 30_000, state: "uncertain", error: "uncertain", attempts: 1, seen: "none", sentAt: null, typedAt: null };
  globalThis.__retried = [];
  const noop = () => {};
  mount(UpdateCard, { target: document.body, props: { worker: null, name: "alpha", view, mark: null, now, outgoing: [reply], loading: false, note: null,
    onReply: async () => true, onOpen: noop, onRetry: id => globalThis.__retried.push(id), onDiscard: noop, onVerify: noop } });
</script></body></html>`;

let web: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });

describe("an Uncertain reply on the phone's update card", () => {
  it("says what Check again does, offers it and not Retry, and Check again retries that entry's id", { timeout: 30_000 }, async () => {
    tab = await web.browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message));
    await tab.goto(web.url);
    const row = tab.locator('[data-outgoing="uncertain"]', { hasText: "did it go?" });
    await row.getByText("Check again asks whether it went in").waitFor({ timeout: 10_000 });
    expect(await row.getByRole("button", { name: "Retry" }).count()).toBe(0);
    await row.getByRole("button", { name: "Check again" }).click({ timeout: 10_000 });
    expect(await tab.evaluate(() => (globalThis as unknown as { __retried: string[] }).__retried)).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(errors).toEqual([]);
    await tab.close();
  });
});
```

- [ ] **Step 15b.13: Run them and see them fail**

Run: `npx vitest run apps/web/test/outbox-state.test.ts apps/web/test/outbox.test.ts apps/web/test/outbox-words.test.ts apps/web/test/outbox-web.test.ts apps/web/test/update-card-check-web.test.ts`

Expected: FAIL, 5 files, 23 tests (47 pass):
- `outbox-state` (2): "Uncertain moves only to what Check again finds…": `expected 'uncertain' to be 'sent'`; "offers Retry … and Check again …": `expected false to be true`.
- `outbox-words` (1): `expected 'May have been sent: the hub stopped w…' to be 'May have been sent: the hub lost touc…'`.
- `outbox` (13): "Check again sends the same request id once…": `expected [ Array(1) ] to deeply equal [ …(3) ]`; the six "Check again answered … leaves it Uncertain" and the five "Check again answered … Not sent with that reason…": `expected [ Array(1) ] to deeply equal [ …(2) ]`; "Check again only one at a time…": `expected [ { …(4) } ] to have a length of 2 but got 1`.
- `outbox-web` (6, chromium): "uncertain: may have been sent, Check again or Discard…": `expected +0 to be 1`; the five "Check again: …": `TimeoutError: locator.click: Timeout 10000ms exceeded.`
- `update-card-check-web` (1, chromium): `TimeoutError: locator.waitFor: Timeout 10000ms exceeded.` (the old words).

"uncertain is never sent again on its own…" passes already: it guards what stays.

- [ ] **Step 15b.14: Implement Check again**

In `apps/web/src/lib/outbox/state.ts`:

1. Replace
   ```ts
   // Forward only (S8): queued < sending < sent. Failed may come from queued or sending, never from sent; uncertain is
   // the hub's word on a send it may have typed, and nothing but Discard leaves it. The one way back is the principal's
   // Retry: failed to queued (`retry`).
   ```
   with
   ```ts
   // Forward only (S8): queued < sending < sent. Failed may come from queued or sending, never from sent; uncertain is
   // the hub's word on a send it may have typed, and only Check again leaves it (fleet core §3.1): to Sent (the hub found
   // it typed, or typed it now), or to Not sent (the hub judged it anew and refused it: nothing was typed). The one way
   // back is the principal's Retry: failed to queued (`retry`).
   ```
2. In `advance`, replace `  if (from === "uncertain") return from;` with:
   ```ts
     if (from === "uncertain") return to === "sent" || to === "failed" ? to : from;
   ```
3. Replace
   ```ts
   export const canRetry = (r: OutboxRecord, now: number) => r.state === "failed" && now - r.createdAt < RETRY_WINDOW_MS;
   ```
   with
   ```ts
   // Retry on Not sent, Check again on Uncertain: the same request id both times, so the hub types it at most once (S5).
   export const canRetry = (r: OutboxRecord, now: number) => (r.state === "failed" || r.state === "uncertain") && now - r.createdAt < RETRY_WINDOW_MS;
   ```

In `apps/web/src/lib/outbox/outbox.ts`:

1. In `PostOutcome`, replace `  | { kind: "refused"; code: string }` with:
   ```ts
     | { kind: "refused"; code: string; status?: number }   // status: the hub's HTTP status, when it answered one
   ```
2. Before `export type Timers = {`, insert:
   ```ts
   // A refusal that says nothing was typed, then or now (fleet core §3.1). The hub answers a repeat of a request in doubt
   // before it judges anything else: 409 uncertain while the worker's machine can't say, a 5xx when it threw. Only once the
   // machine said it never had it does the hub judge the send anew, and then a 404 no_pane, a 403 step_up or any other 409
   // is a refusal of a send that was never typed. A 5xx, a 429 or a refusal without a status says nothing of the kind.
   export const definiteRefusal = (o: Extract<PostOutcome, { kind: "refused" }>) =>
     o.status === 409 || (o.status === 404 && o.code === "no_pane") || (o.status === 403 && o.code === "step_up");

   ```
3. Replace

```ts
  // The principal's Retry (S7, S8): only Not sent, only within the Retry window; the same id, and a fresh 2 minutes.
  async retry(id: string) {
    const r = this.#records.get(id);
    if (!r || !canRetry(r, this.#timers.now())) return;
    if (!(await this.#save({ ...r, state: advance(r.state, "queued", true), error: null, budgetFrom: this.#timers.now() }))) return;
    this.#kick(r.worker);
  }
```

with

```ts
  // The principal's Retry (S7, S8): only Not sent, only within the Retry window; the same id, and a fresh 2 minutes.
  // On an Uncertain one it is Check again (#check).
  async retry(id: string) {
    const r = this.#records.get(id);
    if (!r || !canRetry(r, this.#timers.now())) return;
    if (r.state === "uncertain") return this.#check(id);
    if (!(await this.#save({ ...r, state: advance(r.state, "queued", true), error: null, budgetFrom: this.#timers.now() }))) return;
    this.#kick(r.worker);
  }

  // Check again (fleet core §3.1, §7): one POST of the same request id. The hub asks the worker's machine whether it
  // typed it, and types it now if it never got it; either way it answers ok, and the entry is Sent with the machine's
  // time. A definite refusal (definiteRefusal) means the hub found it never typed and refused it now: Not sent, with
  // that refusal's words, and Retry. Any other answer, or none, leaves it Uncertain, and it is never sent again on its
  // own. Any tab may ask: the hub types a request id at most once (S5).
  async #check(id: string) {
    if (this.#inFlight.has(id) || this.#stopped) return;
    const outcome = await this.#attempt(id, ATTEMPT_TIMEOUT_MS);
    const r = this.#records.get(id);
    if (!r) return;
    if (outcome.kind === "refused" && definiteRefusal(outcome)) {
      await this.#save({ ...r, state: advance(r.state, "failed"), error: outcome.code });
      return;
    }
    if (outcome.kind !== "typed") return;
    if (!(await this.#save({ ...r, state: advance(r.state, "sent"), sentAt: this.#timers.now(), typedAt: outcome.at ?? null, error: null }))) return;
    this.#kick(r.worker);                                             // what was written after it goes now
  }
```

A Not sent entry holds what was written after it, as any Not sent one does (`heldBehind`); its own Retry, Edit or Verify sends the same id again.

In `apps/web/src/lib/outbox/device.ts`, `post()`'s last line, replace `    return { kind: "refused", code: e.code };` with:

```ts
    return { kind: "refused", code: e.code, status: e.status };
```

`#attempt` already registers the POST in `#inFlight`, so a second press while one is out does nothing, and Discard aborts it. Once Sent, the conversation's echo ends the entry as for any Sent one: `Desktop.svelte`'s echo effect and `CatchUp.svelte`'s `onEchoes` read `outgoing`, which changed.

In `apps/web/src/lib/outbox/words.ts`, replace

```ts
  uncertain: "May have been sent: the hub stopped while typing it. Check the conversation.",
```

with

```ts
  // The hub stopped, or lost the worker's machine, while typing it (fleet core §7).
  uncertain: "May have been sent: the hub lost touch while typing it. Check again asks whether it went in, and sends it if it didn't; it is never typed twice.",
```

The button, where each list already offers Retry:
- `apps/web/src/lib/desktop/MessageList.svelte:264`: replace
  ```svelte
              {:else if canRetry(p, clockNow)}<button onclick={() => onRetry(p.id)}>Retry</button>{/if}
  ```
  with
  ```svelte
              {:else if canRetry(p, clockNow)}<button onclick={() => onRetry(p.id)}>{p.state === "uncertain" ? "Check again" : "Retry"}</button>{/if}
  ```
- `apps/web/src/lib/phone/UpdateCard.svelte:112`: replace
  ```svelte
                  {:else if canRetry(o, now)}<button class="pbtn small" onclick={() => onRetry(o.id)}>Retry</button>{/if}
  ```
  with
  ```svelte
                  {:else if canRetry(o, now)}<button class="pbtn small" onclick={() => onRetry(o.id)}>{o.state === "uncertain" ? "Check again" : "Retry"}</button>{/if}
  ```

- [ ] **Step 15b.15: Run them and see them pass; the gallery; type-check and lint**

Each command on its own:
- Run: `npx vitest run apps/web/test/outbox-state.test.ts apps/web/test/outbox.test.ts apps/web/test/outbox-words.test.ts apps/web/test/outbox-web.test.ts apps/web/test/update-card-check-web.test.ts apps/web/test/composer-retry.test.ts`
  Expected: PASS, every file. 6 files, 78 tests; `outbox-web` runs 17 and `update-card-check-web` 1, in the `chromium` project.
- Run: `E2E_OUT=$(mktemp -d) node e2e/gallery.e2e.ts`
  Expected: `5/5 checks passed`. In `g-light-sends.png` the uncertain row shows the new words, then "Check again" and "Discard".
- Run: `npm run check`
  Expected: exit 0.
- Run: `npm run lint`
  Expected: exit 0, no findings (the stylish format prints nothing when clean).

- [ ] **Step 15b.16: Commit**

```bash
git add apps/web/src/lib/outbox/state.ts apps/web/src/lib/outbox/outbox.ts apps/web/src/lib/outbox/device.ts apps/web/src/lib/outbox/words.ts apps/web/src/lib/desktop/MessageList.svelte apps/web/src/lib/phone/UpdateCard.svelte apps/web/test/outbox-state.test.ts apps/web/test/outbox.test.ts apps/web/test/outbox-words.test.ts apps/web/test/outbox-web.test.ts apps/web/test/update-card-check-web.test.ts
git commit -m "feat(web): Check again on an uncertain send, with the same request id"
```

- [ ] **Step 15b.17: Negative control: Check again as a new send, with a new request id**

Make Check again discard the entry and write the same text down again, under a new id. Run, then restore:
```bash
node -e '
const fs = require("fs"), f = "apps/web/src/lib/outbox/outbox.ts", s = fs.readFileSync(f, "utf8");
const old = "if (r.state === \"uncertain\") return this.#check(id);";
if (!s.includes(old)) throw new Error("line not found");
fs.writeFileSync(f, s.replace(old, "if (r.state === \"uncertain\") { await this.discard(id); await this.enqueue({ worker: r.worker, workerName: r.workerName, text: r.text, uploads: r.uploads, seen: r.seen }); return; }"));'
npx vitest run apps/web/test/outbox.test.ts apps/web/test/outbox-web.test.ts
git checkout HEAD -- apps/web/src/lib/outbox/outbox.ts
git diff --stat
```
Expected: FAIL, 2 files, 18 tests (32 pass):
- `outbox` (13): "Check again sends the same request id once…": `expected [ …(3) ] to deeply equal [ …(3) ]` (a new id in the second place); the six "… leaves it Uncertain…": `expected [ …(2) ] to deeply equal [ …(2) ]`; the five "… Not sent with that reason…": `expected [ …(3) ] to deeply equal [ …(2) ]`; "Check again only one at a time…": `expected undefined to be 'uncertain'` (the entry is gone);
- `outbox-web` (5, chromium):
  - "the machine had typed it": `strict mode violation: locator('article.msg:not(.pending)').filter({ hasText: 'did it land?' }) resolved to 2 elements` (typed twice: two echoes);
  - "the machine never had it", "still not sure" and "the hub refused it now (409 stale)": `expected 2 to be 1` (two request ids);
  - "the hub threw (500)": `expected 'failed' to be 'uncertain'` (the new entry's own 500 is a refusal).

Then `git diff --stat` prints nothing. (Passing the whole entry to `enqueue` would not be a control: `enqueue` spreads it after its new id, so the old id wins.)

Then the second control, on what counts as a definite refusal: every refusal taken as one, a 5xx included.
```bash
node -e '
const fs = require("fs"), f = "apps/web/src/lib/outbox/outbox.ts", s = fs.readFileSync(f, "utf8");
const old = "o.status === 409 || (o.status === 404 && o.code === \"no_pane\") || (o.status === 403 && o.code === \"step_up\");";
if (!s.includes(old)) throw new Error("line not found");
fs.writeFileSync(f, s.replace(old, "true;"));'
npx vitest run apps/web/test/outbox.test.ts apps/web/test/outbox-web.test.ts
git checkout HEAD -- apps/web/src/lib/outbox/outbox.ts
git diff --stat
```
Expected: FAIL, 2 files, 4 tests (46 pass): `outbox`'s "Check again answered 500 internal error…", "…502 from a proxy…" and "…a refusal with no status…": `expected { …(13) } to match object { state: 'uncertain', …(1) }`; `outbox-web`'s "the hub threw (500)…": `expected 'failed' to be 'uncertain'`. Then `git diff --stat` prints nothing.

And the third, Check again blind to refusals (as round 1 had it): in `#check`, delete the four lines from `    if (outcome.kind === "refused" && definiteRefusal(outcome)) {` to its closing `    }`, run `npx vitest run apps/web/test/outbox.test.ts apps/web/test/outbox-web.test.ts`, and restore with `git checkout HEAD -- apps/web/src/lib/outbox/outbox.ts`. Expected: FAIL, 2 files, 6 tests (44 pass): `outbox`'s five "Check again answered … Not sent with that reason…": `expected { …(13) } to match object { state: 'failed', error: … }`; `outbox-web`'s "the hub refused it now (409 stale)": `TimeoutError: locator.waitFor: Timeout 10000ms exceeded.` Then `git diff --stat` prints nothing.

#### Part D: "Fleet unavailable" (round-2 review, item 12)

Spec §7: with the fleet service down, the hub keeps the last list with every worker offline, and says so. Task 14 gives `ObservationService.fleet()` and tells each subscriber of a change; this part puts it on the wire and on screen.

- [ ] **Step 15b.18: Write the failing protocol, hub and Chromium tests**

Create `packages/protocol/test/feed-fleet.test.ts`:

```ts
// The feed's `fleet` frame (fleet core §7): whether the hub can reach the fleet service. A hub from before the fleet
// never sends it, and the app reads that as available (apps/web feed.svelte.ts). Synthetic frames only.
import { describe, expect, it } from "vitest";
import { ServerFeedFrames, decode } from "../src/index.ts";

describe("the fleet frame", () => {
  it("decodes both ways", () => {
    for (const available of [true, false]) {
      expect(decode(ServerFeedFrames, JSON.stringify({ t: "fleet", available }))).toEqual({ kind: "ok", frame: { t: "fleet", available } });
    }
  });
  it("one without a boolean is malformed (negative control)", () => {
    expect(decode(ServerFeedFrames, JSON.stringify({ t: "fleet" })).kind).toBe("malformed");
    expect(decode(ServerFeedFrames, JSON.stringify({ t: "fleet", available: "no" })).kind).toBe("malformed");
  });
});
```

Create `apps/hub/test/feed-fleet.test.ts`:

```ts
// The feed's `fleet` frame (fleet core §7; Task 15b): whether the hub can reach the fleet service, sent after every
// hello (a feed that resumes may have missed a change) and on every change of ObservationService.fleet(). The real HTTP
// and WebSocket edges (inprocess-hub.ts) over an ObservationService in fleet mode whose listing fails on demand, as it
// does while the fleet is down. Synthetic workers; no tmux, no fleet.
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { ObservationService } from "../src/application/observation-service.ts";
import type { Tmux } from "../src/application/ports.ts";
import { frameText } from "./http-crash-fixture.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

const PC1 = "pc.3fa2c1d0.1";
let hub: InProcessHub | null = null;
afterEach(async () => { await hub?.close(); hub = null; });

// A fleet hub's listing (nodeStates set): it throws while `down.on`, as the fleet adapters do with the fleet gone.
function fleetObservation(down: { on: boolean }) {
  const tmux: Pick<Tmux, "listWorkers" | "captureMany"> = {
    listWorkers: async () => {
      if (down.on) throw new Error("fleet: no answer on the socket");
      return [{ id: PC1, name: "alpha", location: "alpha", node: "pc", offline: false, conflict: false }];
    },
    captureMany: async ids => new Map(ids.map(id => [id, "$ "])),
  };
  return new ObservationService(tmux, 60_000, Date.now, { nodeStates: async () => new Map([["pc", "online"]]) });
}
// Every frame the socket gets, in order, as { t, … }.
function frames(ws: WebSocket) {
  const got: Record<string, unknown>[] = [];
  ws.on("message", raw => { got.push(JSON.parse(frameText(raw)) as Record<string, unknown>); });
  return got;
}
const fleetFrames = (got: Record<string, unknown>[]) => got.filter(f => f.t === "fleet").map(f => f.available);
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise(r => setTimeout(r, 10)); expect(ok()).toBe(true); };

describe("the feed's fleet frame", () => {
  it("after every hello, right after the snapshot, and on every change", async () => {
    const down = { on: false };
    const observation = fleetObservation(down);
    await observation.poll();
    hub = await startInProcessHub({ observation });
    const cookie = await hub.cookie();
    const ws = await hub.socket("/api/feed", cookie);
    const got = frames(ws);
    ws.send(JSON.stringify({ t: "hello" }));
    await until(() => fleetFrames(got).length === 1);
    const kinds = got.map(f => f.t);
    expect(kinds.indexOf("fleet")).toBe(kinds.indexOf("snapshot") + 1);
    expect(fleetFrames(got)).toEqual([true]);
    down.on = true;
    await observation.poll();
    await until(() => fleetFrames(got).length === 2);
    expect(fleetFrames(got)).toEqual([true, false]);
    await observation.poll();                                         // still down: nothing new
    const again = await hub.socket("/api/feed", cookie);              // a feed that comes back while it is down
    const got2 = frames(again);
    again.send(JSON.stringify({ t: "hello" }));
    await until(() => fleetFrames(got2).length === 1);
    expect(fleetFrames(got2)).toEqual([false]);
    down.on = false;
    await observation.poll();
    await until(() => fleetFrames(got).length === 3);
    expect(fleetFrames(got)).toEqual([true, false, true]);
    expect(observation.snapshot().workers.map(w => [w.id, w.offline])).toEqual([[PC1, false]]);
    ws.close();
    again.close();
  });
  it("a legacy hub says available after each hello, and nothing else", async () => {
    const observation = new ObservationService({ listWorkers: async () => [], captureMany: async () => new Map() }, 60_000);
    await observation.poll();
    hub = await startInProcessHub({ observation });
    const ws = await hub.socket("/api/feed", await hub.cookie());
    const got = frames(ws);
    ws.send(JSON.stringify({ t: "hello" }));
    await until(() => got.some(f => f.t === "decisions"));
    await observation.poll();
    await new Promise(r => setTimeout(r, 50));
    expect(fleetFrames(got)).toEqual([true]);
    ws.close();
  });
});
```

The phone layout is tested whole, as the app mounts it: `Phone.svelte`'s one SvelteKit import, `goto`, gets a stand-in. In `apps/web/test/harness.ts`, in `startWeb`, replace

```ts
    plugins: [svelte({ configFile: false }), page],
```

with

```ts
    plugins: [svelte({ configFile: false }), page],
    // The one SvelteKit module a component here imports (Phone.svelte's goto): a stand-in that records where it went.
    resolve: { alias: { "$app/navigation": join(WEB, "test/app-navigation.stub.ts") } },
```

Create `apps/web/test/app-navigation.stub.ts`:

```ts
// A stand-in for SvelteKit's $app/navigation in the component tests (harness.ts): Phone.svelte calls goto, which only
// SvelteKit's router provides. It records where the app asked to go (globalThis.__goto) and goes nowhere.
export async function goto(url: string | URL): Promise<void> {
  const g = globalThis as unknown as { __goto?: string[] };
  (g.__goto ??= []).push(String(url));
}
```

Create `apps/web/test/fleet-unavailable-web.test.ts`:

```ts
// "Fleet unavailable" (fleet core §7): when the hub can't reach the fleet service it says so in the feed's `fleet` frame,
// and the app shows a banner in both layouts until the hub says it is back: the real Desktop (wide) and the real Phone
// (narrow), in headless Chromium, the hub faked at the browser's edge (harness.ts). A hub that never sends the frame (one
// from before the fleet) shows no banner. Applied live, without a resync. Synthetic workers.
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

// The whole phone layout, as the app mounts it under 900px (its one SvelteKit import, goto, is the harness's stand-in).
const PHONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import Phone from "/src/lib/phone/Phone.svelte";
  mount(Phone, { target: document.body, props: { device: "phone-1", verifiedAt: Date.now(), policy: { stay: "7d", stepUp: "1h" }, onSignedOut: () => {} } });
</script></body></html>`;

let desk: Web;
let phone: Web;
beforeAll(async () => { [desk, phone] = await Promise.all([startWeb(), startWeb(PHONE_PAGE)]); }, 60_000);
afterAll(async () => { await Promise.all([desk?.close(), phone?.close()]); });

async function open(web: Web, viewport: { width: number; height: number }) {
  const tab = await web.browser.newPage({ viewport });
  const errors: string[] = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.addInitScript(fakeFeed, { workers: [{ id: "pc.3fa2c1d0.0", name: "manager" }, { id: "pc.3fa2c1d0.1", name: "alpha" }] });
  await tab.goto(web.url);
  return { tab, errors };
}
const push = (tab: Page, m: unknown) => tab.evaluate(x => (globalThis as unknown as FeedWin).__feedPush(x), m);
const hellos = (tab: Page) => tab.evaluate(() => (globalThis as unknown as FeedWin).__feedSent.filter(m => (m as { t: string }).t === "hello").length);
const banner = (tab: Page) => tab.getByRole("status").filter({ hasText: "Fleet unavailable" });

describe("Fleet unavailable", () => {
  for (const [layout, web, viewport, ready] of [
    ["wide (the desktop)", () => desk, { width: 1600, height: 900 }, (tab: Page) => tab.locator("aside.side button.row", { hasText: "alpha" }).first()],
    ["narrow (the phone)", () => phone, { width: 390, height: 844 }, (tab: Page) => tab.locator(".conn.live").first()],
  ] as const) {
    it(`${layout}: none from a hub that doesn't say; shown while the hub says unavailable, gone when it is back`, { timeout: 30_000 }, async () => {
      const { tab, errors } = await open(web(), viewport);
      await ready(tab).waitFor({ timeout: 15_000 });
      await tab.waitForTimeout(500);
      expect(await banner(tab).count()).toBe(0);                       // the fake never sent a fleet frame
      await push(tab, { t: "fleet", available: false });
      await banner(tab).waitFor({ timeout: 5000 });
      expect(await banner(tab).innerText()).toContain("may still be running");
      await push(tab, { t: "fleet", available: true });
      await banner(tab).waitFor({ state: "detached", timeout: 5000 });
      expect(await hellos(tab)).toBe(1);                                // applied as it came: no resync
      expect(errors).toEqual([]);
      await tab.close();
    });
  }
});
```

- [ ] **Step 15b.19: Run them and see them fail**

Run: `npx vitest run packages/protocol/test/feed-fleet.test.ts apps/hub/test/feed-fleet.test.ts apps/web/test/fleet-unavailable-web.test.ts`

Expected: FAIL, 3 files, 6 tests (none pass):
- protocol (2): "decodes both ways": `expected { kind: 'unknown', t: 'fleet' } to deeply equal { kind: 'ok', …(1) }`; "one without a boolean is malformed": `expected 'unknown' to be 'malformed'`;
- hub (2): "after every hello…": `AssertionError: expected false to be true` (no `fleet` frame within 2 s); "a legacy hub…": `expected [] to deeply equal [ true ]`;
- web (2, chromium), wide and narrow: `TimeoutError: locator.waitFor: Timeout 5000ms exceeded.` waiting for `getByRole('status').filter({ hasText: 'Fleet unavailable' })`.

- [ ] **Step 15b.20: Implement the frame, the hub's sending, and the banner**

In `packages/protocol/src/feed.ts`, at the end of `ServerFeedFrames`, after the `attachments` entry, insert:

```ts
  // Fleet core §7: whether the hub can reach the fleet service, after every hello and on every change. While it can't,
  // every worker is listed offline (its state unknown) and the app says so. A hub from before the fleet never sends it:
  // the app reads that as available.
  fleet: z.object({ t: z.literal("fleet"), available: z.boolean() }),
```

In `apps/hub/src/adapters/http.ts`, the feed's WebSocket handler:
1. In the listener given to `observation.subscribe`, after `        attachments: (worker, message, attachments) => send({ t: "attachments", worker, message, attachments }),`, insert:
   ```ts
           // Whether the fleet answers, each time that changes (fleet core §7); the app shows "Fleet unavailable".
           fleet: status => send({ t: "fleet", available: status === "ok" }),
   ```
2. In `case "hello"`, after `            else send({ t: "snapshot", ...observation.snapshot() });`, insert:
   ```ts
               send({ t: "fleet", available: observation.fleet() === "ok" });   // a resumed feed may have missed a change
   ```

In `apps/web/src/lib/feed.svelte.ts`:
1. After the `linked = $state<…>(null);` field, insert:
   ```ts
     // Fleet core §7: whether the hub can reach the fleet service, as it last said. A hub that never says (one from before
     // the fleet) is available.
     fleetAvailable = $state(true);
   ```
2. In `#onMessage`, before `      case "older": {`, insert:
   ```ts
         case "fleet":
           this.fleetAvailable = m.available;
           break;
   ```

Create `apps/web/src/lib/FleetNotice.svelte`:

```svelte
<script lang="ts">
  // Fleet core §7: the hub can't reach the fleet service, so it can neither see nor steer the machines the agents run
  // on. It keeps the last list with every worker marked offline (its state unknown), and the app says why, in both
  // layouts, until the hub says the fleet is back (the feed's `fleet` frame). An icon plus the words (COLOR.md 2), in the
  // warning colours; nothing to dismiss, since it goes when its cause does. It lets clicks through to what lies beneath.
  // Placed at the top of the page: --fleet-notice-top moves it below a layout's own bar.
  import ServerOff from "@lucide/svelte/icons/server-off";
  let { available }: { available: boolean } = $props();
</script>

{#if !available}
  <div class="fleet" role="status">
    <ServerOff size={16} aria-hidden="true" />
    <span><strong>Fleet unavailable.</strong> The hub can't reach the machines the agents run on. They may still be running, but what you see may be out of date, and nothing can be sent to them until it's back.</span>
  </div>
{/if}

<style>
  .fleet {
    position: fixed; z-index: 50; top: var(--fleet-notice-top, calc(env(safe-area-inset-top, 0px) + 8px)); left: 16px; right: 16px;
    max-width: 34rem; margin-inline: auto; display: flex; gap: 10px; align-items: flex-start; pointer-events: none;
    padding: 10px 14px; border-radius: 12px; border: 1px solid var(--morndo-warning); background: var(--morndo-warning-subtle);
    color: var(--morndo-warning-text); box-shadow: 0 6px 24px rgb(0 0 0 / 0.18); font-size: 14px; line-height: 20px;
  }
  .fleet :global(svg) { flex: none; margin-top: 2px; }
</style>
```

(`@lucide/svelte` 1.49.0 ships `icons/server-off`: `node_modules/@lucide/svelte/dist/icons/server-off.svelte`. The warning tokens are those `Agents.svelte`'s connection pill already uses on both themes.)

In `apps/web/src/lib/desktop/Desktop.svelte`:
1. After `  import LinkedNotice from "../LinkedNotice.svelte";`, insert `  import FleetNotice from "../FleetNotice.svelte";`.
2. After `  <LinkedNotice linked={feed.linked} onReview={() => (preferences = "devices")} onSeen={at => feed.seeLinked(at)} />`, insert `  <FleetNotice available={feed.fleetAvailable} />`.
3. In the `.desk { … }` rule, after `font: 400 15px/22px var(--font); overflow: clip;              /* clip, not hidden: the frame itself can never scroll */`, insert:
   ```css
       --fleet-notice-top: 48px;                                     /* "Fleet unavailable" below the 40px top bar */
   ```

In `apps/web/src/lib/phone/Phone.svelte`:
1. After `  import LinkedNotice from "../LinkedNotice.svelte";`, insert `  import FleetNotice from "../FleetNotice.svelte";`.
2. After `  <LinkedNotice linked={feed.linked} onReview={() => void goto("/devices")} onSeen={at => feed.seeLinked(at)} />`, insert `  <FleetNotice available={feed.fleetAvailable} />`.

- [ ] **Step 15b.21: Run them and see them pass; type-check**

Each command on its own:
- Run: `npx vitest run packages/protocol/test/feed-fleet.test.ts apps/hub/test/feed-fleet.test.ts apps/web/test/fleet-unavailable-web.test.ts apps/web/test/feed-frames.test.ts`
  Expected: PASS, 4 files, 10 tests; `fleet-unavailable-web.test.ts` runs 2 in the `chromium` project.
- Run: `npm run check`
  Expected: exit 0. Without the `fleet` case in `feed.svelte.ts`, svelte-check reports `Argument of type '{ t: "fleet"; available: boolean; }' is not assignable to parameter of type 'never'` at `unreachable(m)` (Step 15b.23).

- [ ] **Step 15b.22: Commit**

```bash
git add packages/protocol/src/feed.ts packages/protocol/test/feed-fleet.test.ts apps/hub/src/adapters/http.ts apps/hub/test/feed-fleet.test.ts apps/web/src/lib/feed.svelte.ts apps/web/src/lib/FleetNotice.svelte apps/web/src/lib/desktop/Desktop.svelte apps/web/src/lib/phone/Phone.svelte apps/web/test/harness.ts apps/web/test/app-navigation.stub.ts apps/web/test/fleet-unavailable-web.test.ts
git commit -m "feat(web): Fleet unavailable, from the feed's fleet frame, in both layouts"
```

- [ ] **Step 15b.23: Negative controls: the banner, the hub's frame, the app's case**

Each one alone, restored before the next:
- Remove both `<FleetNotice …/>` lines: `sed -i.bak '/<FleetNotice available={feed.fleetAvailable} \/>/d' apps/web/src/lib/desktop/Desktop.svelte apps/web/src/lib/phone/Phone.svelte`, then run `npx vitest run apps/web/test/fleet-unavailable-web.test.ts`. Expected: FAIL, both tests, `TimeoutError: locator.waitFor: Timeout 5000ms exceeded.` Restore: `git checkout HEAD -- apps/web/src/lib/desktop/Desktop.svelte apps/web/src/lib/phone/Phone.svelte` and `rm apps/web/src/lib/desktop/Desktop.svelte.bak apps/web/src/lib/phone/Phone.svelte.bak`.
- In `http.ts`, delete the line `            send({ t: "fleet", available: observation.fleet() === "ok" });   // a resumed feed may have missed a change`, then run `npx vitest run apps/hub/test/feed-fleet.test.ts`. Expected: FAIL, 2 tests: "after every hello…" `expected false to be true`, "a legacy hub…" `expected [] to deeply equal [ true ]`. Restore with `git checkout HEAD -- apps/hub/src/adapters/http.ts`.
- In `http.ts`, delete the listener's line `        fleet: status => send({ t: "fleet", available: status === "ok" }),`, then run the same. Expected: FAIL, 1 test (1 passes): "after every hello…" `expected false to be true` (the change never reaches the feed). Restore with `git checkout HEAD -- apps/hub/src/adapters/http.ts`.
- In `feed.svelte.ts`, delete the three lines of the `fleet` case, then run `npm run check`. Expected: exit 1; svelte-check reports `"src/lib/feed.svelte.ts" … "Argument of type '{ t: \"fleet\"; available: boolean; }' is not assignable to parameter of type 'never'."` at `unreachable(m)`. Restore with `git checkout HEAD -- apps/web/src/lib/feed.svelte.ts`.

Then `git status --short` prints nothing.

#### Part E: keys that may have been typed (round-2 review, item 25)

A keystroke the worker's machine may have typed before the hub lost touch (`executed: "maybe"`) is `keys_uncertain` from the hub's terminal route (Task 14). Keystrokes are never retried (spec §5.3); the words say what is known.

- [ ] **Step 15b.24: Write the failing Chromium test**

Create `apps/web/test/terminal-keys-web.test.ts`:

```ts
// Keys typed from the terminal view (ADR-0006, AC9) whose fate the hub can't tell (fleet core §3.1): the worker's
// machine may have typed them before the hub lost touch, so the hub answers `keys_uncertain`, and the view says they may
// have been typed, never that the pane refused them; a real refusal (`keys_refused`) still reads as one. The real
// TerminalView in headless Chromium; the terminal socket faked in the page. Synthetic frames only.
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "./harness.ts";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
  import { mount } from "svelte";
  import TerminalView from "/src/lib/desktop/TerminalView.svelte";
  mount(TerminalView, { target: document.body, props: { pane: "pc.3fa2c1d0.1", name: "alpha", verifiedAt: Date.now(), onVerified: () => {} } });
</script></body></html>`;

// Runs in the page before the app: /api/terminal answers with control and one frame; the test pushes the rest.
function fakeTerminal() {
  type Socket = new (url: string | URL, protocols?: string | string[]) => unknown;
  const w = globalThis as unknown as { WebSocket: Socket; __termPush: (m: unknown) => void };
  const Real = w.WebSocket;
  class Term {
    readyState = 0;
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    constructor() {
      w.__termPush = m => setTimeout(() => this.onmessage?.({ data: JSON.stringify(m) }), 0);
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({});
        w.__termPush({ t: "mode", control: true });
        w.__termPush({ t: "frame", cols: 20, rows: 2, x: 2, y: 0, cursor: true, lines: ["$ ", ""] });
      }, 0);
    }
    send() {}
    close() { this.readyState = 3; }
  }
  const Fake = function (url: string | URL, protocols?: string | string[]) {
    return String(url).includes("/api/terminal") ? new Term() : new Real(url, protocols);
  } as unknown as Socket;
  Object.assign(Fake, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  w.WebSocket = Fake;
}

let web: Web;
beforeAll(async () => { web = await startWeb(PAGE); }, 60_000);
afterAll(async () => { await web?.close(); });

describe("keys the hub can't vouch for", () => {
  it("keys_uncertain: may have been typed; keys_refused: the pane didn't take them", { timeout: 30_000 }, async () => {
    const tab: Page = await web.browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message));
    await tab.addInitScript(fakeTerminal);
    await tab.goto(web.url);
    const note = tab.locator(".note");
    const push = (m: unknown) => tab.evaluate(x => (globalThis as unknown as { __termPush: (m: unknown) => void }).__termPush(x), m);
    await tab.locator(".xterm-screen").waitFor({ timeout: 15_000 });
    await push({ t: "error", error: "keys_uncertain" });
    await expect.poll(() => note.innerText(), { timeout: 5000 }).toBe("Those keys may have been typed.");
    await push({ t: "error", error: "keys_refused" });
    await expect.poll(() => note.innerText(), { timeout: 5000 }).toBe("The pane didn't take those keys.");
    expect(errors).toEqual([]);
    await tab.close();
  });
});
```

- [ ] **Step 15b.25: Run it and see it fail**

Run: `npx vitest run apps/web/test/terminal-keys-web.test.ts`

Expected: FAIL, 1 test in the `chromium` project: `AssertionError: expected 'The pane didn\'t take those keys.' to be 'Those keys may have been typed.'`.

- [ ] **Step 15b.26: Word the error frame**

In `apps/web/src/lib/desktop/TerminalView.svelte`, in `socket.onmessage`, replace

```ts
        case "error": note = "The pane didn't take those keys."; break;
```

with

```ts
        // keys_uncertain: the worker's machine may have typed them, but the hub lost touch before it could say (fleet
        // core §3.1); never a refusal. Anything else the hub says is one.
        case "error": note = m.error === "keys_uncertain" ? "Those keys may have been typed." : "The pane didn't take those keys."; break;
```

- [ ] **Step 15b.27: Run it and see it pass, then commit**

Run: `npx vitest run apps/web/test/terminal-keys-web.test.ts`
Expected: PASS, 1 test in the `chromium` project.

```bash
git add apps/web/src/lib/desktop/TerminalView.svelte apps/web/test/terminal-keys-web.test.ts
git commit -m "feat(web): keys the hub can't vouch for read 'may have been typed', not refused"
```

- [ ] **Step 15b.28: Negative control: one wording for every error**

Put back the old line (`        case "error": note = "The pane didn't take those keys."; break;`), run `npx vitest run apps/web/test/terminal-keys-web.test.ts`, and restore with `git checkout HEAD -- apps/web/src/lib/desktop/TerminalView.svelte`. Expected: FAIL, the same test with the same message as Step 15b.25.

#### Part F: words for an answer a fleet refuses (round-2 review, follow-up)

Task 5 lets an escalation answer be refused `node_offline` (the manager's machine doesn't answer), and Task 14 `lane_conflict` (two windows claim the manager's name; plan.md, "manager"). `desktop/decisions.ts`' `REFUSALS` had neither, so both reached the principal as the hub's bare code through `explain()`. One map serves the desktop's answer (`Desktop.svelte`) and the phone's catch-up and Today (`catchup/answer.ts`).

- [ ] **Step 15b.29: Write the failing test**

Create `apps/web/test/decision-refusals.test.ts`:

```ts
// Every refusal the hub can answer a Decision with has words, so none reaches the principal as the hub's bare code: one
// map (desktop/decisions.ts REFUSALS) for the desktop's answer (Desktop.svelte) and the phone's catch-up and Today
// (catchup/answer.ts). The codes are the hub's AnswerResult problems (apps/hub/src/application/escalation-service.ts),
// but step_up, which each path handles by asking for the passkey first. A fleet adds two (fleet core §4, §7; Tasks 5,
// 14): the manager's machine doesn't answer (node_offline), and two windows claim the manager's name (lane_conflict).
// Nothing was typed in either. Pure; no hub.
import { describe, expect, it } from "vitest";
import type { AnswerRefusal } from "@morndo/domain";
import { ApiError } from "../src/lib/api.ts";
import { postAnswer } from "../src/lib/catchup/answer.ts";
import { REFUSALS } from "../src/lib/desktop/decisions.ts";

// The domain's AnswerRefusal, all of it: one added there fails the type check here until it is listed, and so worded.
const ANSWER_REFUSALS = ["unknown", "already_answered", "settled", "expired", "not_filed_yet", "cant_check", "on_screen", "not_a_choice", "bad_option", "empty"] as const satisfies readonly AnswerRefusal[];
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const allRefusals: Same<(typeof ANSWER_REFUSALS)[number], AnswerRefusal> = true;
const SEND_PROBLEMS = ["menu_open", "draft_present", "no_input_box", "not_submitted", "no_pane", "busy"] as const;   // node-ops' SendProblem
const THE_HUBS_OWN = ["in_progress", "too_long", "changed", "node_offline", "lane_conflict"] as const;

describe("words for every refusal of an answer", () => {
  it("each code the hub can send has its own words", () => {
    expect(allRefusals).toBe(true);
    expect([...ANSWER_REFUSALS, ...SEND_PROBLEMS, ...THE_HUBS_OWN].filter(code => !REFUSALS[code])).toEqual([]);
  });
  it("a fleet's two say nothing was typed, and what to do", () => {
    expect(REFUSALS.node_offline).toBe("The manager's machine isn't answering right now, so the answer wasn't typed. Try again once it's back.");
    expect(REFUSALS.lane_conflict).toBe("Two windows are named like the manager, so the answer wasn't typed: nobody can tell which one it's for. Close or rename one of them, then try again.");
  });
  it("the phone's catch-up gives the same words", async () => {
    for (const code of ["node_offline", "lane_conflict"]) {
      const r = await postAnswer("ny-7", { key: "ship" }, "v1", `req-${code}`, async () => { throw new ApiError(409, code); });
      expect(r).toEqual({ ok: false, code, text: REFUSALS[code] });
    }
  });
});
```

- [ ] **Step 15b.30: Run it and see it fail**

Run: `npx vitest run apps/web/test/decision-refusals.test.ts`
Expected: FAIL, 3 tests: "each code the hub can send has its own words": `expected [ 'node_offline', 'lane_conflict' ] to deeply equal []`; "a fleet's two…": `expected undefined to be 'The manager\'s machine isn\'t answeri…'`; "the phone's catch-up gives the same words": `expected { ok: false, …(2) } to deeply equal { ok: false, …(2) }` (it gave `explain()`'s words).

- [ ] **Step 15b.31: Word them**

In `apps/web/src/lib/desktop/decisions.ts`, at the end of `REFUSALS`, replace

```ts
  busy: "Another message is being typed into the manager right now. Try again in a few seconds.",
};
```

with

```ts
  busy: "Another message is being typed into the manager right now. Try again in a few seconds.",
  // A fleet (fleet core §4, §7): the manager's machine doesn't answer, or two windows claim its name. Nothing was typed.
  node_offline: "The manager's machine isn't answering right now, so the answer wasn't typed. Try again once it's back.",
  lane_conflict: "Two windows are named like the manager, so the answer wasn't typed: nobody can tell which one it's for. Close or rename one of them, then try again.",
};
```

Run: `npx vitest run apps/web/test/decision-refusals.test.ts apps/web/test/catchup-answer.test.ts`
Expected: PASS, 2 files, 6 tests.

```bash
git add apps/web/src/lib/desktop/decisions.ts apps/web/test/decision-refusals.test.ts
git commit -m "feat(web): words for an answer refused node_offline or lane_conflict"
```

- [ ] **Step 15b.32: Negative control: the lane_conflict words removed**

Delete the line `  lane_conflict: "Two windows are named like the manager, …",` from `REFUSALS`, run `npx vitest run apps/web/test/decision-refusals.test.ts`, and restore with `git checkout HEAD -- apps/web/src/lib/desktop/decisions.ts`. Expected: FAIL, 3 tests: `expected [ 'lane_conflict' ] to deeply equal []`; `expected undefined to be 'Two windows are named like the manage…'`; `expected { ok: false, …(2) } to deeply equal { ok: false, …(2) }`. Then `git status --short` prints nothing.

#### Part G: the domain model, and every suite

- [ ] **Step 15b.33: Update `docs/domain.md`**

In the Steering section:
1. In the "Send state" row, replace `or Uncertain (the hub stopped while typing it, so it may have been typed).` with:
   ```
   or Uncertain (the hub stopped, or lost the worker's machine, while typing it, so it may have been typed).
   ```
2. In S5, replace `A repeat of a done request answers "duplicate"; a repeat of a started one that never finished (the hub stopped while typing) answers "uncertain" and is never typed again. |` with:
   ```
   A repeat of a done request answers "duplicate"; a repeat of a started one that never finished (the hub stopped while typing) answers "uncertain" and is never typed again, unless the hub can ask the worker's machine (a fleet, fleet core §3.1): typed there, it answers "duplicate"; never received there, it is typed now. |
   ```
3. In S7, replace `An Uncertain Command offers Discard only. |` with:
   ```
   An Uncertain Command is never sent again on its own. It offers Check again, the same request id once more within that window, which ends it Sent if the hub finds it typed or types it now (S5), or Not sent if the hub finds it never typed and refuses it now (a 404, a 403 step_up or a 409 other than uncertain), and Discard. Any other answer leaves it Uncertain. |
   ```
4. In S8, replace `The one way back is the principal's Retry, which returns a Not sent Command to Queued with the same request id. An echo` with:
   ```
   The one way back is the principal's Retry, which returns a Not sent Command to Queued with the same request id. Uncertain moves only by Check again (S7): to Sent, or to Not sent. An echo
   ```

In the Observation section:
1. After the "Needs you" row of the terms table, insert:
   ```
   | Offline | The worker's machine doesn't answer now (fleet core §7). The worker stays listed, marked offline, and nothing is typed to it until its machine is back. | Gone; quiet. |
   ```
2. Replace `Events: WorkerAppeared, WorkerRenamed, WorkerBecameActive, WorkerBecameQuiet, WorkerGone.` with:
   ```
   Events: WorkerAppeared, WorkerRenamed, WorkerBecameActive, WorkerBecameQuiet, WorkerOfflineChanged, WorkerGone.
   ```

- [ ] **Step 15b.34: Run every suite, the type check and the linter**

Each command on its own (one command, one Expected):
- Run: `npx vitest run apps/web packages apps/hub`
  Expected: every file passes, `0 skipped`, except on macOS `packages/node-ops/test/pane-lock.test.ts` (2 tests: it needs `flock(1)`, which macOS lacks; it fails the same before this task). Task 15's totals plus 9 files and 40 tests: on the round-2 verification tree (Tasks 1–15 replayed from the round-2 text), 147 files and 1155 tests before, 156 and 1195 after (1193 pass and `pane-lock`'s 2 fail on macOS). The Linux counts are not observed yet (plan.md, Global Constraints).
- Run: `npx vitest run --project chromium apps/web/test/worker-offline-web.test.ts apps/web/test/outbox-web.test.ts apps/web/test/update-card-check-web.test.ts apps/web/test/fleet-unavailable-web.test.ts apps/web/test/terminal-keys-web.test.ts`
  Expected: PASS, 5 files, 23 tests, each shown as `|chromium|`.
- Run: `npm run check`
  Expected: exit 0.
- Run: `npm run lint`
  Expected: exit 0, no findings.

- [ ] **Step 15b.35: Commit**

```bash
git add docs/domain.md
git commit -m "docs(domain): Offline workers and WorkerOfflineChanged; Check again on an uncertain send (S5, S7, S8)"
```

#### Notes for the integrator

- **Check again resolves only on a fleet hub.** A legacy hub has no `op.status`: a repeat of a `started` row always answers `409 uncertain`, so the entry stays Uncertain. That is right, and harmless: the hub never types it twice.
- **Definite refusals on Check again are Not sent** (round 2, item 30; was "keep Uncertain" in round 1). With Task 14, `unknown` from the store the request went to means the machine never had it, and the hub judges the send anew: a `403 step_up`, `404 no_pane` or `409 stale`/`menu_open`/… then says nothing was typed. The entry becomes Not sent with that refusal's words and its usual action (Verify and send, Edit, Retry), each of which sends the same request id again. A legacy hub never reaches that path (it answers `409 uncertain`), so nothing changes there.
- **"Fleet unavailable" and `keys_uncertain` come from Task 14.** Part D's hub step only forwards `ObservationService.fleet()` and its change; Part E only words the terminal route's `keys_uncertain`. If Task 14 names either differently, the plan's Contracts win and this part follows them.
- **The S5 sentence is updated here** (Step 15b.33), because Check again relies on Task 14's behaviour. If Task 14 updates S5 itself, keep one of the two.
- **QA (Task 20, PC-8):** the marker has landed, so the screenshot must show "offline" on pc-scratch's row only (the runbook says so).
- **ADR-0008** still says "an Uncertain send offers Discard only". It is a decision record and is left as it was; `docs/domain.md` S7 is the current rule.
- **Verified (round 1)** in a scratch tree: Tasks 4–5 executed on stand-ins, Task 1's `worker-id.ts`, Task 15 Step 15.3 and Task 4's `offline` applied, Task 14 not applied (fakes of the port and of the send endpoint). Then the same change, as one diff, on the reconciled Tasks 1–15: 148 files, 1122 tests; only `pane-lock`'s 2 failed (macOS).
- **Verified (round 2, 2026-10-06)** on the hub lane's round-2 tree (Tasks 1–3 of wave0-r2, then Tasks 4, 5, 14 and 15 replayed from the round-2 text; tag `t15-C`), macOS, Node 24.21.0, vitest 5.0.3, Playwright 1.63.0 headless Chromium. Task 15b applied as the text says (every created file byte-identical to its block; every other block found in the tree before or after its edit). Every changed step was run: the fail runs (15b.13, 15b.19, 15b.25), the pass runs (15b.15, 15b.21, 15b.27), the controls (15b.11's two, 15b.17's three, 15b.23's four, 15b.28, 15b.32), and Step 15b.34's four commands, with the outputs written in the steps; Part F's fail, pass and control runs (15b.30–15b.32) too; `node e2e/gallery.e2e.ts` printed `5/5 checks passed`. Parts A and B are otherwise unchanged from round 1 and ran inside Step 15b.34's suites.
