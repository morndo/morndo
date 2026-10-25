# Key pools slice 2: build plan (T-449, stacked on slice 1, PR 155)

Plan of record: `2026-10-24-key-pools.md` rev 3.1, section 8.2 row 2. This file only fixes the order of the build, the tests each step starts red with, and
the choices the plan left open. Checked 2026-10-25 against `origin/feat/key-pools-s1` @ 3facf5b7.

## Choices the plan left open (decided here, recorded in ADR-0037)

1. **Grant id** is `g` + the first lease's id (`gl12`): lease ids are `l<seq>` of the directory and never reused, so no random source enters the service.
2. **KP18 clock.** A report is attributed with the time the report is made, not the run's start: a refusal ends a request, and the run wrapper reads it
   at the run's end. `previous` is cleared by the first attribution after the window.
3. **KP18's claimed probe waits for slice 3** (the probe adapter and `probingUntil`, KP16). Inside the window the report goes to `previous.member`
   only; it never marks the current member. A dry new key is found by its own next refusal after the window, or by the daily probe. The risk the plan
   named (a stale report marking a healthy key) is closed; the other one (a dry new key hidden for 60 s more) is the one this leaves open until slice 3.
4. **Counting a call.** Every pooled helper call is counted once on the lease it ends up serving (the window is inherited, KP17) and writes one
   `KeyServed` before the key is printed. (`helper --lease` of a single Connection does not write `KeyServed` today and stays as it is.)
5. **Engine layer.** A pool is a routing name like a Connection (kind `api-key`): `Priority.order` and the role picks hold the pool's name in place of
   its members; members' own providers are registered off. A page priority or role save keeps pool names it did not send. Page rows for pools are slice 5.
6. **`check --pool P`** asks whether some member could serve now; it moves no ring position and writes no `MemberPicked`.
7. **Pool changes are re-derived through hooks**, so `revoke` and the lifecycle follow: a failed engine write after the pool is saved reports
   `saved, engine layer not updated (retry: morndo-keys keypool sync)`; `keypool sync` is the idempotent retry.

## Steps (tests first, red; Cursor writes the code, at most two rounds a step; I read every diff and the commit author)

### Step 1: domain
Code: `connections.ts` gains `swapLease` and `nextHelperWindow`; `key-pool.ts` gains `Grant`, `grants`, `openGrant`, `moveGrant`, `touchGrant`, `closeGrant`,
`attributeToGrant`, the grant events, and `leaveKeyPool` drops the member's grants; `routing.ts` gains `foldPool`, `unfoldPool`, `withPools`.
Named tests (`packages/domain/test/key-pool-grants.test.ts`, `connections-swap.test.ts`, `routing-pools.test.ts`):
- `kp17 a swap keeps the call count and window start`, `kp17 a window that has lapsed starts again at the swap`
- `kp19 swapLease is atomic in one directory save: both, or neither` (gate refusal leaves the old lease live, the refusal event recorded; a missing old lease refuses with nothing saved)
- `kp18 inside the window the report is the previous member's, outside it the current member's, previous is cleared after the window`
- `kp8 leaving takes the member's grants with it` · `grant events carry ids and names only (kp12)` · `moveGrant to the lease the grant already names changes nothing`
- `fold: members of a pool become the pool's name at the first member's place, picks follow, duplicates drop; unfold restores; a page order without the pool keeps it`

### Step 2: application
Code: `LeaseService.swap`, `KeyPoolService` takes `leases` and gets `handOff`, `attribute`, `reportViaGrant`, `grantOf`, `closeGrant`, `sweepGrants`, an `onPicked`
option on `pick` (the grant opens and moves in the same save as `MemberPicked`), the fakes.
Named tests (`key-pool-handoff.test.ts`): the plan's `handOff:` list, one test each: exhausted swap with CN8 again (a member over budget is declined,
the next taken) and `KeyServed` before the print; two simultaneous calls leave one live lease and one `KeyServed` per printed key; **crash after the lease
swap, before the grant is saved** (fault injected in the pool store's save) adopts; **crash after the grant is saved, before `KeyServed`** serves the same
lease with nothing printed in between; member servable but lease swept re-leases the same member with the window inherited; authority ended by the cap
exits `authority`, no lease, no swap; refresh refused by the member's budget swaps and leaves health alone; a failing member prints nothing, `pool_blocked`;
report within the TTL goes to `previous.member`.

### Step 3: engine layer
Code: `RoutingService` knows pools (listed, kinds, `withPools` in `commitPriority`/`commitRole`), `PoolRouting` hook in `KeyPoolService`,
`publishOwned` registers pool providers and turns members' off, `buildPage` counts pools as known names, `KeyPoolService.canServe`.
Tests (`key-pool-routing.test.ts`): join turns the member's provider off, registers `morndo-keys run --pool P --` / `check --pool P`, folds the order and
the picks, chains re-derived; leave restores provider, order and picks; delete dissolves and removes the provider; revoke of the last member removes the pool
from the order; a page priority save does not drop a pool; `check --pool` serves no pick and writes no `MemberPicked`; engine write failure names the retry.

### Step 4: CLI
Code: `helper --pool P --grant G`, `run --pool` opens the grant and uses it for the helper line and the run's end, `keypool report --grant`, `keypool sync`,
`check --pool`, `home.keypools.sweepGrants()` where leases are swept.
Tests (`keypool-handoff-cli.test.ts`, local fake Messages API per key): `run --pool: the child's helper gets the next member's key within one helper call after
the report`; `a pooled helper cannot reset the call cap by handing off`; **planted secret** in the hand-off path (stdin of `report`, helper stdout/stderr,
`KeyServed`, grant, events, alert file); `helper --pool` refusals print a word and exit 1; characterisation: `helper --lease` unchanged.

### Step 5: docs, QA, hand-over
ADR-0037 and `docs/domain.md` (grant, KP17-KP19), manual QA with the real agent CLI against a local stand-in API (no real key), `morndo-memory remember`.
