# ADR-0034: An account's label — email, organization, plan — beside its name

- **Status:** Accepted, 2026-10-23.
- **Builds on:** ADR-0016 (Usage, U1 to U4), ADR-0029 (the account pool).
- **Rules:** U5 in `docs/domain.md`.

## Context

Home names each account as the principal named it in the pool: `a1`, `a3`, … . Which of those is the Team seat with
Max 5x, and which is the personal Pro one, only the principal's memory said; the usage view carried nothing else. The
pool already writes one file with each account's email, organization and plan (its usage file, JSON Lines), on the
same machine as the hub.

## Decision

1. **One adapter, one source.** The hub reads the pool's usage file through one adapter (`apps/hub/src/adapters/
   pool-accounts.ts`), only when `MORNDO_POOL_USAGE` names it, only the fields a label needs — name, email, org,
   plan, tier — and never an org id or anything else in the file. The vendor words (`claude_team`, the tier names)
   are translated there and live nowhere else; the domain holds no vendor name.
2. **An overlay on the read model, not a Report.** The profile is `AccountUsage.profile`, set only by the hub when it
   builds the principal's view (`UsageService.view()`); a Report never sets or clears it, and what is stored keeps
   `profile: null`. The file is looked at again every minute, and what changed is told to open feeds like a report
   that changed what is shown.
3. **The label rule.** `accountLabel` joins the name and the parts that exist, in order email, organization word
   (`Team`, `personal`), plan: "a3 · ada@example.test · Team · Max 5x". A missing part is not shown; no profile is
   the name alone. The two named tiers map to "Max 5x" and "Max 20x"; any other tier, the free one, an empty or an unknown one, reads "no paid plan" (the `plan` field still says
   "max" of an ended subscription), except a Max tier the table doesn't know, which shows the plan as written.
   Retired and logged-out accounts keep their label: it exists to say which account is which, whatever its state.
4. **A guarded read.** The hub looks at the file once at start and then every minute, asynchronously, so nothing in
   the file can hold up the event loop. It opens the file without waiting for a writer (`O_NONBLOCK`; a named pipe
   would block an ordinary open), checks the open handle, and reads only a regular file of at most 1 MiB; a pipe, a
   directory, a device or an oversize file is refused with one log line (the path and the size, never content) and the
   last good profiles stay. A line cut in the middle (the file caught mid-write) keeps its account's last good profile;
   a complete line with nothing to show, or an account gone from the file, drops it.
5. **The privacy rule.** The profile goes only to the principal's session: the `usage` feed frame and
   `GET /api/usage`. The agent door's reply to `POST /api/agent/usage` carries no profile — it stays `null` there.

### Where things live

| Piece | Where |
|---|---|
| U5: the profile type, the label, what may be read into one | `packages/domain/src/usage.ts` |
| The wire: `profile` on an account, optional (an older hub's account still parses) | `packages/protocol/src/usage.ts` |
| The pool-file reader, cached by mtime and size | `apps/hub/src/adapters/pool-accounts.ts` |
| The overlay on the view, `refreshProfiles`, the 60 s look | `apps/hub/src/application/usage-service.ts`, `apps/hub/src/main.ts` |
| The card header, the headline tiles, the lane's About card | `apps/web/src/lib/desktop/HomeView.svelte`, `DetailsModal.svelte`, `Desktop.svelte` |

## Alternatives

| Option | Verdict |
|---|---|
| **The status line posts the email with each report** | Rejected. Every lane's status line would carry its account's email on every turn, into transcripts and logs; and the status line's JSON is the vendor's, with no such field. |
| **The hub reads the accounts' credential files** | Rejected, as ADR-0016 ruled: those files are the credentials' neighbours, which the hub never opens. The pool's usage file is the pool's own export, not a credential store. |

## Consequences

- **Good:** one look tells the accounts apart, on Home and in a lane's details, with no new channel and no change to
  any status-line script.
- **Cost:** `MORNDO_POOL_USAGE` must name the file on the hub's machine; without it every account shows its name
  alone.
- **Limit:** the label rides on a fresh session (U3): a lane whose last report is 10 minutes old shows no Account
  field in its details. The file is read as it stands; a pool that renames accounts changes the labels with it.
