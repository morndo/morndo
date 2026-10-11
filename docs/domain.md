# Domain model

Draft, 2026-09-30. The product is named Morndo (2026-09-30); "the product" below means Morndo. The domain names no vendor; vendor names appear only in the adapter table, and vendor facts in [ADR-0001](adr/0001-owner-side-core-on-top-of-existing-agent-tools.md).

The product serves the **principal**, not the workers. The trial scorer (a script outside this repo, not domain code) replays recorded events; each broken invariant it checks is a **Violation** of one frozen failure class:

- **F1** nothing on the phone within 10 minutes (from reconnect, if he was offline);
- **F2** a duplicate, or a repeat ask for a decision already given;
- **F3** a trap reported as a success;
- **F4** an irreversible action taken without the principal.

**Scope** (an internal decision record, §5): invariants marked *needed by the scorer* are the ones the scorer checks. Those marked *deferred until evidence* get no code until a trial or baseline shows the pain; the same holds for Endpoint pairing, the Mandate lifecycle, Acknowledgement and the Done-means hash.

## Ubiquitous language

| Term | Means | Is not |
|---|---|---|
| Principal | The one person who holds authority (merge, deploy, spend); his attention is scarce. | An agent, a supervisor session, a chat room. |
| Endpoint | One sender identity on one channel, proven by pairing to be the principal. | A group or room; an agent's terminal. |
| Worker | Any agent session doing work. | A source of authority, or of evidence on itself. |
| Action | A concrete step: kind, target, revision. | Intent ("ship it"). |
| Irreversible action | An Action whose kind policy marks as not undoable: protected merge, deploy, shared push, deletion, sending outside. | Whatever the worker calls safe. |
| Mandate (consent) | Consent the principal gave from an Endpoint: effect (allow or deny), scope (kind plus target pattern), uses (once or standing), expiry, provenance (endpoint, inbound message ID, time). Revocable. | A vendor permission rule, a quote relayed by an agent, silence, a timeout. |
| Decision | The principal's answer to one Ask. Only an answer to a policy Ask, given here with a fresh step-up, issues a Mandate: once, unless he chose "always" (K-1). Any other Decision goes to the asker and grants nothing. | Its delivery or acknowledgement; a Mandate, unless the Ask was a policy Ask. |
| Policy Ask | An Ask raised when Authorize returns NeedsPrincipal for an Action. Its options are Mandates: allow once, allow always, deny. None exist on the web endpoint yet (ADR-0002, Proposed). | A manager's needs-you item; a worker's question or menu. |
| Escalation | One item that needs the principal: an Ask, a Report (outcome plus Verdict) or an Alert, identified by a dedupe key. | A message. Re-delivered, it stays one item. |
| Delivery | One attempt to show an Escalation on an Endpoint: accepted, failed or unknown. | Proof he saw it; a transport "ok" is only "accepted". |
| Acknowledgement | An explicit tap or reply from an Endpoint, bound to one Escalation ID. | A read receipt, a sent-message ID, an agent marking a message read. |
| Claim | A worker's statement that an outcome holds on a revision. | Evidence. |
| Check | A named, deterministic procedure fixed in the task's Done-means before work starts. | A model's reading of the transcript. |
| Evidence | The result of a Check run by a producer other than the claimant, on the claimed revision. | Worker output, logs or transcript. |
| Verdict | Verified, Refuted or Unverified. | A boolean. Unverified is never shown as success. |
| Violation | A broken invariant found in a recorded history, tagged F1–F4. | A runtime error. |

## Authority: consent he gave

Aggregate **Mandate**. Domain service **Authorize(action)** returns Allowed(mandate), Denied or NeedsPrincipal.

| # | Invariant | Guards | Scope |
|---|---|---|---|
| A1 | A Mandate is created only from Endpoint-provenanced input. Worker text, relayed quotes, timeouts and defaults create nothing. | F4 | deferred until evidence |
| A2 | An irreversible action is Allowed only by a live allow-Mandate whose scope covers it; any covering deny-Mandate wins. | F4 | needed by the scorer |
| A3 | Consumption is atomic: a once-Mandate authorizes one Action, never two. | F4 | deferred until evidence |
| A4 | While a live Mandate covers an Action, Authorize never returns NeedsPrincipal for it. | F2 | needed by the scorer |

Events: MandateGranted, MandateConsumed, MandateRevoked, MandateExpired, ActionAuthorized, ActionHeld.

## Escalation: delivery he acknowledged

Aggregate **Escalation**, with Delivery entities. States: Open, then Acknowledged, Superseded or Expired.

| # | Invariant | Guards | Scope |
|---|---|---|---|
| E1 | One Escalation per dedupe key. Raising a known key changes nothing visible. | F2 | needed by the scorer |
| E2 | An Escalation stays Open until an Acknowledgement arrives. Accepted Deliveries don't close it. | F1 | deferred until evidence |
| E3 | At most one Delivery is outstanding. A retry needs the previous one failed, or unknown past its timeout, and updates the same visible item where possible. | F2 | deferred until evidence |
| E4 | An Open Escalation without an accepted Delivery within 10 minutes of creation raises EscalationOverdue. Arrival after a reconnect isn't observable; the scorer reads it from the chat export. | F1 | needed by the scorer |
| E5 | An Ask is not opened, and an open Ask is Superseded, when Authority reports a covering Mandate. | F2 | needed by the scorer |
| E6 | A Report's headline is its Claim's Verdict, never the worker's words. | F3 | deferred until evidence |
| E7 | An Ask whose Action is no longer pending is shown as expired, never as a live question. | F2 | deferred until evidence |

Events: EscalationRaised, DeliveryAttempted, DeliveryFailed, EscalationAcknowledged, EscalationAnswered (carries the Decision and its provenance), EscalationSuperseded, EscalationExpired, EscalationOverdue.

### On the web endpoint: Asks the principal answers in the app

Added 2026-10-01 by the [ADR-0006](adr/0006-slack-style-desktop-client.md) addendum "Decisions"; code in `packages/domain/src/escalation.ts`.

- **The Asks:**
  - the manager's needs-you items, with or without tap options;
  - workers' open questions and menus.
- **The states:**
  - *Open*;
  - *Answered*: an Acknowledgement that carries a Decision, from this endpoint or seen at the asker's end from another;
  - *Settled*: the asker closed it, with its resolution;
  - *Expired*.
- An Ask also says:
  - how it is answered: a tap on an option, words, or on the worker's own screen;
  - how long it stays answerable: while the manager's list has it open, for a day, or while its source shows it.

| # | Invariant | Guards |
|---|---|---|
| E8 | An Escalation takes at most one Decision. A second answer is refused and shows the first. An answer seen at the asker's end, such as a tap from another endpoint, counts as given. While an earlier answer to the same ask may have been typed (in doubt), another answer is judged only after the hub has asked the asker's machine about the earlier one: typed there, the earlier one is the Decision and the new one is refused; never received there, the new one is judged; otherwise it is refused (`answer_in_doubt`) and nothing is typed. | F2 |
| E9 | A Decision names one of the Ask's own options, with the label taken from the Ask, or carries the principal's words. Anything else is refused. The words reach the asker; the record keeps only their length and a hash. | F4 |
| E10 | An Ask on the manager's list is answerable only while the list has it open. An unreadable list refuses every answer and changes no state. An id not on the list yet is not answerable, and counts as settled 10 minutes after it was asked. Any other id expires 24 hours after it was asked. | F2, F4 |
| E11 | Asked again (a newer ask for the same id) after a Decision, the Escalation is open again: the earlier Decision doesn't answer the new question. | F2 |
| E12 | An answer that names the version of the Ask it was given for (when and in which message it was asked, its wording, options and terms) is refused as changed if the Ask was restated since: it never answers a question the principal didn't see. (ADR-0009: the phone holds an answer 5 seconds.) | F2, F4 |
| E13 | A Decision for the manager goes through its inbox ([ADR-0010](adr/0010-manager-inbox.md)): Queued until the inbox reports it in the manager's conversation, then Delivered. Queued, it counts as given (E8). Given up by the inbox (expired, or cancelled by hand), the Escalation is open again and nothing is recorded. | F1, F2 |

A Decision is a Command under Access (AC7). It is recorded only after the asker has it (delivered into its pane; for the manager, Delivered by its inbox, E13), with the endpoint, session and time as provenance (A1).

**Decision or task, and the short form (2026-10-04, ADR-0009).**
- **Decision or task:** the manager's list decides by its kind. `tap` is a decision; `time` is a task, an Ask for his time or hands, never "decided". A button message alone asks a decision.
- **The short form:** an Ask may carry the asker's own short form: `shortTitle` (a few words), `summary` (one sentence), `minutes`, `link` (http(s) only) and `details`. The list's own `options` make it answerable by a tap, under E9 like any option.
- **A task's Done** is an answer in words ("Done") under E8 to E12. Its Later is this device's memory only (C6).

### Notifications: a nudge, not a Delivery

Added 2026-10-02 by [ADR-0008](adr/0008-patterns-borrowed-from-signal.md), with the product lane's constraints (an internal decision record, §12, binding). A web push to the principal's devices is not part of the Escalation model above: E2 and E3 stay deferred, E4 stays the scorer's check, and nothing here satisfies any of them.

| Term | Means | Is not |
|---|---|---|
| Notification | A content-free alert to active Endpoints: how many Asks wait, how many workers need you, or that a device was linked. | A Delivery, an Acknowledgement, a read, or proof he saw anything. |
| Push subscription | A notification channel of one Endpoint: where a push service accepts Notifications for it. | An Acknowledgement; a Delivery target that E3 or E4 counts; an Endpoint of its own. |
| Attending | The principal is using the app on some Endpoint right now: its window has focus, and it saw his input (pointer, key or touch) in the last 2 minutes. | A window that is merely visible, such as a tab left open on the office's shared desktop. |

| # | Invariant | Guards |
|---|---|---|
| N1 | A Notification carries counts only: how many Decisions wait, how many workers need you, and (AC13, the product lane's amendment 7) how many devices were linked, which rides the same counts-only Notification. It never carries a name, a worker, a question or any text; the device builds its words from the numbers. | privacy |
| N2 | A Notification is raised only when a Decision starts waiting, a worker starts needing you, or a device is linked (AC13). Ordinary agent messages raise none. A worker's question or menu is an Ask, so it raises one Notification, as a Decision waiting, never a second as a worker; a worker raises its own only for a need that isn't an Ask. A muted Conversation's worker raises none, except for Decisions (an Ask breaks mute, as a mention does in Signal). | F1 |
| N3 | No Notification goes to any Endpoint while the principal is attending on one of them, except that a device was linked (AC13): the device that approved or issued the link is usually the one he attends on, and every other device must still hear of it. Per Endpoint, the latest one wins after a 1-second pause, and it replaces the previous one of the same kind. | F2 |
| N4 | An Endpoint has at most one Push subscription. Revoking the Endpoint deletes it, and so does a push service answering that it is gone. | AC4 |
| N5 | A Notification grants and starts nothing: no Mandate, Decision, Acknowledgement or Settled state, and no timer started, shortened or ended. E10's clocks keep running from when the Ask was asked. It records no DeliveryAttempted or DeliveryFailed: a counts-only ping would otherwise satisfy E4 for every Escalation it counts, and EscalationOverdue would never fire. | F1, A1, O4 |

Events: NotificationSent and NotificationFailed (time and counts only; a failure also keeps the push service's status and its reason code, a short code and never text; NotificationSent is an audit row), PushSubscribed, PushUnsubscribed.

## Verification: proof the worker didn't produce

Aggregate **Claim**, with Evidence entities, judged against a **Done-means** value object: the Checks plus a hash of what they depend on, frozen before work starts.

| # | Invariant | Guards | Scope |
|---|---|---|---|
| V1 | Verified only if every Check has Evidence from a producer other than the claimant, on the claimed revision. | F3 | needed by the scorer |
| V2 | Any refuting Evidence makes the Claim Refuted, whatever else passed. Output that contradicts its exit code (an error printed with exit 0) refutes. | F3 | deferred until evidence |
| V3 | If the claimed revision changes what a Check depends on (for example, weakens the test), the Claim is Refuted. | F3 | needed by the scorer |
| V4 | Missing Evidence gives Unverified. | F3 | deferred until evidence |

Events: ClaimSubmitted, EvidenceRecorded, ClaimVerified, ClaimRefuted, ClaimLeftUnverified.

## Access: which devices speak for the principal

Added 2026-09-30 by [ADR-0004](adr/0004-principal-web-endpoint.md). Endpoint pairing, listed as deferred above, lands here for the web endpoint. It is modeled on Signal's linked devices.

| Term | Means | Is not |
|---|---|---|
| Hub | The principal's own server process on his machine. It serves the web endpoint and holds Access and Observation state. | A relay, a vendor service, a worker. |
| Hub identity | The hub's key pair. Its fingerprint is pinned by each Endpoint at pairing. | The TLS certificate of the network proxy. |
| Pairing token | A one-time secret issued from the hub's console (later: from an active Endpoint), valid for 10 minutes. | A password, a session, a reusable invite. |
| Passkey | The credential an Endpoint registered at pairing; every use requires user verification. | A shared login; a bearer token. |
| Session | A time-limited login of one Endpoint, started by a user-verified passkey assertion. | The Endpoint itself; proof the principal read anything. |

Aggregates **Endpoint** (with its passkey), **PairingToken** and **Session**.

| # | Invariant |
|---|---|
| AC1 | An Endpoint is paired only by redeeming a pairing token that is unexpired (at most 10 minutes old) and unused. A token pairs at most one Endpoint. |
| AC2 | At most 6 Endpoints are active at once; a seventh pairing is refused. |
| AC3 | A Session starts only for an active Endpoint, from a passkey assertion with user verification whose signature counter did not go backwards, or from the Endpoint's own pairing, once, within a minute of it (the registration was already user-verified under AC1). |
| AC4 | Revoking an Endpoint ends its Sessions at once. A revoked Endpoint never becomes active again; pairing again creates a new Endpoint. |
| AC5 | A Session is valid only within the access policy's idle and absolute limits: 12 hours (2 hours idle), 7 days (1 day idle, the default) or 30 days (7 days idle). The hub holds the policy. A Session past the limits of the policy in force is over for good: before any policy change applies, the hub ends it (SessionEnded "expired"), so loosening the policy extends only live Sessions and never revives an expired one. |
| AC6 | An Endpoint that sees a hub identity different from the one it pinned stops and asks to pair again. |
| AC7 | A Command (text sent into a worker) needs a valid Session whose user verification is fresher than the policy's step-up window: 10 minutes, 1 hour (the default), 8 hours, or only at sign-in; otherwise the principal verifies again ([ADR-0006](adr/0006-slack-style-desktop-client.md)). |
| AC8 | Loosening the access policy (a longer sign-in or a wider step-up window) needs a user verification from the last 5 minutes; tightening it never does. Every change is recorded. |
| AC9 | Watching a worker's terminal or the office's desktop needs a valid Session. Controlling one (keys, pointer, clipboard) is a Command, granted per connection only when the principal asks for it. Starting it needs a user verification from the last 5 minutes, whatever the step-up policy. It then holds while AC7 holds, and lapses as soon as AC7 stops holding. Starting and ending control are recorded; the input never is. |

Events: PairingTokenIssued, EndpointPaired, EndpointRevoked, SessionStarted, SessionReverified, SessionEnded (reason "revoked", "signed_out" or "expired"), HubIdentityMismatch, CommandSent, PolicyChanged, ControlStarted, ControlEnded.

### Adding a device from an active Endpoint

Added 2026-10-02 by [ADR-0008](adr/0008-patterns-borrowed-from-signal.md), modeled on Signal's linked devices, with the product lane's constraints (§12). Two new sources of a pairing token join the console; AC1 and AC2 hold unchanged for both.

| Term | Means | Is not |
|---|---|---|
| Link request | A not-yet-paired device's ask to be added, shown on it with a 6-digit code and a QR code of its address. An active Endpoint approves or denies it. | A pairing token, a login, or anything the requester can redeem by itself. |
| Link code | Six digits the hub draws for a Link request, or for a pairing token issued by "Add a device", shown on one device and typed on the other, so approving needs the device in front of you (amendment 11). | A secret: the requester's own secret collects a Link request's token. Compared on two screens: it is typed. |

| # | Invariant |
|---|---|
| AC10 | An active Endpoint issues a pairing token, or approves a Link request, only with a user verification from the last 5 minutes (as in AC8 and AC9). PairingTokenIssued records it as the issuer. A token issued by "Add a device" carries a 6-digit code, shown on the issuing screen and typed on the new device before it pairs; the link alone isn't enough, and a wrong code ends the token at once (amendment 11). |
| AC11 | A Link request lives 10 minutes, at most 3 are open at once, and it is answered once: approved, which binds exactly one new pairing token to it, or denied. Approval needs the code the new device shows, typed on the approving device; a wrong one ends the request at once, with no second try (amendment 11). Only the requester's secret collects that token. An expired, denied or mistyped request yields nothing. The approving screen shows what the hub knows of the requester (when it asked, and the network's identity header if present), never the code. |
| AC12 | An Endpoint paired with a token from an Endpoint or a Link request starts with no step-up credit: its first Command needs a fresh user verification, whatever the step-up policy. An Endpoint paired from the console keeps its registration's credit toward AC7. |
| AC13 | When a device is linked from an Endpoint or a Link request, every active Endpoint is told: a notice in the app, and a Notification (N2). An Endpoint that wasn't connected then is told when it next connects, until it has seen it. |

Events: LinkRequested, LinkApproved, LinkDenied, LinkExpired, LinkCancelled, LinkCodeMismatched; PairingTokenIssued (issuedBy the Endpoint), PairingTokenCodeMismatched, PairingTokenWithdrawn (by its issuer, or when its issuer is revoked).

### Steering: files sent with a Command

Added 2026-10-01; extended 2026-10-11; code in `packages/domain/src/steering.ts`. An **Upload** is a file the principal pasted or attached. It is saved on the office's machine, and a worker opens it by its path. The UI shows a file chip (name, type, size). Markdown and PDF are never rendered as HTML unless the existing sanitiser has already cleaned that HTML.

| # | Invariant |
|---|---|
| S1 | An Upload is allowed only when its extension and its bytes agree. An image extension (PNG, JPEG, GIF, WebP) is accepted by its bytes even when they are a different one of those types, and is refused when the bytes are not an image; images and PDF are at most 10 MB, and PDF bytes start with `%PDF-`. Text (`.md`, `.txt`, `.json`, `.csv`, `.yaml`, `.yml`, `.log`) is valid UTF-8 with no NUL byte and at most 1 MB; a text file is not judged by a binary's ASCII prefix. Executables, archives, HTML and SVG are refused. A name is the last path segment, with no leading dots and no characters outside letters, digits, `.`, `_` and `-`, at most 80 characters: a longer name loses stem and keeps its extension. |
| S2 | A Command attaches only Uploads made from its own Endpoint, within a day of upload, each once, at most six. |
| S3 | The Command names each attached image after the principal's own text, one note per image, in the form the workers already read; a Command may be only images. |

### Steering: the outbox

Added 2026-10-02 by [ADR-0008](adr/0008-patterns-borrowed-from-signal.md), modeled on Signal's send queue, with the product lane's constraints (§12, and the brief's amendment 10).

| Term | Means | Is not |
|---|---|---|
| Outbox | The Commands one Endpoint has queued and not yet seen through, kept on that device across reloads. | A record on the hub; a Delivery. |
| Request id | The identity of one Command, the same for every attempt to send it. | A session or a message id in the transcript. |
| Needs-you state seen | What the worker was waiting for when the Command was written: `none`, or the id of the question or menu it showed. | Whatever the worker shows when the Command arrives. |
| Send state | Where a Command stands: Queued, Sending, Sent (the hub typed it; for the manager, the manager's inbox has it and types it once, ADR-0010), Echoed (it shows in the Conversation); or Not sent with a reason; or Uncertain (the hub stopped, or lost the worker's machine, while typing it, so it may have been typed). | A Delivery state (accepted, failed, unknown) of an Escalation. |

| # | Invariant |
|---|---|
| S4 | A Command enters the Outbox before its first attempt, with one request id for all its attempts. Commands to one worker go in the order they were queued; different workers don't wait for each other. |
| S5 | Within 24 hours of its first attempt, the hub types a request id at most once (for the manager: hands it to the manager's inbox at most once, under the request id, ADR-0010). It records the request as started before typing and as done after, durably, and keeps the record 24 hours. A repeat of a done request answers "duplicate"; a repeat of a started one that never finished (the hub stopped while typing) answers "uncertain" and is never typed again, unless the hub can ask the worker's machine (a fleet, fleet core §3.1): typed there, it answers "duplicate"; never received there, it is typed now. |
| S6 | Every Command carries the needs-you state it saw. The hub judges it on arrival: if the worker's state differs in either direction (answered, asked again, changed, or a question or menu showing where there was none), the Command is refused as `stale` and never typed; the app says "The question changed: review before sending". With `none` and still nothing showing, it goes through, so steering a busy agent keeps working. AC7's freshness is also judged on arrival ("Not sent: verify", one tap). The check runs before the terminal adapter's own guard against typing into a menu, which stays as the last guard. |
| S7 | An Endpoint retries a Command on its own only within 2 minutes of queueing it. After that, only the principal moves it: Retry, with the same request id and only while the hub still holds its record (24 hours, S5), or Discard. An Uncertain Command is never sent again on its own. It offers Check again, the same request id once more within that window, which ends it Sent if the hub finds it typed or types it now (S5), or Not sent if the hub finds it never typed and refuses it now (a 404, a 403 step_up or a 409 other than uncertain and not_submitted, which comes after the paste), and Discard. Any other answer leaves it Uncertain. A first attempt answered not_submitted is Uncertain too, never Not sent (ADR-0008, phase C). |
| S8 | A send state only moves forward: Queued, Sending, Sent, Echoed. A late failure never turns a Sent Command back into Not sent. The one way back is the principal's Retry, which returns a Not sent Command to Queued with the same request id. Uncertain moves only by Check again (S7): to Sent, or to Not sent. An echo ends at most one Command, the oldest matching one. |

Decision answers are not in the Outbox: E8, E10 and E11 already judge them on arrival. Events: CommandSent (as before). A refused Command is answered with its reason and logged, never with the text, and not audited.

Relations: Access supplies EndpointId to the other contexts. A future Delivery to the web endpoint targets Endpoints that Access holds active. Adapters: the passkey library turns a browser response into the fact "user-verified assertion, counter n"; the network proxy's identity header is a hint and never a login.

## Observation: what the workers are doing

Added 2026-09-30 by [ADR-0004](adr/0004-principal-web-endpoint.md). It is a read model and grants no authority.

| Term | Means | Is not |
|---|---|---|
| Worker screen | The latest text a worker's terminal shows. | Evidence (V1), a Claim, an Acknowledgement or a Decision. |
| Terminal | A worker's pane as the multiplexer draws it (colors, cursor, size), streamed while the principal watches it. | A login shell for the principal; input without control (AC9). |
| Office desktop | The machine's shared graphical desktop, where the agents' browser runs, seen over VNC. | Something a worker owns; input without control (AC9). |
| Feed | The ordered events of one hub run (an epoch), each with a sequence number. | A durable record; Escalations. |
| Cursor | The last sequence number an Endpoint processed, within one epoch. | An Acknowledgement. |
| Resync | The feed's answer when a cursor can't be served: start again from a fresh snapshot. | An error to hide. |
| Conversation | The messages of one worker's session, newest last, as the principal reads them: prompts, replies, activity lines, events, files. | The transcript itself; a record of authority. |
| Attachment | A file a message carries: one a worker sent to the principal, or one the principal sent. The hub keeps its own copy and names it by id. | A path the app may open; Evidence (V1). |
| Message author | Who a message is from: the principal, the worker, a peer session, or the system, taken from the message's source. | Whatever the text claims. |
| Needs you | A worker waits for the principal: an open question it asked, or a menu on its screen. | A finished turn. |
| Offline | The worker's machine doesn't answer now (fleet core §7). The worker stays listed, marked offline, and nothing is typed to it until its machine is back. | Gone; quiet. |
| Engine lane | A worker whose Working and Idle come from this machine's engine registry (`busy`, `idle`) when that setting is on. Its screen text still updates, and a redraw does not flip its state. | A worker followed by its transcript; a worker on another machine; a worker with no registry file. |

| # | Invariant |
|---|---|
| O1 | Within an epoch, feed sequence numbers increase by exactly one per event. |
| O2 | Given a cursor inside the retained window of the same epoch, the feed returns exactly the events after it, in order. Otherwise it returns Resync, never a partial list. |
| O3 | Only the latest state of a worker screen is kept and sent, only when its text changed; intermediate states may be skipped. Activity reaches the feed as state flips (active, quiet), not as one event per change. |
| O4 | Observation grants nothing: nothing in it creates a Mandate, Evidence, a Decision or an Acknowledgement. |
| O5 | A Conversation holds each message once (by its source ID), in time order, and at most its latest 300 messages. |
| O6 | A worker needs you while a question it asked has no answer yet, or while its screen shows a menu; it stops needing you when either is answered. |

Events: WorkerAppeared, WorkerRenamed, WorkerBecameActive, WorkerBecameQuiet, WorkerOfflineChanged, WorkerGone. Screens go only to the Endpoint that watches that worker, outside the feed. When the hub reads this machine's engine registry ([ADR-0004](adr/0004-principal-web-endpoint.md) addendum, 2026-10-08), an engine lane the hub is not following takes its active and quiet flips from that registry (`busy`, `idle`) rather than from its screen changing. A worker followed by its transcript keeps the screen.

### Read marks, mute and older pages

Added 2026-10-02 by [ADR-0008](adr/0008-patterns-borrowed-from-signal.md), modeled on Signal's read syncs and timeline. These follow the principal across his Endpoints, and grant nothing (O4).

| Term | Means | Is not |
|---|---|---|
| Read mark | Per Conversation, the time up to which the principal has read it, on any Endpoint. | An Acknowledgement, a Decision, or proof he read a given message. |
| Mute | The principal's choice to hear nothing from one Conversation: no unread count and no Notification, except for Decisions. | Hiding its messages; a Mandate. |
| Older page | Up to 100 messages from before a given point, read from the transcript on demand for the Endpoint that asked. | Part of the Conversation the hub keeps (O5). |

| # | Invariant |
|---|---|
| O7 | A Read mark only moves forward: a mark at or before the stored one changes nothing, and a mark later than both the Conversation's newest message and the hub's clock is clamped to the later of the two, so one device's fast clock can't hide unread messages on every device, and a node's fast clock can't leave its newest message unread (FL13). The hub keeps one per Conversation and tells every Endpoint. |
| O8 | A Read mark, like a Notification (N5), grants and starts nothing: no Mandate, Decision, Acknowledgement or Settled state, and no timer started, shortened or ended. |
| O9 | An older page holds each message once, in time order, all strictly before the point asked for. An empty page means the beginning of the Conversation. The hub keeps nothing of it, so O5's 300 is unchanged. |

Events: none in the audit. A Read mark or a mute is a preference, kept as its current state and told to every device as it changes; its history is not kept.

Relations: downstream of the terminal multiplexer adapter (increment 1) and later the agent CLI hooks. Nothing flows from Observation into Authority or Verification. Since 2026-10-01, Escalation reads worker questions and menus through Observation's adapters to raise Asks. Nothing is decided from them (O4): those Asks are answered on the worker's own screen.

## Catch-up: working through what waits

Added 2026-10-04 by [ADR-0009](adr/0009-phone-catch-up-and-horizon.md); code in `packages/domain/src/catchup.ts`. A read side over Escalation (open Decisions) and Observation (Conversations past their Read mark). It grants nothing.

| Term | Means | Is not |
|---|---|---|
| Catch-up | The principal working through what waits for his call and what happened since he last looked, one card at a time. | A Delivery, an Acknowledgement, or a Decision of its own. |
| Card | One open Ask that waits for his call (a decision card), or one Conversation with messages after its Read mark (an update card). | A message; an Ask for his time (those are the dashboard's). |
| Run | One pass through the cards, from opening catch-up to "You're caught up", kept on the Endpoint that made it. | A record on the hub. |
| Kept for later / kept unread | A card he set aside in this run: a decision (later) or an update (unread). | A Read mark, a snooze of the Ask, or anything the hub hears of. |
| Last caught up | When he last finished a run, on any Endpoint. | A Read mark; a timer. |

| # | Invariant |
|---|---|
| C1 | Every open Ask that waits for his call has a card, whatever he read or muted. It leaves the stack only by being answered, settled or expired; "later" takes it out of one run only. A decision card is never marked read. |
| C2 | A Conversation has an update card when it isn't muted and has a message after its Read mark. Two panes with one name share one card, as they share one Read mark (O7). |
| C3 | Decisions come first: blocking, then the earliest due or default time, then the oldest. Then updates: needs you, then "says done", then the most recent. Cards that join during a run take their place among those still to come; the card on top and the ones passed don't move. |
| C4 | A muted Conversation gets no card; its unread messages are only counted, so the end of the run can say how many were skipped. An Ask from it still has its card (as in N2). Amended by ADR-0011: on the phone's decisions-only run no lane's updates are shown, so nothing is counted as skipped and the end shows no "muted, skipped". |
| C5 | An update card shows what came after the Read mark: the newest messages and the whole of it in counts. "Mark as read" moves the mark to the last message shown, never further. "Says done" is the worker's own word (its last answer led with STATUS: DONE), never a Verdict (V1). |
| C6 | Catch-up grants and starts nothing, as O8 and N5: marking read, keeping unread, later and last caught up never answer, settle or delay an Ask and start no timer. Keeping unread and later stay on the Endpoint. An answer from a card is a Decision under E8 to E11 and AC7, sent only after a 5-second window in which Undo sends nothing; offline it is refused, not queued. A reply from a card is a Command in the Outbox (S4 to S8). |
| C7 | Last caught up only moves forward and is clamped to the hub's clock, as a Read mark (O7). Nothing is decided from it. |

Events: none in the audit. Last caught up is a preference kept as its current state and told to every device; its history is not kept.

## Fleet: where the workers run

Added 2026-10-06 by [ADR-0012](adr/0012-fleet-pull-agents-and-a-separate-fleet-service.md); design in [`design/fleet-core/README.md`](design/fleet-core/README.md). The workers run on one machine or several. Each machine that hosts them is a Node. The Fleet, on the control plane, knows the nodes, routes typed operations to them and delivers what their hooks report. Like Observation, it grants nothing (O4): it carries Commands and Decisions to a pane and decides none.

| Term | Means | Is not |
|---|---|---|
| Node | A machine that hosts workers, known to the Fleet by a name and a public key. Its agent dials the Fleet, never the reverse, and acts on that machine only. | A login to the machine; an isolation boundary (the workers run as the same user as its agent). |
| Fleet | The control plane's service that knows the nodes, routes operations to them, keeps the Lane registry and runs the Hook bus. Its clients are the hub, the chat bot and the owner's tools. | The hub: a hub deploy or crash never cuts the other clients off from the nodes. |
| Join | A node's one-time admission: it redeems a Join code and pins the Fleet's public key, and the Fleet keeps the node's public key. | Pairing (AC1), which admits an Endpoint of the principal, not a machine. |
| Join code | A one-time secret, valid 10 minutes and bound to one node name, printed with the Fleet's address and public key. The Fleet keeps only its hash. | A password, a reusable invite, or anything the node presents again. |
| Instance | One running agent process of a node, named by a random id per process. | The node: a node has at most one live Instance. |
| Worker ID | `<node>.<server>.<pane>`: one pane of one run of a node's terminal multiplexer server. Opaque outside its node. | The multiplexer's pane number, which a restarted server hands out again. |
| Expectation | What a caller saw of a pane when it decided to act on it: its server, window and session. The node checks it immediately before acting. | A lock or a lease. |
| Operation key | The caller's name for one side-effecting operation, the same for every retry of it, namespaced by client. | The id of one attempt; a Mandate. |
| Lane | A worker as the principal names it: its window's name, unique across the Fleet. | The pane or the session behind it. |
| Lane registry | The Fleet's record of which node each lane name belongs to, and of the names in conflict. | Where the workers run: each node reports that itself. |
| Store | A node's own database of Operation keys and its Hook stream, named by the stream's id. A new or restored database is a new Store. | The node: a node that loses its database keeps its name and key. |
| Hook stream | One node's durable, ordered hook events: a stream id made with the node's store, and sequence numbers from 1. | The feed (O1), which is one hub run's view. |
| Hook bus | The Fleet's delivery of hook events to its configured subscribers: at least once, in order per stream, each event with an idempotency key. | Exactly once: subscribers deduplicate. |
| Alert | Something for the owner to look at that changes no state: a second Instance, a node's network source changed, a clock offset, a node over its message rate, a lane name in conflict, a dead letter, a full backlog. | An Escalation: nothing waits on his answer. |

Aggregates **Node** (its key, Instance and status: online, stale, offline or revoked), **JoinCode**, **LaneName** and **HookStream** (with what each subscriber has had delivered).

| # | Invariant |
|---|---|
| FL1 | A node is admitted only by redeeming a Join code that is unexpired (at most 10 minutes old), unused and bound to that node's name. A code admits one node, once, under its own name. |
| FL2 | Every connection proves both ends before any operation. The node signs the Fleet's fresh challenge with its key, and the Fleet signs the node's fresh challenge with the key the node pinned at its Join. A mismatch on either side ends the connection. |
| FL3 | A node has at most one live Instance. Another Instance with the same key is admitted only if the live one fails to answer a ping within 3 seconds (then the live one's connection is closed): a crashed or half-open Instance can't lock its node out. Otherwise it is refused, with one Alert per refused Instance while the live one lasts, and it tries again every 5 minutes. The same Instance reconnecting replaces its own old connection. |
| FL4 | A revoked node is cut off at once and never connects again. Its lanes are never listed and nothing is routed to it. Joining again takes a new Join code. |
| FL5 | A Worker ID names one pane of one server run and is never given to another pane. A restarted server is stamped anew, so its old Worker IDs answer `no_pane`. |
| FL6 | A side-effecting pane operation acts only while its Expectation holds, checked inside that pane's queue immediately before acting. Otherwise it is refused as `no_pane`, not executed. |
| FL7 | A keyed operation takes effect at most once per Operation key within 7 days. The node records the key as started, durably, before the side effect, and as done, with its outcome, after it. A repeat answers with the outcome (done) or with uncertain (started, never finished); a repeat whose effect-deciding arguments differ from the key's is uncertain too. A refusal before any side effect releases the key, so a retry may act. Every answer names the node's Store (where its keys live): a node that answers "unknown" from another Store than the one that took the operation can't vouch for it, and the operation stays in doubt. |
| FL8 | Every refusal says whether anything ran: `no` (safe to retry) or `maybe`. Only `uncertain` and `internal` are `maybe`. |
| FL9 | A lane name belongs to the node that registered it first. A name reported twice, by two nodes or by two windows, routes nowhere by name until the owner resolves it (`lane_conflict`, not executed), and raises an Alert; every window stays listed, and an operation on a Worker ID still reaches the pane the principal picked. Starting a lane under a registered name, or one whose start is under way, is refused (`name_taken`). |
| FL10 | A hook event is acknowledged to its sender only once it is durable on the node, and the node is acknowledged only once the event is in the Fleet's outbox. Within a stream, sequence numbers grow by one, and a new stream never collides with an old one. |
| FL11 | Each subscriber gets each event at least once, in order per stream, under the key `<node>:<stream>:<seq>`, and deduplicates on it. An event a subscriber refuses (a 4xx other than 408 and 429), or one that fails 20 times, goes to dead letters with an Alert. |
| FL12 | A node that drops off is shown offline with its workers, never as gone. Operations to it are refused as not executed (`node_offline`). One node's slowness never delays another node's operations or observations. When the Fleet itself can't be reached, every worker is shown not online and the hub says the Fleet is unavailable. |
| FL13 | Correctness never depends on the clocks agreeing: the time a Command was typed is the node's own, on the clock its transcripts use. An offset of more than 2 seconds raises an Alert. |
| FL14 | The Fleet runs typed operations only, never a command line, and no credential of an agent CLI crosses it. A node's own policy may refuse any operation (`denied`). |

Events (the Fleet's audit): JoinCodeIssued, NodeJoined, NodeConnected, NodeStale, NodeOffline, NodeRevoked, InstanceRefused, InstanceReplaced (a live Instance that missed the instance check), LaneRegistered, LaneConflicted, OperationRun (every side-effecting operation: which client asked, its target, its key's namespace and its outcome, never its text), HookDeadLettered, AlertRaised. The audit, Alerts included, is kept 90 days. Hook events themselves are not audited. They are kept until delivered, plus 24 hours.

Relations: the Fleet supplies Observation and Steering (see the context map). Access, Authority, Escalation and Verification stay on the hub. The Fleet never sees an Endpoint or a Mandate, nor what a Decision means.

## Connections: what can run the work ([ADR-0018](adr/0018-secret-store-and-api-key-providers.md))

One thing the user registered on this machine that can run agent work: a subscription account or an API key. Code in `packages/domain/src/connections.ts`. The vendor catalog is data (`packages/protocol/catalog/vendors.json`); no vendor name appears in this context. A key holds a secret ref and a fingerprint. The bytes stay in the vault.

| Term | Means | Is not |
|---|---|---|
| Connection | A named registration: kind, vendor, runtime, custody, status, terms acknowledgement, repo list, isolation, and for a key its secret ref, fingerprint, billing, budget and expiry. | A sign-in token; a role. |
| Kind | `subscription` (the CLI's own sign-in; at most a config-directory path) or `api-key` (a key in the vault). Fixed at creation. | A vendor. |
| Custody | `morndo` (Morndo starts the runs) or `engine-layer` (the engine layer starts them and holds any key). The gate does not reach engine-layer runs. | A kind. |
| Billing | Of a key: `metered` or `prepaid`. | A budget. |
| Status | Stored: `on`, `off` (anyone; reversible), `revoked` (the principal; permanent). | Availability. |
| Availability | Derived when asked: terms, expiry, budget, off, revoked. Signed-out is a runtime probe, not stored here. | A promise a run will succeed. |
| Terms acknowledgement | Who read which revision, and when. The connection cannot run without the current revision. | A contract with the vendor. |
| Repo list | Optional allow and deny patterns over git remotes and path prefixes. None means every repo is allowed. | A class Morndo infers. |
| Isolation | `none`, `rules`, or `os`. A run gets at least the preset floor, and `os` when a repo list is set. | A separate user. |
| Secret ref, fingerprint | An opaque id, and 12 hex characters computed outside this context. | The secret bytes. |
| Budget, run spend, balance reading, expiry | Of a key in Morndo's custody. Unlimited only as a stated choice. A run spend is one run's estimate, provider figure or manual figure, and these add. A balance reading is the provider's cumulative total and replaces what came before it. | The vendor's own limit. |
| Lease | Permission for one holder to run once. A probe reserves nothing. Recorded before any adapter opens a secret. | A mandate. |
| Holder | Node, pid, start ticks, boot id, and the lane it claims. | Proof of who the lane is. |

| # | Invariant |
|---|---|
| CN1 | No secret and no sign-in token in the model. A key holds a ref and a fingerprint. A subscription holds at most a config-directory path. |
| CN2 | Names match `[a-z][a-z0-9-]*`, are unique including revoked ones, and are never reused. Rotation keeps history, budget and spend, and changes the fingerprint. A fingerprint that matches any other connection, revoked included, is refused. |
| CN3 | Kind, vendor and runtime are fixed at creation. A subscription has no ref, budget or expiry. A key in Morndo's custody has a ref, a fingerprint, a billing, a budget and an optional expiry, required when prepaid. Engine-layer custody has none of those here. |
| CN4 | A connection cannot run until the principal acknowledges the current terms revision. A new revision asks again. A revision marked unknown has no source and cannot be acknowledged. Engine-layer custody stays unarmed until then. |
| CN5 | The model has no field a secret could travel in. Args, environments and logs are enforced at the edges. |
| CN6 | A run gets at least the preset floor, `os` when the connection has a repo list, and whatever more the principal set. A runtime that cannot give it refuses the start. |
| CN7 | No repo list allows every workspace. Deny wins over allow. An allow list admits only matches, against the real path and the git remotes. |
| CN8 | The lease gate, in order: on; terms at the current revision; (key) now before expiry; the repo list admits the workspace; the runtime can give the isolation; the runtime speaks the dialect; open leases under the limit; (key) budget minus spend minus reservations minus margin leaves a positive reservation. The reservation is the smaller of the role's reserve and that remainder. The first failure is recorded and the exit is 75. |
| CN9 | `LeaseGranted` is on the directory before the function returns. A helper serves only a live lease whose holder is the caller or an ancestor, at most N times per refresh interval. A refresh does not reset that window. Past N, a refused refresh, or revoke, the lease's authority ends and the helper is refused. The lease stays until it is closed, so the run's spend is still recorded. A call after close is refused and is not misuse. |
| CN10 | Spent is the sum of run spend when no balance reading has been recorded, otherwise the newest balance reading plus every run spend after it. An estimate never lowers it. |
| CN11 | When spend plus open reservations reaches the budget, no new lease is granted. A refresh excludes that lease's own reservation and applies the margin, and is refused when the room left is not positive. |
| CN12 | Each budget fraction (0.5, 0.8, 0.95) warns once from spend, not from open reservations. Each expiry lead (7, 2, and 1 days) warns once. A check run warns every key, including one with no lease. Extending an expiry clears that key's lead markers so the new date can warn. The dedupe key is `connection:threshold`. |
| CN13 | Narrowing is anyone's. Widening is the principal's, judged by effect: afterwards the connection may run, in more workspaces, spend more, run longer, or run with less isolation. Emptying a non-empty allow list widens, because an empty allow list admits every repo the deny list does not name. A negative figure or a balance reading that lowers spent widens. Revocation is the principal's. |
| CN14 | Off and revoke stop new leases at once and open ones at the next refresh. Off is undone by turning on. Revoked is never on again. |
| CN15 | A connection grants nothing. Which connection runs a role is the routing policy. A lease is not a mandate. Spend decides only the lease gate. |

Aggregate **Connection**, with its open leases inside it. Closed leases leave as events. The clock is the `now` argument.

Events: ConnectionAdded, ConnectionRotated, ConnectionRevoked, ConnectionTurnedOn, ConnectionTurnedOff, TermsAcknowledged, TermsChanged, RepoListChanged, IsolationChanged, BudgetChanged, ExpiryChanged, LeaseGranted, LeaseRefused, LeaseRefreshed, LeaseRefreshRefused, LeaseClosed, LeaseLost, SpendRecorded, SpendReconciled, ThresholdCrossed. Widening events carry the command id.

## Engines: which AI does each role's work ([ADR-0013](adr/0013-engines-settings-page.md))

The principal picks, per **Role**, which provider and model does the work, and what falls back. The settings belong to the engine layer outside Morndo (its own file, written only by its CLI). Morndo holds the language and the rules of the page that edits them. It reads and writes only through that CLI, behind an adapter (see the context map).

| Term | Means | Is not |
|---|---|---|
| Role | A kind of work a lane does: plan, implement (backend, UI, infra), validate, review, research, read long documents, images, video. The engine layer names them. | A lane or a worker. |
| Engine | `provider:model[@effort]`: who runs the work, with which model, at which effort (none: the provider's default). | A worker; a subscription. |
| Chain | A Role's Engines in order: the **first choice**, then its **fallbacks**. The first one available runs. A Role may also have a **risk chain** for risk-area work. | A rotation; a vote. |
| Availability | How a provider stands as the engine layer's resolver reports it: ready, sign-in not checked, not signed in, not installed, out of quota (until a time), off. | A promise that a run will succeed. |
| Other-provider rule | For review: the reviewer's model comes from another family than the implementer's. | A rule about accounts or plans. |

- **R1** An Engine reads and writes as the CLI's text, in the CLI's grammar, so nothing the page writes is refused for its shape.
- **R2** A provider's availability follows the resolver's order of checks: off, not installed, not signed in, out of quota. A sign-in nobody checked still runs, with a warning.
- **R3** Edits are pure and return the new Role or the reason they can't: replace an Engine, add a fallback, remove one, move one up or down, switch the rule. An Engine fits when the provider is known, the model is one of its known models, and the effort is one it takes (none always fits). The same Engine twice in a Chain is refused, since the second could never run. A Role always keeps one Engine, and holds at most eight (`MAX_CHAIN`: a first choice and seven fallbacks).
- **R4** A save writes, per Role that changed, its whole Chain in order and its rule, each only when it changed.
- **R5** A save is checked whole before the first write, against the Roles and providers as they are now: known Roles, one change per Role, no empty Chain, readable Engines, each one fitting, and no new copy of an Engine. A refused copy is named, so the page can say which to remove. A Chain may not be longer than eight Engines, or than it already was: a Role set longer by hand can still be saved, but only shorter or the same length. What the Role already had keeps the two leeways the CLI allows, its copies and a model outside the known list (written with `--force`); the page keeps them, never adds one, and marks a lower copy "never runs". Every other entry rule of the CLI (a known provider, an effort it takes) holds for every entry written, so no save half-lands. A change with nothing in it is dropped. A provider that lists no models takes any model, and a model's `[options]` don't count, as in the CLI. A save is a Command (AC7). A save made against settings that changed since the page read them is refused, and saves run one at a time.
- **R6** Every write a save made is recorded in the audit log as it lands, with the Endpoint it came from (`EnginesChanged`). A save that fails part way leaves a true log and names the Roles it saved.

A **Routing policy** (ADR-0018, `packages/domain/src/routing.ts`) decides which connection runs a role. Connections never reads it.

| Term | Means | Is not |
|---|---|---|
| Pick | `connection:model[@effort]`, in the role's own order. Risk picks are apart. | The chain. |
| Priority | A mode and an order of connection names. Modes: subscriptions first, keys first, subscriptions only, keys only, custom. | A rotation. |
| Override | `follow` the global priority, `own` a priority that replaces it, or `hand` (the picks are the chain). | A merge of two priorities. |
| Derived chain | The picks kept where the connection is in the role's effective order, stably sorted by that order. | Availability. |
| Drift | A derived role whose chain outside Morndo is not the one last written. A hand role is never drifted. | An error. |

- **R7** A priority's order has no duplicate names, and every name is a connection known on this node.
- **R8** The effective order filters by kind, partitions stably by kind, or keeps a custom order. Unknown names drop out. Availability never reorders.
- **R9** A role follows the global priority unless its override is `own` or `hand`.
- **R10** The derived chain keeps picks whose connection is in the effective order, stably sorted by that order. Two picks on one connection keep the role's order. A hand role's chain is its picks as they are. The risk chain is derived the same way and written beside the main chain; none means no risk chain.
- **R11** A save is checked whole. Each derived chain has 1 to 8 entries, and each new pick fits the connection's models and efforts. Changing the priority or a role's override re-checks every chain that change derives, and refuses one that comes out empty, longer than eight, copied, or unfit. A hand role keeps a copy or a model outside the list only when it already had it, and keeps its length. It never adds a new copy, a connection this node does not know, or a model outside the list. A role whose connections are all unavailable still saves.
- **R12** A new connection goes to the end of the global order. When it can run, every role that is not hand gets the preset's default pick where the model is listed and the chain passes the same check as a save. A role that already has that pick is left as it is. Skipped roles are named. This step is not a principal command.
- **R13** A priority, override or picks change is a principal command. R12 and R15 are the exceptions. Events carry the command id, or none for those two steps.
- **R14** Morndo records each chain it writes, the risk chain included when the role has one. A derived role whose chain or risk chain changed outside is drifted and is not rewritten until the principal re-applies or sets the role to hand. A hand role's picks are read back, so an outside edit is not drift.
- **R15** A revoked connection leaves every order and its picks are removed, risk picks included. An emptied derived chain, main or risk, keeps the last chain written. The name stays in a written chain until nothing names it.

Events: PriorityChanged, OverrideChanged, PicksChanged, ChainProjected, ChainDrifted, ChainKept.

## Board: who is doing what ([ADR-0015](adr/0015-board-tasks-for-agents.md))

The team's task board, run as a real org runs one. The manager files tasks and hands each to a lane; the lane moves its own along as the work goes; the principal reads it instead of asking, and may do anything the manager may. Code in `packages/domain/src/board.ts`.

| Term | Means | Is not |
|---|---|---|
| Task | One outcome a lane can finish: a key (`T-12`), a title, what done means, a status, an assignee, a priority, and its record. | A message; a Claim with Evidence. |
| Status | Where the work stands, in order: backlog, to do, in progress, blocked, in review, done. | A Verdict. |
| Assignee | The lane name the task belongs to; nobody while it is a proposal. | A worker id (a pane): a lane name outlives its pane. |
| Actor | Who changed the board: the principal from an Endpoint, the manager by its agent token, or a worker lane by a worker token naming it. | A name taken from a conversation's text. |
| Agent token | A credential the hub's console issued for the manager's lane or for the worker lanes, kept as a hash, revocable. | A passkey; a Session. |
| Record | The task's events in order, each with its actor and time; a comment is one. | A transcript. |

| # | Invariant |
|---|---|
| B1 | Every change to the board comes from an Actor with provenance: the principal's Endpoint and Session (a Command, AC7), or an agent token's id and the lane it acts as. Text in a conversation changes nothing. |
| B2 | Only the manager or the principal files a task for a lane, assigns, reassigns or edits one. A worker's filing is a proposal: it lands in the backlog, nobody's, whatever it asked for. |
| B3 | A worker moves only tasks assigned to it, and never to done. Done is the manager's or the principal's acceptance; it is not a Verdict (V1). |
| B4 | The moves are a fixed graph. The manager and the principal move a task anywhere but where it is. A worker moves its own task to in progress (from backlog, to do, blocked or review), to blocked (from in progress, with a reason), to review (from in progress) or back to to do (from in progress or blocked). Nobody moves an unassigned task to in progress; blocked always says why. |
| B5 | A lane has at most one task in progress. A second move to in progress, or a handover to a lane that has one, is refused naming the other task. |
| B6 | Every change is one event appended to the task's record with its Actor and time, and raises the task's revision by one. A change that names the revision it saw is refused as changed if the task moved since. The audit log keeps the task, the kind of change and the Actor, never a comment's words. |
| B7 | A task's number comes from a counter that only grows, so a key is never given twice, across restarts. |
| B8 | The board grants nothing: a status, a comment or an assignment is never a Mandate, a Decision, an Acknowledgement, Evidence or a Verdict. "Done" on the board is a person's or the manager's acceptance of a lane's word. |

Events: TaskFiled, TaskMoved, TaskAssigned, TaskEdited, TaskCommented (the record), BoardChanged (the audit row).

## Usage: how much of each account is spent ([ADR-0016](adr/0016-home-usage-across-accounts.md))

A read model, like Observation: what each connected account has used of its rate-limit windows, as the agent CLI's own status line reports it from inside each session. Code in `packages/domain/src/usage.ts`.

| Term | Means | Is not |
|---|---|---|
| Account | A subscription the lanes run on, by the name the principal gives it. | A device, an Endpoint, a lane. |
| Window | One rate limit of an account: the 5-hour, the weekly, or a gateway's spend limit, as a percentage used and when it resets. | A quota the hub measures. |
| Report | One status line's JSON from one session, under an agent token, named for an account. | A claim about work. |

| # | Invariant |
|---|---|
| U1 | A Report is taken only under an agent token (B1), for the account the call names (none: the default account), with the lane the token acts as. Nothing in a conversation's text is a Report. |
| U2 | Per account, the newest Report sets the windows. A window a Report lacks is kept until its reset time has passed, then dropped (the CLI drops it then too). A Report older than the account's last never moves the windows, though its session is noted. |
| U3 | A session counts as reporting for 10 minutes after its last Report; the account keeps each session's last context used. |
| U4 | Usage grants and decides nothing (as O4): no Mandate, Decision, Verdict or engine choice follows from it. The engines' availability stays the engine layer's (ADR-0013). |

## Jobs: work that outlives the turn ([ADR-0017](adr/0017-background-jobs-that-report-back.md))

One command an agent starts on one node. It keeps running after that turn and reports its end once. Class names and limits come from that node's policy. Code in `packages/domain/src/jobs.ts`. The domain decides the queue. It does not start a process, read a disk, or talk to a fleet.

| Term | Means | Is not |
|---|---|---|
| Job | One command on one node, with an id, a name, a class, a lane, a notify target and a state. | A lane, a pane, a board task, a cron. |
| Class | A name in the node policy with a concurrency limit. Callers pick it. Morndo ships only `default`, limit 2. | A built-in kind of work. |
| Outcome | How a job ended: `exited`, `timed_out`, `cancelled`, `lost`, or `refused` before it ran. | A Verdict. |
| Notice | The one completion handed on: a delivery to a lane, a comment on a task, or the fleet event alone. | A second run of the command. |
| Tail | The last lines of the log, redacted and cut to the delivery size, carried in the notice. | The log file, and the command line. |
| Guard | An optional load and memory line on the node. Absent, nothing is read. Set, a reading over the line delays the next start. | A way to stop a job that is already running. |

| # | Invariant |
|---|---|
| J1 | A job runs only on the node where it was started, as that node's user. Its command line, working directory and log file never cross the fleet. |
| J2 | A job becomes terminal exactly once. It is never started again, including after a reboot or an agent restart. |
| J3 | A terminal job produces one notice. A lane notice is one delivery whose id is `node:job:<jobId>:done`. A task notice is one board comment keyed by the job id. A repeat finds that notice and does not create another. |
| J4 | A job whose process is gone and whose exit was never recorded becomes `lost`. The row stays, and the notice still goes out. A job is never deleted to hide a missing result. |
| J5 | A class runs at most its configured limit. Further jobs of that class stay queued, in the order they were accepted, each with a visible position. A class the policy does not list is `refused`, not left queued. Another class is not blocked by the first being full. |
| J6 | A notice is redacted and at most 8000 characters before it leaves the node. Another lane sees the tail, not the log file and not the command. |
| J7 | A job grants nothing: no Mandate, Decision, Acknowledgement or Verdict, and no board status change. |

A queued job has a position and a reason: `class` when the limit is full, `load` or `memory` when the guard is over the line, `guard_unknown` when a configured guard cannot be read. The guard is off unless the policy sets it. It never settles a running job.

## On the phone: chats, status, and a digest after an absence ([ADR-0011](adr/0011-phone-chat-app.md))

Since ADR-0011 the phone's catch-up holds decision cards only (C2 and C3's update cards are no longer made there). Updates wait in each lane's chat; a digest sums them up only after a real absence.

| Term | Meaning | Not |
|---|---|---|
| Chat | One worker's Conversation as a chat: bubbles, his own on the right, and a composer whose messages are Commands in the Outbox (S4 to S8). | A second channel: it is the same Conversation and the same Command path as the desktop's. |
| Message that matters | An agent's answer that ends a turn (its last words before the next prompt, and its latest so far), a question, or a file it sent him. | Narration in the middle of a turn, a tool call, a prompt, or the system's plumbing. |
| Lane status | One line per worker: it waits for him, works, finished, is blocked, or is idle, and since when. | A Verdict: "finished" is the worker's own STATUS: DONE (V1). |
| Away | No activity of his (focus and input, as N3 counts attending) on any of his Endpoints for longer than his setting. | A closed tab, or a quiet hour on one device while he works on another. |
| Digest | One screen after he was away: per lane that spoke or needs him, one line of what it said, and its counts. | A card stack, a Delivery or an Acknowledgement. |

| ID | Invariant |
|---|---|
| H1 | A chat's unread count counts only messages that matter, after its Read mark. A muted chat shows no count. Reading a chat to its end, with the page visible, moves its Read mark as the desktop does (O7). |
| H2 | The chat list puts the manager first, then the newest activity on top; a worker that never spoke comes last. |
| H3 | A lane waits for him while an open Ask of its own waits (since the oldest), while its last report says STATUS: NEEDS DECISION and he hasn't written to it since (since that report), or while a prompt shows on its screen; otherwise it works while its screen moves; otherwise its last answer's own STATUS word says finished or blocked, else idle. |
| H4 | A digest shows when he comes back (the app starts, or shows again after a minute hidden) only if his last activity on this Endpoint and on every other one is older than his setting: 2, 4 (the default) or 8 hours, only after a night (4 am on the device's clock in between, and at least 3 hours), or never. Nothing known: no digest. The hub keeps his last activity per Endpoint from the attending reports; it grants and starts nothing. |
| H5 | The digest has one line per unmuted lane that spoke since he left or needs him now: needs you, blocked, finished, then the rest, most recent first; the manager first. "Mark all read" moves each lane's mark to the last message the digest covered, never further; "Later" moves nothing. Decisions keep their cards; the digest only links to them. |

## Candidate: Record context (ADR-0002 after the name)

Not adopted; nothing in the trial needs it. The core would be the owner's record: an append-only log of approvals with provenance, worker claims, and checks run by someone other than the worker on a named commit. Authority, Escalation and Verification would become projections of it: status, Verdict and staleness are computed, and a new push voids older Evidence. It would replace the cross-context calls below.

## Context map

**Shared kernel** (identifiers only): PrincipalId, EndpointId, TaskRef, Revision, ActionRef. Clock and storage are ports; the domain holds no file system, terminal or chat API.

**Between contexts:**
- *Authority supplies Escalation* (customer and supplier). Escalation calls Authorize before opening an Ask; MandateGranted supersedes covered Asks (E5). Only an Answer to a policy Ask, given here with a fresh step-up, becomes a Mandate; other answers are Decisions only (K-1, product decision 2026-10-02 §12).
- *Verification publishes to Escalation*: Verdict events become Reports (E6).
- *Verification supplies Authority*: a conditional Mandate ("ship when green") references a Verdict, never a Claim.
- *Board stands beside Observation*: the board says what a lane was asked to do and where it stands; Observation says what the lane is doing on its screen. Neither decides anything for the other, and the board grants nothing (B8). A lane's "in review" is its word, as "says done" is in Catch-up (C5).
- *Jobs stand beside the board and the fleet*. A task notice is one comment and does not move the task (B3, B8, J7). The fleet stores the job's state and a redacted tail. It never stores the command (J1, FL14). The node decides when a queued job may start (J5).
- *Fleet supplies Observation and Steering* (customer and supplier). Observation reads workers, screens and transcripts through it. A Command (S5) and the delivery of a Decision (E8) reach a pane as keyed operations, so neither is typed twice across a dropped connection (FL7). The Hook bus feeds the chat bot, a subscriber, which turns hook events into Escalations through its own adapter.
- *Engines is downstream of Connections* (customer and supplier). A connection name is the provider name the routing policy orders. Connections never reads the routing policy, and no spend figure decides anything but the lease gate (CN15).
- *Connections stands beside Usage*. Usage shows a subscription's windows. It does not grant a lease.

**Anti-corruption layers** (adapters translate; the domain never sees a vendor payload):

| Adapter | Translates |
|---|---|
| Agent CLI hooks (Claude Code) | tool call to Action, Authorize to allow or deny; notification to Ask or Alert; stop to Claim |
| Node agent over tmux and Claude Code's files (`morndo-node`) | panes, windows and the tmux server's stamp to Workers with Worker IDs; Claude Code's session files and transcripts to bytes by session id; a typed operation to tmux commands under the node's policy |
| Hook relay (`morndo-node`, `127.0.0.1:8787`) | a Claude Code HTTP hook to an event of the node's Hook stream, answered only once it is durable (a script path answers 503 when it can't be) |
| Agent CLI channel (Claude Code Channels) | permission request to Ask; Decision to verdict. A transport write is never an Acknowledgement. |
| Agent CLI session list (`claude agents --json`) | "blocked, waiting for" to Ask, as a polling backstop |
| Supervisor activity ledger (firstmate) | "needs-decision" to Ask, deduped on task + key (the ledger is at-least-once); "done" to Claim |
| Push gate (no-mistakes) | gate run result to Evidence (admissible because the gate ran it, not the worker) |
| Chat bot (Telegram) | Escalation to one message with buttons; tap to Acknowledgement or Decision; the principal's own command to a Mandate |
| Manager's needs-you list (its ledger file, read-only) | open and closed items to Asks with their terms (default, recommendation, deadline, blocking) and resolution; the list decides whether an Ask is still open (E10) |
| Manager's chat protocol (`[buttons …]`, `[tap …]`) | a buttons line to an Ask's options; a Decision to the tap line the manager reads; a tap seen in its conversation to "answered elsewhere" (E8) |
| Agent CLI status line (its JSON, posted by the lane's status-line script to `/api/agent/usage` with an agent token) | `rate_limits.*` and `context_window.used_percentage` to a Report for the account the call names (U1); everything else in the document is dropped |
| Agents' board command (`morndo-board`, over `/api/agent/board` with an agent token) | a lane's command line to one change of one Task by one Actor (B1); the hub's refusal to one line the agent can act on |
| Node job supervisor (`morndo-node`) | a class limit and an optional load or memory reading to the domain's queue decision (J5); a process exit to one Outcome; a completion to one Notice. The domain never sees a pid, a unit name, or `/proc`. |
| Event store | persistence and replay (the scorer reads raw trial logs through it) |
| Engine layer's CLI (engine-layer `bin/engines`) | its roles, providers and resolver output (JSON) to Roles, Engines and Availability; a save to `set` and `other-provider --effective` calls; its refusal (exit 2) to "refused" with its words; a shape it doesn't know to "unavailable", never a guess; a CLI older than engine-layer 9f3a28c (no `other-provider --effective`) to "unsupported" (R1, R2, R5) |
| Vendor catalog (`packages/protocol/catalog/vendors.json`) | a preset's id, runtimes, terms and isolation floor to the values Connections and the routing policy take. The domain never names a vendor |
