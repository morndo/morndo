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
| Ask | Anything that waits for the principal's answer and shows as a decision card. A role, not an aggregate: an Escalation that is an Ask (E1–E13), and a Secret request (SR1–SR11, [ADR-0022](adr/0022-secret-requests.md); its domain is built, the hub doesn't raise one yet). Catch-up (C1), Notifications (N2) and lane status (H3) count Asks, whichever aggregate holds them. Each aggregate keeps its own answer rules. | A Report or an Alert, which wait for no answer; an aggregate of its own. |
| Escalation | One item that needs the principal: an Ask, a Report (outcome plus Verdict) or an Alert, identified by a dedupe key. | A message. Re-delivered, it stays one item. |
| Delivery | One attempt to show an Escalation on an Endpoint: accepted, failed or unknown. | Proof he saw it; a transport "ok" is only "accepted". |
| Acknowledgement | An explicit tap or reply from an Endpoint, bound to one Escalation ID. | A read receipt, a sent-message ID, an agent marking a message read. |
| Claim | A worker's statement that an outcome holds on a revision. | Evidence. |
| Check | A named, deterministic procedure fixed in the task's Done-means before work starts. | A model's reading of the transcript. |
| Evidence | The result of a Check run by a producer other than the claimant, on the claimed revision. | Worker output, logs or transcript. |
| Verdict | Verified, Refuted or Unverified. | A boolean. Unverified is never shown as success. |
| Violation | A broken invariant found in a recorded history, tagged F1–F4. | A runtime error. |
| Decision brief | The asker's case for one decision, in the fixed template ([ADR-0023](adr/0023-decision-briefs.md)): the ask, the options compared, why now, what approval authorizes. Filed as one value, shown as one compact card. | A message, a report, or a Mandate request: an answer to a brief grants nothing (DB8). |
| Version | A brief's own number, starting at 1; a restate makes the next. An answer given for an earlier version is refused (E12). | A hash, a timestamp. |
| Lint | The one check a filed brief passes (DB10): errors refuse it, warnings advise the asker and never refuse. | Sanitisation, rendering. |
| Compact card | The card every Ask derives, brief or plain: topic, headline, recommended option, due, minutes, whether it spends. | A preview the asker writes itself. |

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
  - how long it stays answerable: while the manager's list has it open, for a day, while its source shows it, or while the hub holds it open (E14).

| # | Invariant | Guards |
|---|---|---|
| E8 | An Escalation takes at most one Decision. A second answer is refused and shows the first. An answer seen at the asker's end, such as a tap from another endpoint, counts as given. While an earlier answer to the same ask may have been typed (in doubt), another answer is judged only after the hub has asked the asker's machine about the earlier one: typed there, the earlier one is the Decision and the new one is refused; never received there, the new one is judged; otherwise it is refused (`answer_in_doubt`) and nothing is typed. | F2 |
| E9 | A Decision names one of the Ask's own options, with the label taken from the Ask as it showed it when the answer was typed (an Ask restated since keeps no say), or carries the principal's words. Anything else is refused. The words reach the asker; the record keeps only their length and a hash. | F4 |
| E10 | An Ask on the manager's list is answerable only while the list has it open. An unreadable list refuses every answer and changes no state. An id not on the list yet is not answerable, and counts as settled 10 minutes after it was asked. Any other id expires 24 hours after it was asked. | F2, F4 |
| E11 | Asked again (a newer ask for the same id) after a Decision, the Escalation is open again: the earlier Decision doesn't answer the new question. | F2 |
| E12 | An answer that names the version of the Ask it was given for (when and in which message it was asked, its wording, options and terms) is refused as changed if the Ask was restated since: it never answers a question the principal didn't see. (ADR-0009: the phone holds an answer 5 seconds.) | F2, F4 |
| E13 | With a fleet, a Decision for the manager goes through the fleet's delivery queue (fleet-clients §9.1; [ADR-0014](adr/0014-fleet-clients-delivery-queue-and-lane-events.md), which keeps ADR-0010's rules). Queued until the queue reports it in the manager's conversation, then Delivered, and recorded then, at the time it reached the manager. Queued, it counts as given (E8). Given up, never typed (expired, cancelled, or its lane gone), it reached no one: the Escalation is open again, it says Not delivered, and nothing is recorded. Typed and never seen taken, it may have been delivered: it stays given, is never asked again or typed again, and is not recorded. Queued for an Ask that was settled, expired or asked again meanwhile, it is withdrawn; one typed anyway answers the Ask it was given for, and its echo in the conversation is never taken as an answer to the newer Ask. | F1, F2 |
| E14 | An Ask filed through the hub (`tracking: "hub"`) is answerable while the hub holds it open: until its asker withdraws or settles it, and at most 7 days after its due time, when it expires. Overdue is not expired: he can still answer an overdue brief. | F2, F4 |

A Decision is a Command under Access (AC7). It is recorded only after the asker has it (delivered into its pane; for the manager with a fleet, Delivered by the queue, E13), with the endpoint, session and time as provenance (A1).

**Here and elsewhere, per viewer (2026-10-13).** A Decision's `via` is not a property of the answer but of reading it: the record names the Endpoint whose request accepted it, and what one client is told is derived per client (`viaFor` in `escalation.ts`). "Here" means *this Endpoint* — one passkey pairing, as Access models it (AC1: a token pairs one Endpoint; re-pairing is a new Endpoint). A client reads "here" exactly when the record names its own Endpoint, "elsewhere" when it names another's, or when the answer was only seen at the asker's end (typed there by hand: no client of ours). When the record names no Endpoint and wasn't seen elsewhere, no client is told a via at all: the hub took the answer but can no longer say for which client — and absent is not "elsewhere", and never drops the item. So a device paired afresh reads its own earlier answers as "elsewhere": the pairing, not the hardware, is who "here" is.

**Known limit: a hand tap the hub reads late (E8, 2026-10-13).** The hub types its answer to the manager as the same `[tap <id>] <key> (<Label>)` line any tapper types (ADR-0006), and reads the manager's conversation from Observation's copy of the transcript, which carries no mark of who typed a line. A tap of an option the hub holds a row for (its own answer to the same version of the ask: being typed, typed, queued in the inbox, or in doubt with a node to ask) is taken as that row's paste, never as an answer from elsewhere. The hub writes no row after it has read a tap that answers the ask: an earlier row that turns out never typed is dropped, and the ask is judged again from a fresh read before anything is typed. So only one case is left that the hub can't tell: the principal taps the *same option by hand* at the asker's end, and the tap reaches the transcript before the hub writes its own row for that option, but the hub first reads it after. Clocks can't settle that, because the transcript's time is the node's clock, and a mark on the hub's line would change the line every tapper types.
- **The window:** Observation's copy runs behind the transcript by about one poll (`MORNDO_POLL_MS`, 1.5 s by default), by one more poll when the manager's node answers slower than that, and for as long as that node can't be reached. A hand tap is in the window when it reached the transcript within that lag before the hub accepted the same option from a device.
- **The outcome, conservative under E8:** while the hub's row stands, the tap counts as its paste. The ask takes one Decision, the same choice either way, recorded for the device whose answer the hub typed. If that row's node later says it never typed it, the row goes, and the tap then answers the ask as from elsewhere before anything more is typed.
- **What the principal sees:** the device that answered reads "here" and every other device "elsewhere", where "elsewhere" for all would be the truer record. The manager's conversation may hold the tap twice, once from his hand and once from the hub. While the hub's answer is in doubt, the ask stays open and the device that answered is told its answer is in doubt, until a repeat asks the node.
- **Outside the window:** a tap the hub reads before it would write its row answers the ask, and the device's answer is refused (E8). A hand tap of *another* option is never taken as the hub's paste, but if it is read late, both answers have reached the manager by then, and the record keeps the hub's.

**Decision or task, and the short form (2026-10-04, ADR-0009).**
- **Decision or task:** the manager's list decides by its kind. `tap` is a decision; `time` is a task, an Ask for his time or hands, never "decided". A button message alone asks a decision.
- **The short form:** an Ask may carry the asker's own short form: `shortTitle` (a few words), `summary` (one sentence), `minutes`, `link` (http(s) only) and `details`. The list's own `options` make it answerable by a tap, under E9 like any option.
- **A task's Done** is an answer in words ("Done") under E8 to E12. Its Later is this device's memory only (C6).

### Decision briefs: the case for one decision

Added 2026-10-11 by [ADR-0023](adr/0023-decision-briefs.md); code in `packages/domain/src/brief.ts`. A Decision brief is one value in this context, linted once (DB10) and shown as one compact card, brief or plain. An agent files one with `morndo-decide` or `POST /api/agent/decisions`; the hub stores it and sights it as an Ask (`tracking: "hub"`, or the list item its `ref` names). The guide an asker follows is `docs/agents/decision-requests.md`.

| # | Invariant | Guards |
|---|---|---|
| DB1 | A brief has 2 to 6 options. Keys are letters, digits, `-` and `_`, at most 16, unique; labels are 1 to 40 characters with no control character. This is the manager protocol's grammar (`optionsProblem`), so every answer can be typed back as a tap line. | E9 |
| DB2 | `recommend` is one of the options. The headline names exactly that option, as `option <KEY>` (any case), and names no other key. | F2: an answer he didn't mean |
| DB3 | A brief has a due time after the time it is filed or restated, and `minutes` from 1 to 30. | the owner's "decision due" |
| DB4 | The comparison has 3 to 10 factor rows and one column per option, in the options' order: every row has exactly one non-empty cell per option ("n/a" is a value; an empty cell is not). It has a note on what the numbers include. | "every option has a column" |
| DB5 | A money figure anywhere in the brief (a currency sign or code next to a number) needs at least one stated assumption. Every brief states a downside case. | the owner's rule for money |
| DB6 | Each required section of the template is present, non-empty and within its cap. An unknown section is refused, so a misspelt heading never drops its text. | vague briefs |
| DB7 | Prose fields use the subset: paragraphs, lists, bold, italic, strikethrough, inline and fenced code, block quotes, GFM tables, and links whose target is `https:`. No headings (the format owns the outline), no raw HTML, no images. What lint accepts, the renderer shows; what the renderer would drop, lint refuses. | A1, the app's sanitiser |
| DB8 | A brief grants nothing. An answer to it is a Decision under E8 to E13, to the asker, never a Mandate. "What approval authorizes" is the asker's commitment, shown to the principal and recorded with the brief; the hub does not enforce it. | B8, O4 |
| DB9 | Restating a brief makes the next version and a new ask message: an answer given for the earlier version is refused as `changed` (E12), and a Decision already given no longer answers the new version (E11). | F2 |
| DB10 | Lint is one function. The CLI's `lint`, the agent route and the dry run call the same `lintBrief`, so an agent sees exactly what the hub will refuse. Warnings never refuse. | |

### Notifications: a nudge, not a Delivery

Added 2026-10-02 by [ADR-0008](adr/0008-patterns-borrowed-from-signal.md), with the product lane's constraints (an internal decision record, §12, binding). A web push to the principal's devices is not part of the Escalation model above: E2 and E3 stay deferred, E4 stays the scorer's check, and nothing here satisfies any of them.

| Term | Means | Is not |
|---|---|---|
| Notification | A content-free alert to active Endpoints: how many Asks wait, how many workers need you, or that a device was linked. | A Delivery, an Acknowledgement, a read, or proof he saw anything. |
| Push subscription | A notification channel of one Endpoint: where a push service accepts Notifications for it. | An Acknowledgement; a Delivery target that E3 or E4 counts; an Endpoint of its own. |
| Attending | The principal is using the app on some Endpoint right now: its window has focus, and it saw his input (pointer, key or touch) in the last 2 minutes. | A window that is merely visible, such as a tab left open on the office's shared desktop. |

| # | Invariant | Guards |
|---|---|---|
| N1 | A Notification carries counts only: how many Decisions wait, how many workers need you, and (AC13, the product lane's amendment 7) how many devices were linked, which rides the same counts-only Notification, and how many urgent fleet alerts he hasn't seen (the fleet's alerts in the app, 2026-10-12). It never carries a name, a worker, a question or any text; the device builds its words from the numbers. | privacy |
| N2 | A Notification is raised only when a Decision starts waiting, a worker starts needing you, a device is linked (AC13), or an urgent fleet alert comes in: a node's key may be stolen (a new source address, a second instance), a subscriber's events are lost or piling up, or a message has waited 15 minutes or more (the protocol's `urgentAlert`). A Secret request that opens counts as a Decision starting to wait (ADR-0022). Ordinary agent messages raise none. A worker's question or menu is an Ask, so it raises one Notification, as a Decision waiting, never a second as a worker; a worker raises its own only for a need that isn't an Ask. A muted Conversation's worker raises none, except for Decisions (an Ask breaks mute, as a mention does in Signal). A worker's question or menu reaches the principal as an Ask only after 10 minutes open (the manager answers most first); the manager's own and the list's Asks are immediate. | F1 |
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
| AC4 | Revoking an Endpoint ends its Sessions at once. A revoked Endpoint never becomes active again; pairing again creates a new Endpoint. (Amended by ADR-0019: every revocation is also appended, synced, to a journal beside the hub's database, and the hub applies that journal at every start, idempotently — a database restored from a Backup can't bring a revoked Endpoint back, however old the Backup.) |
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
| S1 | An Upload is allowed only when its extension and its bytes agree. An image extension (PNG, JPEG, GIF, WebP) is accepted by its bytes even when they are a different one of those types, and is refused when the bytes are not an image; images and PDF are at most 10 MB, and PDF bytes start with `%PDF-`. Text (`.md`, `.txt`, `.json`, `.csv`, `.yaml`, `.yml`, `.log`) is valid UTF-8 with no NUL byte and at most 1 MB; a text file is not judged by a binary's ASCII prefix. Executables, archives, HTML and SVG are refused. A name is the last path segment, with no leading dots and no characters outside letters, digits, `.`, `_` and `-`, at most 80 characters: a longer name loses stem and keeps its extension. The name and the size are checked before the bytes are read. |
| S2 | A Command attaches only Uploads made from its own Endpoint, within a day of upload, each once, at most six. |
| S3 | The Command names each attached image after the principal's own text, one note per image, in the form the workers already read; a Command may be only images. |

### Steering: the outbox

Added 2026-10-02 by [ADR-0008](adr/0008-patterns-borrowed-from-signal.md), modeled on Signal's send queue, with the product lane's constraints (§12, and the brief's amendment 10).

| Term | Means | Is not |
|---|---|---|
| Outbox | The Commands one Endpoint has queued and not yet seen through, kept on that device across reloads. | A record on the hub; a Delivery. |
| Request id | The identity of one Command, the same for every attempt to send it. | A session or a message id in the transcript. |
| Needs-you state seen | What the worker was waiting for when the Command was written: `none`, or the id of the question or menu it showed. | Whatever the worker shows when the Command arrives. |
| Send state | Where a Command stands: Queued, Sending, Sent (the hub typed it; for the manager with a fleet, the fleet's delivery queue has it and types it once, up to 24 hours later, and it can be cancelled while it waits), Echoed (it shows in the Conversation); or Not sent with a reason; or Uncertain (the hub stopped, or lost the worker's machine, while typing it, so it may have been typed). | A Delivery state (accepted, failed, unknown) of an Escalation. |

| # | Invariant |
|---|---|
| S4 | A Command enters the Outbox before its first attempt, with one request id for all its attempts. Commands to one worker go in the order they were queued; different workers don't wait for each other. |
| S5 | Within 24 hours of its first attempt, the hub types a request id at most once (for the manager with a fleet: hands it to the fleet's delivery queue at most once, under the request id as the delivery's id). It records the request as started before typing and as done after, durably, and keeps the record 24 hours. A repeat of a done request answers "duplicate"; a repeat of a started one that never finished (the hub stopped while typing) answers "uncertain" and is never typed again, unless the hub can ask the worker's machine (a fleet, fleet core §3.1): typed there, it answers "duplicate"; never received there, it is typed now. (Amended by ADR-0019: the hub's database has a store id, as a node's has under FL7, and a restore starts a new one. A device stamps each Command with the hub store it saw before its first attempt, and the hub answers a Command stamped with another store, whose request id it doesn't hold, as "uncertain" and never types it; no clock decides it, FL13.) |
| S6 | Every Command carries the needs-you state it saw. The hub judges it on arrival: if the worker's state differs in either direction (answered, asked again, changed, or a question or menu showing where there was none), the Command is refused as `stale` and never typed; the app says "The question changed: review before sending". With `none` and still nothing showing, it goes through, so steering a busy agent keeps working. AC7's freshness is also judged on arrival ("Not sent: verify", one tap). The check runs before the terminal adapter's own guard against typing into a menu, which stays as the last guard. |
| S7 | An Endpoint retries a Command on its own only within 2 minutes of queueing it. After that, only the principal moves it: Retry, with the same request id and only while the hub still holds its record (24 hours, S5), or Discard. An Uncertain Command is never sent again on its own. It offers Check again, the same request id once more within that window, which ends it Sent if the hub finds it typed or types it now (S5), or Not sent if the hub finds it never typed and refuses it now (a 404, a 403 step_up or a 409 other than uncertain and not_submitted, which comes after the paste), and Discard. Any other answer leaves it Uncertain. A first attempt answered not_submitted is Uncertain too, never Not sent (ADR-0008, phase C). (Amended by ADR-0019: an Update that holds writes — the drain before a stop, a probation that holds writes (RL9) — refuses a Command as `updating`, nothing run: HTTP 503 with Retry-After, which the outbox retries; a Command still held after its device's 2 minutes of retries waits for the principal's Retry.) |
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
| C1 | Every open Ask that waits for his call has a card, whatever he read or muted. It leaves the stack only by being answered, settled or expired; "later" takes it out of one run only. A decision card is never marked read. A Secret request is an Ask: its card is the insert-secret card ([ADR-0022](adr/0022-secret-requests.md)). |
| C2 | A Conversation has an update card when it isn't muted and has a message after its Read mark. Two panes with one name share one card, as they share one Read mark (O7). |
| C3 | Decisions come first: blocking, then the earliest due or default time, then the oldest. Then updates: needs you, then "says done", then the most recent. Cards that join during a run take their place among those still to come; the card on top and the ones passed don't move. |
| C4 | A muted Conversation gets no card; its unread messages are only counted, so the end of the run can say how many were skipped. An Ask from it still has its card (as in N2). Amended by ADR-0011: on the phone's decisions-only run no lane's updates are shown, so nothing is counted as skipped and the end shows no "muted, skipped". |
| C5 | An update card shows what came after the Read mark: the newest messages and the whole of it in counts. "Mark as read" moves the mark to the last message shown, never further. "Says done" is the worker's own word (its last answer led with STATUS: DONE), never a Verdict (V1). |
| C6 | Catch-up grants and starts nothing, as O8 and N5: marking read, keeping unread, later and last caught up never answer, settle or delay an Ask and start no timer. Keeping unread and later stay on the Endpoint. An answer from a card is a Decision under E8 to E11 and AC7, sent only after a 5-second window in which Undo sends nothing; offline it is refused, not queued. A card that carries a value (an insert-secret card, ADR-0022) has no such window and keeps nothing on the Endpoint: Store sends at once, after its fresh check (SR5), and the value is cleared. A reply from a card is a Command in the Outbox (S4 to S8). |
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
| Delivery | A message for one lane that runs the agent CLI. It is queued on the lane's node, typed into the lane once, when the lane can take it (never over a menu or the principal's own text), and confirmed by a Receipt. The sender names it by an id of its own, namespaced like an Operation key; the same id with the same content is the same Delivery. Its states: queued, typed, held (in the CLI's own queue), delivered, uncertain, given up. | An Escalation's Delivery (one attempt to show an Escalation on an Endpoint); a keyed `pane.send`, which types at once or refuses. |
| Sticky lane | A lane name a Delivery follows wherever its node runs it: through a restart in a new pane and a new session, and, while no window has it, on the node that last had it. The manager's, by default. | Any other lane name: that binds a Delivery to the session it had when the Delivery was queued. |
| Receipt | The lane's own conversation (the agent CLI's transcript of the session the text was typed into) showing that it took the text: a prompt that holds it, or the entry that takes it from the CLI's own queue into a turn. For a command that starts a new session, the lane's session changing to a new one after the typing. | The paste having happened, the input box emptying, or a transport "ok". |
| Lane event | A fact about a lane that the Fleet derives from its hooks, its session state and its lane watch, and publishes to every client: finished (a turn ended, with the worker's Status line), needs input (a menu waits), answered (it no longer does), stop failure (a turn ended on an error), stale (a turn passed its deadline with nothing from the lane since). Kept 7 days, and delivered to the manager in batches, as Deliveries. | A hook event (its raw input); an Escalation (the hub decides what needs the principal). |
| Status line | The first line of a lane's answer, saying where the lane stands: DONE, BLOCKED, NEEDS DECISION, or WAITING on something for a time (a lease of at most a day). It marks a turn's end, not the task's: DONE is the lane's word. | A task's status on the board; a Verdict. |
| Alert | Something for the owner to look at that changes no state: a second Instance, a node's network source changed, a clock offset, a node over its message rate, a lane name in conflict, a dead letter, a full backlog, a Delivery still waiting after 2, 15 or 60 minutes, a subscriber more than a minute behind, a lane started on a fallback engine. | An Escalation: nothing waits on his answer. |

Aggregates **Node** (its key, Instance and status: online, stale, offline or revoked), **JoinCode**, **LaneName**, **HookStream** (with what each subscriber has had delivered), **Delivery** (its state, and the session it is bound to or was typed into) and **LaneEvent** (with whether the manager has had it).

| # | Invariant |
|---|---|
| FL1 | A node is admitted only by redeeming a Join code that is unexpired (at most 10 minutes old), unused and bound to that node's name. A code admits one node, once, under its own name. |
| FL2 | Every connection proves both ends before any operation. The node signs the Fleet's fresh challenge with its key, and the Fleet signs the node's fresh challenge with the key the node pinned at its Join. A mismatch on either side ends the connection. |
| FL3 | A node has at most one live Instance. Another Instance with the same key is admitted only if the live one fails to answer a ping within 3 seconds (then the live one's connection is closed): a crashed or half-open Instance can't lock its node out. Otherwise it is refused, with one Alert per refused Instance while the live one lasts, and it tries again every 5 minutes. The same Instance reconnecting replaces its own old connection. |
| FL4 | A revoked node is cut off at once and never connects again. Its lanes are never listed and nothing is routed to it. Joining again takes a new Join code. (Amended by ADR-0019: a node's revocation is also appended to a journal beside fleet.db, applied at every start, so a Fleet database restored from a Backup can't bring a revoked node back.) |
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
| FL15 | A Delivery is stored on its node, synced to the disk, before its sender is told it is queued: from then on the sender may stop retrying. A refusal (`id_conflict`, `no_session`, `node_offline`, `lane_conflict`, …) queued nothing. The same id with the same target and text is the same Delivery; with other content it is refused. |
| FL16 | A Delivery is typed into its lane at most once, under its id as an Operation key (FL7), so a node that died while typing never types it again. The one exception: the agent CLI dropped the line on an interrupt, and the input box is clear and the session idle. Then it is typed once more, under a key of its own, and never a third time. |
| FL17 | A Delivery is delivered only on a Receipt, and each Receipt confirms one Delivery, the earliest still waiting. A Delivery typed and never seen taken by its deadline is uncertain and never typed again; one never typed by then is given up (expired). |
| FL18 | A Delivery is typed only into a lane with a live session of the agent CLI, whatever that session is doing, never over a menu or the principal's own text, and one at a time per lane, in the order queued: one typed and still waiting for its Receipt holds the next back for at most a minute. Until then it waits, and says why. |
| FL19 | A Delivery to a Sticky lane follows the name to whichever window and session hold it on the node that last had it. A Delivery to any other lane name reaches only the session it was bound to when queued, and one to a Worker ID only that pane: if another session takes the name, or the pane is gone, the Delivery is given up (gone). |
| FL20 | Each Lane event is stored in the same synced commit as the hook events it came from, published to every client, and delivered to the manager at least once, in batches; answered is published only. The manager's own lane, and the lanes its configuration ignores, raise none. |
| FL21 | A subscriber answers 2xx once it has an event, and never refuses one for a reason of its own (a downstream outage, a failed handler): one refused event holds up its whole stream. An Alert is raised when a subscriber's oldest undelivered event is a minute old. |
| FL22 | A lane is asked for its Status line at most once per turn, and only when nothing it started is still running or scheduled; the asked turn end is not a Lane event. The orchestrator is never asked. |
| FL23 | Every lane's last turn without a settled Status (DONE, BLOCKED, NEEDS DECISION) has a deadline: its WAITING lease, else a fixed time. Past it with nothing from the lane since, the lane gets one stale Lane event per turn. A Fleet restart counts as activity, so no lane is called stale for time the Fleet did not see. |
| FL24 | A lane started by Role or by engine runs exactly the engine its answer names, or nothing: never a quiet fall back to the node's own launcher. A start the resolver filled after passing over its first choice raises an Alert. |

Events (the Fleet's audit): JoinCodeIssued, NodeJoined, NodeConnected, NodeStale, NodeOffline, NodeRevoked, InstanceRefused, InstanceReplaced (a live Instance that missed the instance check), LaneRegistered, LaneConflicted, OperationRun (every side-effecting operation: which client asked, its target, its key's namespace and its outcome, never its text), HookDeadLettered, AlertRaised; DeliveryQueued, DeliveryTyped, DeliveryHeld, DeliveryDelivered, DeliveryUncertain and DeliveryGivenUp (each with the client that sent it, its target and its reason, never its text), LaneStarted, LaneStopped, KeysPressed (never the keys) and LaneEventRaised. The audit, Alerts included, is kept 90 days. Hook events themselves are not audited. They are kept until delivered, plus 24 hours. Lane events, and the states of finished Deliveries, are kept 7 days.

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

## Secrets: what agents use without seeing ([ADR-0022](adr/0022-secret-requests.md))

A value an agent's tools need, which the principal enters on an insert-secret card and agents use by Reference only. Design: [`design/secret-requests/README.md`](design/secret-requests/README.md). Code in `packages/domain/src/secrets.ts`. Two aggregates, the Secret request on the hub and the Secret on each node, and two domain services for the rules that span many aggregates. No value exists in this context: a version holds a keyed fingerprint computed outside it. Shapes of vendor tokens are data (`packages/protocol/catalog/secret-shapes.json`); no vendor name appears here.

| Term | Means | Is not |
|---|---|---|
| Secret | One Reference on one node: status (`active`, `disabled`, `revoked`), versions, Grants, Destinations, Expiry, shape id. The same Reference on two nodes is two Secrets; each node is the system of record for its own. | The value; an LLM connection's key; a replica the hub owns. |
| Value | The bytes the principal entered. Only on the Endpoint while typed, sealed in a node's vault, and in a program a Use started. | Anything this context, the hub, the fleet, an event or a log holds. |
| Reference | `secret://<scope>/<name>`, lower case: what agents and configs hold. Safe to commit and show. | A permission; a vault ref. |
| Version | One value of a Secret over time: a number, its keyed fingerprint, when and by which Command. One is current. | A copy on another node. |
| Keyed fingerprint | 12 hex characters of HMAC-SHA-256 under a key that stays on the node. | A plain hash, which a short value would not survive. |
| Workspace | A repository root the principal registered on a node, with every worktree that shares its git directory. | A folder with a matching git remote. |
| Grant | Who may resolve a Reference on a node: a subject (a lane, a workspace, or every lane on the node), the use modes, and an end (none, an instant, or the lane's end). | An agent token; a Mandate. |
| Use, use mode | One resolution for one program: `exec` (environment), `file` (a 0600 file), `helper` (a credential helper's output to the tool), `inject` (the agent CLI's sandbox puts it into requests; the command sees a placeholder). | Printing the value: no mode does. |
| Secret request | An agent's ask, as its node saw it: Reference, purpose, kind (`new`, `access`, `rotate`, `renew`), its waiters (lanes, and callers without one by workspace), a proposed Grant. One answer: Stored, Granted, Rejected; or Withdrawn, or Expired. | An Escalation; a chat message. |
| Request admission | The domain service for SR1 and SR10. | A rate limiter in an adapter. |
| Fingerprint ledger | The domain service for SC2, over every version's keyed fingerprint on the node, revoked ones included. | The vault. |

Layer, as in design §3.3: **domain** (decided in `secrets.ts`, proved by a domain test), **domain service + store** (a domain service decides, the store holds the uniqueness), **application** (a service's order or policy), **adapter** (an edge). Only the first two are proved by domain tests; the rest by application, contract and end-to-end tests.

| # | Invariant | Layer |
|---|---|---|
| SR1 | One open request per (node, Reference). A repeat from another lane joins it; the same waiter again changes nothing. A waiter is its lane, or, without a lane, its workspace (below). | domain service + store |
| SR2 | The requester's broker answers `available` when the use gate admits the caller; with a value but no Grant the request opens as `access`, a card with no field. | application |
| SR3 | A request carries a purpose (plain text, 1 to 300 characters), a valid Reference and Grant. No type has a field a value could travel in; the wire refuses a value-like key whole. | domain + adapter |
| SR4 | One answer. Withdrawn only when its last waiter withdraws, a lane or a caller without one; an earlier withdrawal takes only that waiter off. Expired 7 days after it opened. | domain |
| SR5 | Store and Grant need a user verification from the last 5 minutes. | application |
| SR6 | An answer names the version it saw; a join or a withdrawal since makes it `changed`. | domain |
| SR7 | The value is sealed on the Endpoint to each target node's pinned recipient; the hub and the fleet hold ciphertext in memory only, for one operation. | adapter |
| SR8 | Stored only when the requester's node confirmed. An `access` request is granted, never stored; any other kind is stored, never granted. A `renew` is stored only by a store that names an Expiry later than now and than the Secret's current one: the node, which holds the Expiry, refuses any other before it stores anything (`renew_expiry`), so the request stays open and nothing is kept (decided on T-80). The hub marks a renew Stored only when every confirming node, the requester's included, confirms that the renew rule held there (`renewed`), each with the Expiry later than its own time of the store and that time between five minutes before the request opened and five minutes after the hub's now (T-83; decided on T-85; every node, not only the requester's, since review 8 of PR #40 on T-94). The confirmation names the Reference it stored under, which must be the one the answer names; a `rotate` or `renew` is answered only under the request's own Reference, while a `new` one may be stored under the Reference the principal chose on the card (SR6; T-88). The answer carries every confirming node's confirmation, each node once, and each must name that Reference and lie in the same window; SecretRequestStored names exactly the nodes that confirmed (decided on T-94). | domain + application |
| SR9 | Answerable only on Morndo's web endpoint; never in a chat adapter, a pane or the manager's inbox. | adapter |
| SR10 | A lane holds at most 5 open requests and opens 20 a day; a node 20 and 100. A request holds at most 20 waiters, with or without a lane, so joins can't grow its card or move its version without end; a waiter already on it still joins, which changes nothing. | domain service + store |
| SR11 | A request grants nothing beyond the Grant stored. | domain |
| SC1 | No value in the model: no type, event or wire shape has a field one could travel in. | domain + adapter |
| SC2 | A Reference is unique on a node. A value matching a revoked version anywhere on the node, or an earlier version of the same Reference, is refused; a duplicate of another active Secret is stored with a warning that names it. | domain service + store |
| SC3 | Default deny. The use gate, in order: status active, a current version, before Expiry, a live Grant admits the caller, the Grant allows the mode. The first failure is the refusal, so a Grant past its end time admits nobody from that moment. Removing it, with GrantEnded, is the node's sweep (`endTimedGrants`, run with the expiry sweep from PR 6); until then the list can still show it. | domain |
| SC4 | A Use is recorded before the vault opens the value; refusals are recorded too. | application |
| SC5 | A value reaches a program only through the use modes; no command prints one. | application + adapter |
| SC6 | Every output path on the node passes the exact filter before it leaves. | adapter |
| SC7 | Narrowing is anyone's; widening, judged by effect, is the principal's. Disable is anyone's. | domain + application |
| SC8 | Disable and Revoke refuse new Uses at once. Revoke destroys the current value and keeps the Reference, history and Grants; Delete removes the Reference and Grants; the ledger keeps the fingerprints, and a value stored again under that Reference takes the next version, so (Reference, version) always names one value. | domain + adapter |
| SC9 | Expiry warns once at 7, 2 and 1 days, then refuses. Only a later Expiry clears the warnings, whoever sets it (below). | domain |
| SC10 | A Secret grants nothing: a Use is not a Mandate. | domain |
| SC11 | A transfer starts from a Secret that could be used now and carries only the Grants that haven't ended. The target stores it through its own ledger, naming any active Secret there with the same value, as a store does; onto a Reference it already holds, it is a Rotation there (below). | domain + adapter |

**Expiry on a Rotation or a transfer, and waiters without a lane** (design §10, SC7, SC9, SR1, SR6). A store or a transfer onto a Reference the node already holds is a Rotation there. It keeps the Secret's Grants and Destinations, and its Expiry unless it names one. It names the new value's shape, or none when the value matches no shape, which clears the old one, so nothing looks for a format the value no longer has; or it says to keep the shape there. A store always says which, so a store with no shape is refused, never taken as keep (T-83). A named Expiry replaces the old one, is recorded as ExpiryChanged with the Command, and clears the warnings only when it is later. A store or a transfer never removes an Expiry: that is `setSecretExpiry`, a widening the principal makes on purpose (SC7). Renewing an expired Secret is a Rotation that names a later Expiry, and only such a store answers a `renew` request (SR8); a node that holds no Secret under the Reference refuses a renew as `missing` instead of storing a new one (T-83). A renew of a revoked or disabled Secret is refused as `revoked` or `disabled`: renewing never revives a revoked value, and a disabled one would be reported renewed while every Use is still refused (T-85). On the hub, a waiter is its lane; a caller without a lane is identified by its workspace, and no workspace counts as one. A repeat by the same waiter changes nothing (SR1). A caller without a lane from another workspace is another waiter, with its own purpose (SR6). A withdrawal names its waiter and takes only that one off. SecretRequestJoined, SecretRequestLeft and SecretRequestWithdrawn name the waiter by its lane and workspace, so the audit tells waiters without a lane apart, the one that ended the request included.

Aggregate **Secret request**: its state, version and the requester node's confirmation. Aggregate **Secret**, one per Reference per node: its status, versions and Grants, and the gate. **Request admission** decides over a node's requests of the last day; the store holds a unique index on (node, Reference) over open requests and runs the decision and the insert in one write transaction. The **Fingerprint ledger** decides over every version on the node; the store holds unique indexes on the Reference and on (Reference, keyed fingerprint) and runs the check and the insert in one write transaction. The clock is the `now` argument.

Events: SecretRequested, SecretRequestJoined, SecretRequestLeft, SecretRequestWithdrawn, SecretRequestStored, SecretRequestGranted, SecretRequestRejected, SecretRequestExpired; SecretStored, SecretRotated, SecretTransferred, SecretDisabled, SecretEnabled, SecretRevoked, SecretDeleted, SecretExpired, ExpiryWarned, ExpiryChanged, GrantAdded, GrantRemoved, GrantEnded, DestinationsChanged, SecretUsed, UseRefused, UseEnded. Widening events carry the Command id.

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
| Merge record | The commit a task's PR merged as, in a named repo, with who recorded it and when. | A GitHub fact the board checks. |
| Live | A `morndo/morndo` merge that every enrolled, non-revoked node's last reported build contains (the merge is an ancestor of, or equal to, the build commit). | Deployed somewhere; restarted. |
| Proof brief | The assignee's word on a task in progress or in review, filed as its own action: what changed, the decisions, what was left out, the limits, its proof references, the checks it ran itself (attested), or that there is no code change. The latest one counts; one from before the task went back to doing is stale. | A Claim with Evidence (V1); a Verdict. |
| Proof reference | A whole, typed name the hub can fetch itself: `owner/repo#42@3e9d1a7` (a pull request at a commit) or `owner/repo@3e9d1a7:ci,lint` (that commit's checks). A bare sha, a bare number or an address is refused. | A URL; a lane's statement that something is green. |
| Proof state | What the hub read for one reference: green, pending, red, mismatch (the head moved on), missing (a named check did not run), unfetchable (it could not read, with the reason), or not checked (a private repository and no credential). Rows of their own, never events. | The task's status; a Verdict. |

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
| B9 | The manager moves a task to Done only with a reason that names what it checked (tests run, CI at a commit, a review). The principal may give one. The reason makes the acceptance checkable; it is still not Evidence (B8). |

| B10 | The board moves a task by itself, as actor `board`, only by D1 to D6, each naming its rule and the run it read ([ADR-0032](adr/0032-board-follows-the-fleet.md)). A status line may name its task key right after the word (`STATUS: DONE T-285`); D1 and D2 with a key move only that task, and only if it is the lane's. D1: in progress to in review when the assignee's turn ended DONE after the task's last change of state, even while its background work runs; a keyed WAITING naming a task in review or blocked takes it back into progress. D2: in progress to blocked when it ended BLOCKED or NEEDS DECISION; the reason is its status line. D3: in progress to to do when the assignee's lane is gone. D4: to do to in progress when the assignee's run is working or waiting since after the task's last change, the lane has no other task in progress, and this is its only to do task; a task in review or blocked is taken up again only by a keyed WAITING that names it (D1). D5: never to done, and never an assignment or an edit. D6: a run whose phase began before the task's last change of state (status, assignee, description; not a comment) moves nothing. |
| B11 | A task can carry merge records: the commit its PR merged as, in a repo, set by the manager, the principal, the console or the task's own lane (the board never reads GitHub). A merge in `morndo/morndo` is *live* when, for every enrolled, non-revoked node, it is an ancestor of (or equal to) the build commit that node last reported; until then the task shows "merged, not live", naming the blocking nodes. Done is refused while a `morndo/morndo` merge on the task is not live, unless the manager or the console gives the reason in `notLive`, which is recorded on the event and on the merge. The principal's own accept is never refused: it is recorded as the override "accepted by the principal". Unknown (no checkout, commit not in it, a node with no reported commit, no node at all) is not live. The manager, the principal or the console can clear a wrong record (a worker cannot); the record of the clearing stays in the history. A task holds at most 5 records. A lane's record is refused when the hub's checkout says it has no such commit; the manager's is not asked. An online node counts with the commit it reports now (none: unknown); an offline node with its last reported one. A merge in another repo changes nothing about done. The board still never moves a task to done by itself (D5), and never fetches ([ADR-0032 addendum](adr/0032-board-follows-the-fleet.md)). |
| B13 | A proof brief is the assignee's word, filed as its own action: while the task is in progress or in review, by its assignee or the board's hands, never by the board itself (D5). History is append-only and the latest counts; one from before a move from review back to doing is stale. It changes no state, so it needs no revision ([ADR-0035](adr/0035-proof-refs-on-review.md)). |
| B14 | Proof is verified by the hub or it is attested. A reference is whole (repository, number or sha); the hub fetches it itself, only from repositories its settings list, and only the two documented shapes of address, never one a lane wrote; the result is a state of its own (green, pending, red, mismatch, missing, unfetchable, not checked). What the lane ran itself is shown as its word and never counts as verified. A ci reference hangs off a pull request of the same brief or a merge record of the task. |
| B15 | A reference that is not green does not move the task: it stays where it is and the card says why. No rule of the board's moves a task because of a proof state; D1 to D4 are unchanged, and the board's own move to review is made with or without a brief. Results are rows, so a re-check never changes the task's revision. |
| B16 | A move to Done is gated on the proof, in a mode `off`, `warn` or `on`: with `on`, a Done is refused as `proof_not_green` unless every reference is green (or the brief says there is no code change); the manager's override reason or the principal's click is recorded in the Done event with what the board saw (`proofSeen`). `warn` accepts and records. A reference that was not checked is not verified, so it is held like any that is not green. None of this is a Mandate, a Decision, Evidence in the sense of V1, or a Verdict (B8). |

The console (`morndo …` on the control plane) is an Actor too: it acts for the principal there, as `memory approve` does. `morndo lanes start --task T-12` assigns T-12 to the new lane as the console.

Events: TaskFiled, TaskMoved, TaskAssigned, TaskEdited, TaskCommented, TaskBriefed, TaskMerged (the record), BoardChanged (the audit row; for a brief it keeps the kind of change, never its words).

## Runs: what each lane is doing now ([ADR-0032](adr/0032-board-follows-the-fleet.md))

What the fleet saw a lane do, as one value per lane: the facts the board follows. Code in `packages/domain/src/run.ts`, computed by the fleet (`apps/fleet/src/application/runs.ts`).

| Term | Means | Is not |
|---|---|---|
| Run | One lane's current activity: its phase, what it waits on, until when, and what told the fleet. | A task; a turn. |
| Phase | working, waiting, needs you, ended, gone, or unknown. | A board status. |
| Wait | What a waiting run waits on: its own background tasks, a scheduled wake-up, a Morndo job of its lane, or nothing that will wake it (declared). | A reason to stop watching. |
| Deadline | When a wait should have shown a sign of life; past it with nothing since, the run is overdue. | A timeout that ends anything. |
| Source | `hook` (the agent CLI's hook fields), `session` (the node's session state), `job`, or `status` (the turn-end status line). | Evidence. |

| # | Invariant |
|---|---|
| R1 | A Run's phase comes only from what the fleet observed: hooks, the node's session state, jobs, and the lane registry. Nothing written to the board sets it. Of a lane's own words, only its turn-end status line counts. |
| R2 | A turn end that leaves background work running or a wake-up scheduled is never `ended`. The Run waits on its own work until a later turn starts, or a later turn end reports nothing pending. |
| R3 | Every wait has a deadline: its WAITING `for`, else the lane watch's waiting lease; a wake-up whose schedule can be read, its next fire time plus 5 minutes. Past it with no activity since, the Run is overdue. |
| R4 | A WAITING turn end with nothing pending and no job of that lane (queued, starting or running, by its lane or its notice) is a declared wait, shown as having no waker. |
| R5 | A lane whose window is gone while its node is online is gone. While its node is not online, its Run is unknown, never working. |
| R6 | A Run carries no command line and no prompt: a background task as its type and a description of at most 80 characters through the shared redactor, a wake-up as its fire time and whether it recurs. |
| R7 | Precedence, first match wins: gone, unknown, needs you, working, job, background, wake-up, declared, ended. |
| R8 | Every Run names its source and the time its phase began. |
| W1 | A Claude Code Stop whose status line is WAITING, with no background task, no wake-up and no job of that lane on its node (queued, starting or running, by its lane or its notice), is asked once to give its wait a waker: a scheduled wake-up, a `morndo job start --notify lane:<lane>`, or a settled status. Never the orchestrator, never after a Stop-hook continuation. |

## Usage: how much of each account is spent ([ADR-0016](adr/0016-home-usage-across-accounts.md))

A read model, like Observation: what each connected account has used of its rate-limit windows, as the agent CLI's own status line reports it from inside each session. Code in `packages/domain/src/usage.ts`.

| Term | Means | Is not |
|---|---|---|
| Account | A subscription the lanes run on, by the name the principal gives it. | A device, an Endpoint, a lane. |
| Window | One rate limit of an account: the 5-hour, the weekly, a gateway's spend limit, or a window the account names itself (its label, the percentage used, and when it resets). | A quota the hub measures. |
| Report | One status line's JSON from one session, under an agent token, named for an account. | A claim about work. |

| # | Invariant |
|---|---|
| U1 | A Report is taken only under an agent token (B1), for the account the call names (none: the default account), with the lane the token acts as. Nothing in a conversation's text is a Report. |
| U2 | Per account, the newest Report sets the windows. A window a Report lacks is kept until its reset time has passed, then dropped (the CLI drops it then too). A Report older than the account's last never moves the windows, though its session is noted. A Report may name its own windows (`limits`) instead of the 5-hour and the weekly; an empty list does not. A bad named row is dropped and does not reject the Report, and an on-demand line is cut to its limit. A Report that doesn't leaves those named windows as they were until each reset passes, and then the 5-hour and weekly rows show again. A named window that names no reset is kept for a day after the Report that set it, then dropped. On-demand state goes when those named windows do. The notice counts a named card's spend meter as well as its named windows. |
| U3 | A session counts as reporting for 10 minutes after its last Report; the account keeps each session's last context used. |
| U4 | Usage grants and decides nothing (as O4): no Mandate, Decision, Verdict or engine choice follows from it. The engines' availability stays the engine layer's (ADR-0013). |
| U5 | An account's profile (email, organization, plan) comes only from the pool's usage file the hub reads (`MORNDO_POOL_USAGE`), never from a Report; it goes only to the principal's session (the feed and GET /api/usage), never in the agent door's reply. A missing part is not shown. |

## Pool: which account runs the next turn ([ADR-0029](adr/0029-account-pool.md))

Which member account a session's next turn runs on, and the rules around it. Code in `packages/domain/src/pool.ts`.

**Ubiquitous language**

| Term | Means | Is not |
|---|---|---|
| Pool | The subscription Connections of one runtime that lanes on this node share, with their settings. One per runtime. | A Chain; a Priority. |
| Member | A Connection in the pool, with `keep`, `expires` and `onlyFor`. | A sign-in token. |
| Identity | Who a member is signed in to, as a digest of the vendor's account id. Members with one identity are one **seat**. | The member's name; an email. |
| Reading | One look at a member: signed in or not, identity, plan (paid or not), windows, whether the vendor allows ordinary use, reset credits, and when it was read. | A Usage Report (that belongs to the read model). |
| Short / long window | The member's shortest and longest window: today the 5-hour and the weekly one. A plan with one window has only a long one. | A quota the pool measures. |
| Switch point | Headroom at or below which a member is **low**: short 3 %, long 1 %. | A pick margin. |
| Pick margin | Headroom a member needs to take a new session ahead of others: short 10 %, long 3 %. | A switch point. |
| Mark | "Out until T", from a usage-limit failure, for the member or for one model on it. | A provider mark in the engine layer. |
| Seat state | Logged out, retired, out, low or ok, checked in that order. | Availability (the engine layer's). |
| Urgency | Long-window headroom divided by the hours until that window resets or the member expires, whichever comes first: the quota that expires first, per hour. | A score of the work. |
| Session | A runtime conversation that turns resume (for Codex, the thread id). | A lane. |
| Placement | The member a session runs on, pinned or not. | A claim. |
| Claim | The one holder (node, pid, start ticks, boot id, lane) allowed to run a turn on a session now, on a given member. | A Connections Lease (which gates the run on that member). |
| Move | A session's placement changing member: between turns, or as the same turn's continuation after a usage limit. Rotate mode only, or the principal's `pool move`. | An engine switch (which starts a new session on another provider). |
| Mode | `pinned` (no automatic choice of account) or `rotate`. | A routing mode. |
| Move by | `resume` (the same session continues on the new member) or `handoff` (a new session with a handoff brief, used when resuming across accounts fails). | |
| Reset credit | A credit the vendor lets an account spend to reset its windows. | Spend; a credit balance. |
| Reset advice | The pool's note that spending a reset credit now would pay off, naming the member and the reason. | A spend. |

**Invariants**

| # | Invariant |
|---|---|
| PL1 | A member is a subscription Connection in Morndo's custody, of the pool's runtime, with a sign-in home of its own (`configDir`). A key, or a subscription without a `configDir`, is never a member, so no pool turn runs in the default home. A member is in one pool only. Removing a member ends its placements. |
| PL2 | Members with one identity are one seat. They share the freshest reading and every mark. The first member by name that can run (not retired, not past its end) takes sessions, a move never goes between them, and their claims count together. |
| PL3 | A member's state is checked in this order: logged out (its last reading says so); retired (by hand, on a plan that isn't paid, or past `expires`); out (a live mark); low (a window at or below its switch point); ok. A window whose reset has passed counts as full. |
| PL4 | Rotate placement. Candidates are ok seats that `onlyFor` admits; a member with `onlyFor` serves only those directories, and comes first for them. At night, a `keep` member is a candidate only with at least the night reserve left in its long window. Candidates that clear both pick margins go first. Then the least `(active + 1) / urgency`, then the earlier long reset or expiry, the earlier short reset, fewer active sessions, and the name. With `order: soonest-reset` (claude-pool's), the earlier long reset or expiry comes before the load. With no candidate the answer is "no seat", with the least bad member and when the first seat comes back. |
| PL5 | Urgency is `max(longLeft, 0.5) / max(hours to the earlier of the long reset and expires, 1)`. An unknown long window counts as 100 % left over 168 hours. |
| PL6 | A placed session stays on its member while that seat is ok. In rotate mode, an unpinned session whose seat is not ok moves at its next turn, never to its own identity. A pinned session, and every session in pinned mode, never moves: its turn is refused with the member's state and when the member comes back. Only the principal's `pool move` moves it. |
| PL7 | A session has at most one live claim. A claim held by a live holder refuses a second one and names the holder. A dead holder's claim is dropped (ClaimLost). A claim made before the session is known binds to it once the runtime names it. |
| PL8 | A usage-limit failure marks the member until the reset the failure or the next reading names, else for 60 minutes, and never more than 168 hours. When the limit names one model, only that model is marked on the member. In rotate mode the same turn then continues once on each other free seat. With none left, the turn fails as a usage limit and says when the first seat comes back. |
| PL9 | A mark ends when its time passes, or when a reading taken after it says ordinary use is allowed. Percentages and reset times alone never end it. A reading under another identity drops the member's marks and starts it fresh. |
| PL10 | The pool never spends a reset credit. It advises one in two cases. First: every seat is out or low, at least one session waits, the first seat comes back four hours or more from now, and a blocked member holds a credit; it names the member whose long window resets last. Second: a credit lapses within 72 hours. Spending is the principal's command, recorded with who gave it. |
| PL11 | The mode is pinned until the principal turns rotate on, naming who decided. Anyone may turn it back to pinned. |
| PL12 | The pool decides only placements and claims. It reads no credential and stores no email (CN1, CN5); identities are digests. The Usage read model still gets each member's windows through the agents' door and still decides nothing, so U4 stands. Engine chains and availability stay the engine layer's. |
| PL13 | At most `turnsPerMember` live claims per seat, by default 1: one serialized stream per sign-in. A usage read of a member takes that member's turn slot, or is skipped. Raising the limit is the principal's call. |
| PL14 | `moveBy` stays `resume` until a move's resume fails because the conversation can't be read under the new account. The pool then sets `handoff` itself and says so (MoveByChanged). Only the principal sets it back. |

**Events:** MemberAdded, MemberRemoved, MemberSettingsChanged, MemberRetired, MemberActivated, MemberMarkedOut, MarkCleared, SessionPlaced, SessionMoved, ClaimGranted, ClaimReleased, ClaimLost, TurnRefused, ModeChanged, SettingsChanged, MoveByChanged, ResetAdvised, ResetSpent.

Aggregate **Pool**, one per runtime. The clock is the `now` argument; whether a holder is alive is a function argument.

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

## Transcription: voice and audio files become text ([ADR-0021](adr/0021-optional-transcription-plugin.md))

One attempt to turn one Recording into Text, on the hub's own machine, through a Transcriber plugin the default install does not include. Code in `packages/domain/src/transcription.ts`; the queue decision it shares with Jobs is in `packages/domain/src/queue.ts`. The domain decides the states, the caps and the queue. It reads no audio, starts no engine and keeps no clock.

The wire is `packages/protocol/src/transcription.ts`: plugin protocol 1 and the HTTP bodies. `probe --json` and `run --json` are each one JSON document. A wrong protocol, a document that does not fit, or JSON that does not parse is `bad_output`. `POST /api/transcriptions` names the attempt, the Recording and the language choice. The view and the cancel body carry no filesystem path. The transcription field of `/api/me` is `false`, or the engine, model, languages and `maxSeconds` the probe reported. A fixture plugin and the contract suite against an in-memory Transcriber live under `packages/protocol/test/` until the hub speaks the port.

| Term | Means | Is not |
|---|---|---|
| Recording | An audio file the principal uploaded or recorded (an audio Upload), or an audio Attachment an agent sent. Known by its upload id or its hub file id. | A Transcript (Observation's word for a session log). |
| Transcription | One attempt on one Recording, with a state, a queue position and reason, an outcome, and when done its Text. | A Job: no command line, no lane (TX1). |
| Text | What the engine heard: the language, the segments, the joined words, the engine and model that produced them, and whether the principal edited them. | A Command, until the principal sends it. |
| Language choice | `auto`, or a language code the engine lists. | A translation target. |
| Capability | Whether a ready Transcriber is there now. Not a setting: it follows the probe. | A licence or a subscription. |

| # | Invariant |
|---|---|
| TX1 | A Transcription runs on the hub's machine, from a file already there. No adapter in this design sends audio or text off that machine. |
| TX2 | One endpoint has at most one Transcription in flight per Recording and Language. A repeat from that endpoint returns it. Another endpoint's ask for the same clip is its own attempt. |
| TX3 | A Transcription becomes terminal once (`done`, `failed`, `timed_out`, `cancelled`, `lost`). It is never re-run on its own. The principal may ask again, which makes a new Transcription. |
| TX4 | A Transcription whose run is gone with no recorded end (a hub restart) becomes `lost`. The row stays. |
| TX5 | At most `limit` Transcriptions run at once (default 1). Others wait in the order accepted, each with a visible position. The guard delays a start and never stops a run (as J5). |
| TX6 | A Recording is at most 10 MiB and at most `maxSeconds` long (default 600). A longer one is `failed: too_long` before decoding the whole file where the engine can tell. Text is at most 64 KiB. |
| TX7 | Text never replaces its Recording. An edit keeps the engine's text and marks the result `edited`. |
| TX8 | Text grants nothing. It becomes part of a Command only when the principal sends it (AC7). Text from an agent's Recording is that agent's content and is never offered as the principal's Command. |
| TX9 | With no Capability, nothing in this context runs or is offered. Audio Uploads are refused as on `main`, and the microphone stays blocked. |

A waiting Transcription carries a position and a reason, the queue's own words as for Jobs (`class`, `load`, `memory`, `guard_unknown`). `failed` names a problem: `unreadable`, `too_long`, `not_ready`, `bad_output` or `engine`. The events are `TranscriptionRequested`, `TranscriptionStarted`, `TranscriptionEnded` (the only one that carries Text, and it is never logged), `TextEdited` and `CapabilityChanged`; none carries audio. An audio file is known by its own bytes as an image is: `sniffAudio` names the container (`OggS`; the EBML magic; `ftyp` at offset 4 with a major brand a recorder writes — `M4A `, which a Safari `.m4a` has, or the iso and mp4 brands; an image brand or any other is refused, and a movie file passes the gate for the engine to read its audio track; `ID3` or an MPEG frame sync; `RIFF`…`WAVE`). An audio Upload is on Steering's list only while the Capability is there (S1).

## Releases: one Version for the whole product ([ADR-0019](adr/0019-releases-and-updates.md))

Added 2026-10-11 by [ADR-0019](adr/0019-releases-and-updates.md); design in [`design/updates/README.md`](design/updates/README.md); code in `packages/domain/src/releases.ts` (wire schemas in `packages/protocol/src/releases.ts`). One Version for the whole product, published once as a Release, offered on a Channel through a signed ChannelFeed, applied to one Installation at a safe point, rolled back when a health check fails. The updater is a separate program (`apps/updater`), never a child of what it stops. The domain decides: it verifies no signature (the Verifier port reports the fact), stops no service, opens no store, reads no clock — every function takes `now`.

| Term | Means | Is not |
|---|---|---|
| Version | One SemVer 2.0.0 for the whole product: hub, fleet, node agent, web app, CLI together. | A per-service version, a git tag, a container image. |
| Release | One Version published once: a Manifest, one artifact per platform, on the release host. Immutable once published. | A rolling channel, a nightly. |
| Channel | `stable` (a Release is 7 days on `latest` before `stable` takes it; the owner's default, Q2) or `latest`. | A branch; a vendor's "latest release" pointer. |
| Key set | The trusted root, release and feed keys, named by fingerprint, with an expiry; it walks forward one version at a time, a rotation signed by both sides' roots. | TLS, a CA, a login. |
| ChannelFeed | The signed document listing a Channel's Releases and withdrawals, numbered, expiring in 14 days. | The release host's own "latest" link, which is unsigned and unnumbered. |
| Installation | One machine's record: current, previous, staged, the bad Versions, the trusted Key set, the highest Feed number seen. | The install directory, a configuration file. |
| Update | One attempt to move an Installation from one Version to another: state machine (§4.4), step record, Backups, Migration plan. | The updater program; a package transaction. |
| Backup | A database copied before a migration, integrity-checked, at the schema it was at. | A snapshot the updater never verified. |
| Safe point | No service on the machine reports work in flight; an automatic update of a hub machine also waits until no one is attending, and for its window. | An idle CPU, a quiet hour. |
| Probation | From the new Version's start until the Update commits: health judged against the baseline, 60 seconds up without a restart, writes a rollback would lose held. | A canary fleet, a soak across days. |
| Rollout | The fleet's order for one Version: the control plane commits, a soak passes, then nodes apply, each after its own drawn jitter. | A wave of reboots, a coordinated deploy. |
| Hold | From the drain until commit or abandon, while a rollback would restore a database: every write but a revocation is refused `updating`. A hold older than 10 minutes is ignored, with an Alert. | A lock the services fight over; a maintenance mode flag. |

Aggregates **Installation**, **Update** (with its step record, Backups and Migration plan), **Rollout**.

| # | Invariant |
|---|---|
| RL1 | Verified before unpacked: an Artifact reaches the install only after the whole chain passes, in order — feed signature, namespace, channel, freshness, number; manifest digest and signature; artifact size and digest; the signed file list, nothing extra. A missing check is a failed check; no flag skips one, and every install goes through a ChannelFeed entry, `--to` included. |
| RL2 | Never a downgrade unless asked: the automatic path installs only above every committed Version; a lower one only named by the principal (`--allow-downgrade`, `--rollback`); a withdrawn Release is never offered. |
| RL3 | Trust moves forward loudly: the Key set walks one version at a time, each signed by a root of the set before it, a rotation by the new root too; a Feed's number never goes back; an expired Feed or Key set is refused, never applied. |
| RL4 | One Update at a time, each step recorded before it runs: nothing acts without the apply lock; a mutating step's mark is written and synced before the step may touch anything, and only in order. |
| RL5 | No swap without a checked Backup: every database the plan migrates has one, taken, integrity-checked, at the schema it was at — before anything moves. |
| RL6 | Only at a safe point: work in flight is never skipped, not even by `--now`; `--now` lifts only the attending and window waits. |
| RL7 | A failed health check rolls back automatically: what passed before must pass after, within the deadline; a service that doesn't answer fails; probation is 60 seconds up without a restart; the target is marked bad on this machine and not tried again automatically. |
| RL8 | No Version runs on a database it can't read: a rollback below a raised floor restores that database's Backup, and is refused if the Backup is gone. |
| RL9 | Probation holds what a restore would lose: from start until commit, when a rollback would restore a database, every write but a revocation is refused `updating` (nothing ran); a hold older than ten minutes is ignored. |
| RL10 | A restore never undoes what is done: the hub's store id and the other-store answer (S5); every revocation journaled beside its database and applied at every start (AC4, FL4). No clock decides it (FL13). |
| RL11 | Skew stays inside the window: a node never applies above its control plane; the control plane defers a Release that drops a protocol a joined, non-revoked node still speaks, and names the nodes. |
| RL12 | A halted rollout stays halted: one machine's rollback halts the Version for every other machine; only the principal's word resumes it; a newer Release supersedes it as a Version of its own. |
| RL13 | Morndo updates only itself, and grants nothing: only its own services are stopped; the node agent is never stopped while the tmux server sits inside its unit; no key file is touched; no Mandate, Decision, Acknowledgement or Verdict follows. |
| RL14 | The principal's switches win: `MORNDO_DISABLE_UPDATES` blocks every path, `morndo update` included; a pin holds; `auto off` stops the background path only; an install the updater didn't make is never changed by it. |

Events (design §4.5): UpdateChecked, UpdateAvailable, UpdateSkipped, UpdateStaged, VerificationFailed, FeedRollbackRefused, FeedStale, KeySetRotated, KeysExpired, DowngradeRefused, UpdateDeferred, ServicesStopped, BackupTaken, BackupFailed, VersionSwapped, ServicesStarted, HealthPassed, HealthFailed, UpdateCommitted, RollbackStarted, BackupRestored, RolledBack, RollbackFailed, RolloutHalted, RolloutResumed, SkewBlocked.

Ports the domain owns (adapters arrive with `apps/updater`, PR 4): **Verifier** (reports the fact "these bytes verify under this key, under that namespace"), **UpdateStore** (the Installation and the step record, one transaction per step; the apply lock), **RoleProbe** (safe point and health), **Installer**, **AlertSink**. Recovery runs from `good`, the last committed Version; a record this Version doesn't know acts on nothing and raises a critical Alert.

Relations: Releases stands beside the Fleet (see the context map). The `updating` refusal and the hub's store id are Steering's (S5, S7); the revocation journal is Access's and the Fleet's (AC4, FL4). Releases decides when they apply; those contexts enforce them.

## Knowledge: what the orchestrator reads to plan work ([ADR-0026](adr/0026-capability-knowledge.md))

Loop patterns and the recurring-job procedure, shipped as Agent Skills under `knowledge/skills/`, and the SOPs a user writes with them. The SOP check is pure, in `packages/domain/src/knowledge.ts`: the caller passes the installed skills, the notes and their re-check dates, the engine layer's roles, today's date and a time-zone test, and, when the user gives them, the ids in their preferences file and the dates of their model snapshots. Design: [`docs/design/capability-knowledge/README.md`](design/capability-knowledge/README.md).

| Term | Means | Is not |
|---|---|---|
| Pattern | A named agent loop shipped as a skill (`loop-one-shot`, `loop-review-fix`, ...): when to use it, when not, its failure modes and the guards that catch them. | An SOP; a rule the check enforces. |
| SOP | A recurring job as data: a trigger, steps, gates, done checks, stop rules, a budget, a report and metrics. | A brief; a Job (one run of one command). |
| Template | An SOP marked `kind: template`, shared as a starting point. It may keep blanks in angle brackets. | Something that runs. |
| Instance | An SOP a user runs: `kind: instance`, the default. No blank left, a POSIX cron line, a known time zone. | A Job. |
| Step | One stage of an SOP: a Role and a model class (an engine step) or a deterministic tool; its output, its Check and its Effect. | A lane; a model. |
| Effect | What a step does to the world: `local`, `outward` (leaves the user's machines) or `irreversible`. Declared on every step. | A guess from the step's name. |
| Gate | A point before an outward or irreversible step that waits for the principal's Decision. Silence never approves. | A review by another model. |
| Stop rule | A condition and what then happens: no input, the budget spent, a loop past its rounds. | A timeout alone. |
| Budget amount | A number with a currency, such as `5 USD`, or 0: nothing may be spent. | Unlimited. |
| Model class | `flagship`, `everyday` or `fast`, as auto routing takes it from the vendor's words. | A model id. |
| Family rule | `any`, or `other-than` earlier engine steps: a judge from another family than the worker. | The other-provider rule of Engines, though it serves the same end. |
| Citation | Why a step runs as it does: a skill, `notes/<id>`, `pref:<id>`, `models.dev@<date>`, or `no evidence: default`. A preference or snapshot resolves against the user's file or cache when the check is given them (a snapshot only if it reads and was fetched on that date; one left out is refused with the reason); without them only its form is checked, and the check warns. | A pasted quote. |
| Note | A short file in a skill's references: per source a link, the date read, its basis and a sentence in our words, and a re-check date. | A quote store; a ranking. |
| Preference | A user's stated view, with its holder, date and words, kept in the user's own file under an id no other entry of the file uses. | A fact. |
| Model snapshot | A dated, trimmed copy of models.dev's model list in the user's cache: provider, model, context, output limit, prices per million tokens, release date, with its source and licence. Stale after 30 days, and an anomaly when dated after today: both shown with a warning, never a failure, and a snapshot dated after today is never fresh. | A vendor's own page; a value the gate enforces (K13). |
| Scorecard cell | What auto routing records of this user's own runs, per engine, role group and model class (ADR-0020). A step's role group and class select the cells shown beside it. | A ranking made by Knowledge (K9). |

| # | Invariant |
|---|---|
| K4 | A Preference is shown as its holder's, with its date, never as a fact. |
| K6 | A Note or skill past its re-check date is stale: shown and cited as stale, warned about, never dropped, never a failure. |
| K9 | Knowledge grants nothing. It never admits, excludes, fences or ranks a candidate engine; a step's class and family rule are advisory, and the Role's chain decides what runs. |
| K10 | Every step declares its Effect and has an output and a Check. An outward or irreversible step comes after a Gate whose silence never approves. Every loop and every change loop has a round limit, the SOP at least one Stop rule, and spending past its Budget stops or asks. Every engine step cites why. |
| K11 | An SOP's report names where it goes and holds the Citations its steps used. |
| K12 | Shipped knowledge holds no per-user data: no Preferences, no Instances. |
| K13 | No code that grants, fences or prices a lease reads the model snapshot; the catalog stays the one source of what the gate enforces. |
| K14 | An SOP names a Role and a Model class, never a model id. To run a given engine, the user puts it in the Role's chain. |
| K15 | Lineup, context, output limit and price come from the model snapshot with its fetch date, not from hand-written notes. |

Rules the check refuses by, each naming its step: `effect-declared`, `gate-before-outward`, `silence-never-approves`, `gate-shape`, `round-limit`, `stop-required`, `budget-stop`, `engine-why`, `why-resolves`, `preference-in-template`, `step-check`, `no-model-id`, `model-class`, `role-known`, `step-kind`, `pattern-known`, `trigger`, `blanks-filled`, `done-required`, `report-citations`, `metrics-required`, `shape`. It warns on `stale-citation`, on `outward-sounding` (a local step whose name or tool sounds outward) and on `unchecked-citation` (a preference or snapshot it could only check for form).

## Memory: what the lanes learned ([ADR-0031](adr/0031-memory.md))

What lanes, the manager and the principal learned about a scope, kept as Notes in one place and handed to every lane as Agent Skills, whatever engine runs it. A lane writes on purpose through the agents' door (`morndo-memory`); the principal approves what may act like an instruction; every node writes the same skill files. Pure functions: the clock and the ids arrive from the caller, and no file, database or network is read. Code in `packages/domain/src/memory.ts`. Design: [`docs/design/memory/README.md`](design/memory/README.md).

| Term | Means | Is not |
|---|---|---|
| Note | What was learned about one scope: an id (`N-12`), a kind, a title, a summary, a body, a tier, its provenance, and its validity (written, last confirmed, re-check date, approved, invalidated, superseded). | A Mandate, a Decision, Evidence or a Verdict (M1); Knowledge's Note, a source note in a shipped skill. |
| Fact | A Note that states one short thing about its scope ("deploys go through make release"). A lane gets a scope's facts in one Index. | A Claim about a revision; a rule the hub enforces. |
| Procedure | A Note that is a runbook: steps a lane follows. It reaches a lane as a Skill file of its own, and only once approved. | An SOP (Knowledge): it has no trigger, gates or budget. |
| Scope | What a Note is about: `repo:<name>` (a repository, by the folder name of its main checkout, which its worktrees share), `project:<name>`, `user` or `org`. | A lane, a node, an engine. |
| Provenance | Who wrote the Note (`lane:<name>`, `manager:<name>`, `principal:console` or `principal:endpoint`, `import:<label>`), on which node, from what work (a task, a report, a PR), and whether it came from untrusted content. Taken from the token and the lane the call names, never from the body. | A name found in the Note's text. |
| Tier | How far a Note is trusted, set by where it came from: 1 the principal wrote or approved it, 2 confirmed by evidence its author did not produce, 3 an agent's (a lane's, the manager's, or imported from an agent's own notes), 4 derived from untrusted content. | A score; a ranking by use. |
| Successor | The Note that replaces another, of the same kind and scope; the old one is invalidated in its favour. It is judged afresh: an approval does not carry over. | An edit. |
| Approval | The principal's decision that a Note may reach the lanes. It makes the Note tier 1. Slice 1 takes it at the control plane's console. | An agent's or the manager's word; a confirmation by evidence. |
| Skill file | One `SKILL.md` the hub renders, a scope's facts or one approved Procedure, named `morndo-mem-…` under the Agent Skills specification. Every node writes the same files into its engines' skill folders. | A skill Knowledge ships; a file a lane edits. |
| Index | The facts of one scope in its Skill file: most trusted first, then the most recently confirmed, up to a size limit. The facts that don't fit are counted, and a search finds them. | The whole memory. |

| # | Invariant |
|---|---|
| M1 | Memory grants nothing: a Note is never a Mandate, a Decision, Evidence or a Verdict. |
| M2 | A Note is never edited or deleted, only superseded or invalidated. |
| M3 | No Note without provenance. |
| M4 | A Procedure reaches a lane only once the principal approved it. |
| M5 | A Note's trust tier is set by where it came from and never rises on its own: an agent's Note rises only with evidence it did not produce, and a Note marked untrusted (it came from outside content: a mail, a web page, a comment) rises only by the principal's approval. |
| M6 | The index a lane receives has a size limit. |
| M7 | A Note past its re-check date is shown as stale, never silently dropped. |
| M8 | Approval is the principal's: an Endpoint under step-up, or the console with a one-time code that only an Endpoint under step-up can mint (single use, bound to one Note, short-lived). |

Events: NoteProposed, NoteApproved, NoteConfirmed, NoteSuperseded, NoteInvalidated (Memory's own record, `note_events`).

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
| H3 | A lane waits for him while an open Ask of its own waits (since the oldest; a Secret request it waits on included, ADR-0022), while its last report says STATUS: NEEDS DECISION and he hasn't written to it since (since that report), or while a prompt shows on its screen; otherwise it works while its screen moves; otherwise its last answer's own STATUS word says finished or blocked, else idle. |
| H4 | A digest shows when he comes back (the app starts, or shows again after a minute hidden) only if his last activity on this Endpoint and on every other one is older than his setting: 2, 4 (the default) or 8 hours, only after a night (4 am on the device's clock in between, and at least 3 hours), or never. Nothing known: no digest. The hub keeps his last activity per Endpoint from the attending reports; it grants and starts nothing. |
| H5 | The digest has one line per unmuted lane that spoke since he left or needs him now: needs you, blocked, finished, then the rest, most recent first; the manager first. "Mark all read" moves each lane's mark to the last message the digest covered, never further; "Later" moves nothing. Decisions keep their cards; the digest only links to them. |

## Home digest: since he last looked, with proof ([ADR-0025](adr/0025-home-digest.md))

One list of everything that changed since the principal last looked, every line one click from the record that made it. A read model over the board, the forge, Escalation, jobs and the decision log, recomputed from records (DG1). Code in `packages/domain/src/digest.ts`, the claim and evidence records in `verification.ts`. Pure functions: the clock arrives as `now`, and no disk, forge or fleet is read.

| Term | Means | Is not |
|---|---|---|
| Subject | What a line is about: a task (`T-12`), a change (`owner/repo#87`, a pull request at a revision), a deploy (an environment at a revision), an ask, a decision taken for the principal, a lane, or a job. | A message. |
| Revision | The commit a claim or a check is about (a SHA), with its patch id. | A branch name. |
| Event | One fact about a subject from one record, with its record's time and the hub's sequence number: needs you, decided for you, failed or rolled back, stale or stuck, shipped, merged, opened or pushed, done. | A summary. |
| Claim | A lane's statement that an outcome holds on a revision: done, merged, shipped, fixed. Filed through the agents' door (`via` filed), read from the board (a task moved to review, `via` review), or read from a lane event (its last answer said done, `via` lane_event). Each of those is one claim row, with a sequence and a time. The row carries `revisions`: for a change, the revision the lane named, or that change's head then if it named none; for a task, each change rooted under the task then, at its head then, including a deploy linked then. A task with no change carries `round`, the sequence of that round's first claim. A board or lane-event claim is about the task (for a lane event, the task that lane has in progress, B5; none, and it is counted as unattached and shown nowhere). | Evidence (V1). |
| Evidence | The result of one check on one revision, with its producer: a CI run, test counts, a review, a live check, a screenshot, a deploy status. | Output the claimant produced about itself. |
| Producer | Who made the evidence: the hub's forge adapter (CI, deploy status), the manager, a lane, or the principal. | The lane named in the evidence's text. |
| Level | Who has checked a subject at its current revision: claimed, checked, reviewed, verified live; or failed. | A Verdict. "Verified live" says one live check passed on this revision, and its chip says what it checked. The Verdict Verified needs Evidence for every Check of a Done-means (V1); the digest shows no Verdict until Done-means exists. |
| Item | One line: a group of linked subjects (a task with its changes and deploys), its section, its level, its events since the mark, its evidence. | A stored summary. It is recomputed from records. |
| Link | A record that a change or a deploy belongs to a task: filed with a claim or evidence that names both, or on its own (`morndo-verify link`), always under a token. The hub stamps its sequence and its time together. The first link is the lowest sequence (DG5). An assignment of a lane to a task carries a sequence and a time too. A link or an assignment raises the item only when it changes the line (DG8). | A task key found in a branch name or a title. |
| Mark | The hub's sequence number up to which the principal has seen the digest, on any Endpoint, with the items seen above it. | A Read mark of a Conversation; an Acknowledgement. |

| # | Invariant |
|---|---|
| DG1 | Every item, count and level is derived from records with an Actor or a producer: board events, Escalations, claims, evidence, links, lane events, jobs, forge facts and the decision log. A worker's free text never sets a level, a section, a verb or a count of anything but claims; it shows only as a quoted claim. Task and pull-request titles are shown as names, as on the board and the forge. |
| DG2 | An item's level is the highest level whose evidence is on the subject's current revision and comes from a producer other than its claimants. A claimant's own evidence never raises it (V1). |
| DG3 | Any failing evidence on the current revision, a revert, a rollback or a reopen shows the item as failed, whatever else passed (V2). Failed lasts while its cause is current: a new revision clears failing evidence (DG4); a reverted change and a rolled-back deploy stay failed; a reopened task is failed until it is accepted as done again, then its level is recomputed. The failure stays in the trail and in DG12's count. Placement in the Failed section follows section 3.2. |
| DG4 | A new revision without the same patch id voids earlier evidence for the level. The voided evidence stays visible as voided. |
| DG5 | One item per root subject. A task groups its linked changes and their deploys. The first link is the lowest sequence; the hub stamps a link's sequence and time together. A claim's root is that first link at or below the claim's own sequence. A task the claim itself names counts as such a link. Time sets the week, not the root. The item sits in the first section, in the order of section 5, that a live condition of its own (DG6) or one of its events since the mark belongs to; its other events form its trail. A needs-you or stale event places its item only while that condition holds. |
| DG6 | Needs you and Stale or stuck are live state: an item stays while its condition holds and leaves when it clears, whatever the mark. A Needs you item leaves only by being answered, settled or expired (C1). The end of a live condition is a trail entry and raises nothing. |
| DG7 | The mark only moves forward. "Mark all seen" names the items the device covered: every line it displayed, and the items of a section folded by design (Opened or pushed), whose fold line shows their count and kinds. Items behind "N more" are not covered. A prior-seen item is covered only when both its sequence and its level match; the section is never compared. The hub marks those items seen and moves the mark to the highest sequence number below which every item is seen; it never passes an item that wasn't covered, nor the hub's newest. Kept on the hub and told to every Endpoint (O7, C7). |
| DG8 | An item is new while its sequence is above the mark and it was not seen at that sequence, or while its level differs from the level it was seen at. Its sequence is the highest among its events, evidence and claims, and among the links, assignments and change heads that changed its line when they were replayed in sequence order against the records before them. The line is its subjects with their revisions, its level, and its chips. Neither the mark nor the section enters the sequence. |
| DG9 | A rebuild of the digest from the stores gives the same items, levels and counts. Section counts are counts of items; weekly counts are counts of records. |
| DG10 | Stale and stuck are computed from records and side effects (section 6.3), never from a worker's own report. Their limits come from config. |
| DG11 | The digest grants and starts nothing (O4, B8, C6): seeing, marking, opening, and a veto are not a Mandate, a Decision, an Acknowledgement, a Verdict or a board move. A veto is a Command (AC7) that sends the manager a message naming the decision. |
| DG12 | A claim is judged at the revisions it was made at. The claim row carries them, filled in by the hub when it files the claim: a change claim's named revision, or the change's head then; for a task claim, each change rooted under the task then, at its head then, and a deploy linked then. Never a later head, never the live head. Its root is the first link at or below its own sequence. A claim is counted once per root and set of revisions, at the lowest sequence of its sources. A task with no change has one round per hand-over, stamped on the row, and that round counts once at its lowest sequence. It counts as later failed when, within 14 days, failing evidence lands on one of its revisions, a change it names is reverted, a deploy it carries is rolled back, or its task is reopened. A claim with no entries fails on failing evidence against the task itself, with no revision, inside its round, or on a reopen. A deploy's failure record fails the claims that carry that deploy, not every claim under the deploy's root task. Its level is the level of those revisions computed from records before the failure, or at the end of the 14 days. Links and claims count as claimants by sequence: at or below the claim, and later sequences whose clock falls between the claim and that moment. Assignments are read up to that moment. Only a round's evidence is limited to the round. A round is keyed by its sequence (`r`), and a claim that joins none by its own sequence (`s`), so a clock cannot collide with a round. A revision the hub could not learn stays unknown, and the claim counts as claimed. |

## Candidate: Record context (ADR-0002 after the name)

Not adopted; nothing in the trial needs it. The core would be the owner's record: an append-only log of approvals with provenance, worker claims, and checks run by someone other than the worker on a named commit. Authority, Escalation and Verification would become projections of it: status, Verdict and staleness are computed, and a new push voids older Evidence. It would replace the cross-context calls below.

## Context map

**Shared kernel** (identifiers only): PrincipalId, EndpointId, TaskRef, Revision, ActionRef. Clock and storage are ports; the domain holds no file system, terminal or chat API.

**Between contexts:**
- *Authority supplies Escalation* (customer and supplier). Escalation calls Authorize before opening an Ask; MandateGranted supersedes covered Asks (E5). Only an Answer to a policy Ask, given here with a fresh step-up, becomes a Mandate; other answers are Decisions only (K-1, product decision 2026-10-02 §12).
- *Verification publishes to Escalation*: Verdict events become Reports (E6).
- *Verification supplies Authority*: a conditional Mandate ("ship when green") references a Verdict, never a Claim.
- *Board stands beside Observation*: the board says what a lane was asked to do and where it stands; Observation says what the lane is doing on its screen. Neither decides anything for the other, and the board grants nothing (B8). A lane's "in review" is its word, as "says done" is in Catch-up (C5).
- *Fleet supplies Board with Runs* (customer and supplier, ADR-0032). The board's projector reads `GET /v1/runs` and the `run` events, and moves tasks only by B10. The fleet never reads the board, and a Run is never written by the board.
- *Jobs stand beside the board and the fleet*. A task notice is one comment and does not move the task (B3, B8, J7). The fleet stores the job's state and a redacted tail. It never stores the command (J1, FL14). The node decides when a queued job may start (J5).
- *Jobs supplies Transcription* with the queue decision. This is a shared rule (`packages/domain/src/queue.ts`), not shared rows: one class, at most its limit, FIFO with a visible position, a guard that delays a start and never stops a run (J5, TX5).
- *Transcription supplies Steering*: a done Transcription's Text can become a Command's text, and only the principal's send makes it one (AC7, TX8); an audio Upload is on Steering's list only while the Capability is there (TX9, S1).
- *Releases stands beside the Fleet* (customer and supplier, ADR-0019). It reads the control plane's Version and each node's Version and protocols through the client API, and raises its Alerts there. The Fleet carries one new typed operation, `update.apply { version }`, with a key and no command line (FL14); a node's policy may deny it. "Update now", "Roll back", a Channel change and turning automatic updates on or off from the app are principal Commands (AC7, with step-up). Releases grants nothing (RL13): no Mandate, Decision, Acknowledgement or Verdict. No other app imports the updater; the hub runs the program, as it runs the engines CLI.
- *Fleet supplies Observation and Steering* (customer and supplier). Observation reads workers, screens and transcripts through it. A Decision (E8) or a Command (S5) for the manager reaches it as a Delivery: once queued, the answer counts as given; delivered, by a Receipt, it is recorded (E13); uncertain, it is never typed again and the Ask is not opened again; given up, nothing reached the manager and the Ask opens again. A Command to another lane reaches its pane as a keyed operation (FL7). Neither is typed twice across a dropped connection. The Hook bus feeds the chat bot, a subscriber, which turns hook events into Escalations through its own adapter; Lane events reach the manager as Deliveries.
- *Engines is downstream of Connections* (customer and supplier). A connection name is the provider name the routing policy orders. Connections never reads the routing policy, and no spend figure decides anything but the lease gate (CN15).
- *Connections stands beside Usage*. Usage shows a subscription's windows. It does not grant a lease.
- *Pool → Connections* (customer/supplier): the pool reads its members and takes a Lease per turn through the existing gate (on, terms, repo, isolation).
- *Pool → Usage* (publisher): readings go out as status-line reports through the agents' door. The read model doesn't change.
- *Engine layer → Pool* (conformist at the edge): the engine layer runs its `codex` provider through the pool's wrapper. The pool never edits a chain.
- *Access supplies Secrets*: the Session and its fresh verification (SR5).
- *Secrets supplies Catch-up, Notifications and Observation with Asks*: an open Secret request has a card (C1), raises one Notification (N2), and makes its lane wait (H3).
- *The Fleet carries Secrets' typed operations*, keyed (FL7), and one node event, `secrets.requested`, routed to the hub only (SR9). No plaintext secret and no agent-CLI credential crosses the Fleet (FL14); a value sealed to one node's recipient may.
- *Secrets stands beside Connections*: they share the vault, the identity and the process adapters, not a model. An LLM key is a Connection; a value a lane's tools need is a Secret.
- *Secrets stands beside Authority*: a Use is not a Mandate (SC10).
- *Knowledge stands beside Engines*. An SOP step names a Role and a Model class; the Role's chain and auto routing decide what runs, and nothing in Knowledge ranks or excludes an engine (K9). A Gate is answered through Escalation as a Decision; a run starts as a Job.
- *Fleet supplies Memory* (customer and supplier). Lanes write through the hub's agents' door with an agent token. Memory's Skill files reach each node as one typed operation, `memory.sync`, sent in parts with a key, with no command and no path (FL14); a node's policy may deny it.
- *Memory is a customer of Authority and Escalation*: only the principal approves a Procedure or an untrusted Note (M4, M5, M8). In the app, a pending Note files an Ask on the Decisions board (id `mem-n-<k>`, at most ten at a time); the principal's answer under step-up approves or rejects it and is recorded as the Decision (E8). The approval at the control plane's console needs a one-time code minted under step-up in the app.
- *Verification supplies Memory*: only evidence the author did not produce raises a Note to tier 2 (M5, V1).
- *Memory stands beside Knowledge*: both hand agents Agent Skills and show a stale note as stale (K6, M7). They share no data: Knowledge ships what to plan with; Memory keeps what this user's lanes learned.

**Anti-corruption layers** (adapters translate; the domain never sees a vendor payload):

| Adapter | Translates |
|---|---|
| Agent CLI hooks (Claude Code) | tool call to Action, Authorize to allow or deny; notification to Ask or Alert; stop to Claim |
| Node agent over tmux and Claude Code's files (`morndo-node`) | panes, windows and the tmux server's stamp to Workers with Worker IDs; Claude Code's session files and transcripts to bytes by session id; a typed operation to tmux commands under the node's policy |
| Hook relay (`morndo-node`, `127.0.0.1:8787`) | a Claude Code HTTP hook to an event of the node's Hook stream, answered only once it is durable (a script path answers 503 when it can't be) |
| Claude Code's transcripts and session files, for deliveries (`morndo-node`) | a prompt, a queue entry or an attachment that carries a typed text to a Receipt (held, delivered, dropped, or no verdict); the session file's status to a lane's session state (busy, idle, waiting, shell); the menu on its screen to the question of a needs-input Lane event |
| Agent CLI channel (Claude Code Channels) | permission request to Ask; Decision to verdict. A transport write is never an Acknowledgement. |
| Agent CLI session list (`claude agents --json`) | "blocked, waiting for" to Ask, as a polling backstop |
| Supervisor activity ledger (firstmate) | "needs-decision" to Ask, deduped on task + key (the ledger is at-least-once); "done" to Claim |
| Push gate (no-mistakes) | gate run result to Evidence (admissible because the gate ran it, not the worker) |
| Chat bot (Telegram) | Escalation to one message with buttons; tap to Acknowledgement or Decision; the principal's own command to a Mandate |
| Manager's needs-you list (its ledger file, read-only) | open and closed items to Asks with their terms (default, recommendation, deadline, blocking) and resolution; the list decides whether an Ask is still open (E10) |
| Manager's chat protocol (`[buttons …]`, `[tap …]`) | a buttons line to an Ask's options; a Decision to the tap line the manager reads; a tap seen in its conversation to "answered elsewhere" (E8) — unless it is one the hub itself typed for an answer it holds, which is that answer arriving, recorded for the Endpoint whose request sent it, never an answer from elsewhere (a hand tap of the same option read only after the hub wrote its own: E8's known limit) |
| Agent CLI status line (its JSON, posted by the lane's status-line script to `/api/agent/usage` with an agent token) | `rate_limits.*` and `context_window.used_percentage` to a Report for the account the call names (U1); everything else in the document is dropped |
| Agents' board command (`morndo-board`, over `/api/agent/board` with an agent token) | a lane's command line to one change of one Task by one Actor (B1); the hub's refusal to one line the agent can act on |
| Agents' memory command (`morndo-memory`, over `/api/agent/memory` with an agent token) | a lane's command line to one search, one Note, or one proposal or invalidation with provenance (M3); the git repository it runs in to the default Scope; the hub's refusal to one line the agent can act on |
| Node's Memory sync (`memory.sync`, `morndo-node`) | Memory's Skill files to the engines' skill folders, each marked as Memory's; a folder of the same name without the mark is another skill's, left alone and reported. Never another skill's. The domain never sees a path |
| Node job supervisor (`morndo-node`) | a class limit and an optional load or memory reading to the domain's queue decision (J5); a process exit to one Outcome; a completion to one Notice. The domain never sees a pid, a unit name, or `/proc`. |
| Transcription plugin (protocol 1, `packages/protocol`) | `probe --json` and `run --json` to a Capability and an EngineText. A document that is not protocol 1 is `bad_output`. The domain never sees the plugin's JSON. |
| Event store | persistence and replay (the scorer reads raw trial logs through it) |
| Engine layer's CLI (engine-layer `bin/engines`) | its roles, providers and resolver output (JSON) to Roles, Engines and Availability; a save to `set` and `other-provider --effective` calls; its refusal (exit 2) to "refused" with its words; a shape it doesn't know to "unavailable", never a guess; a CLI older than engine-layer 9f3a28c (no `other-provider --effective`) to "unsupported" (R1, R2, R5) |
| SOP files and skill folders (`knowledge/`, the `sop-check` command) | an SOP's YAML to the plain data the check judges; the skills beside the recurring-job skill to the names of installed patterns; a note's front matter to its id and re-check date; the runtime's time-zone data to a yes or no. The domain never parses YAML |
| Vendor catalog (`packages/protocol/catalog/vendors.json`) | a preset's id, runtimes, terms and isolation floor to the values Connections and the routing policy take. The domain never names a vendor |
| Agent CLI sandbox credentials (Claude Code `sandbox.credentials`, `mask`) | a Grant's `inject` mode and Destinations to a `--settings` entry for the lane; a platform or version without it to "inject unavailable here", never a weaker mode chosen silently |
| Git credential helper protocol (`git credential-*` with `get`) | git's request on stdin to a Use of the Reference configured for that remote; the value to `password=` on stdout, to git only |
| Browser age encryption (`age-encryption` in the web app) | the typed bytes and a pinned recipient to a SealedValue; a recipient that differs from the pin to "stop and compare" |
| Peer credentials and the pane table (`SO_PEERCRED` or `LOCAL_PEERPID`, process ancestry, tmux `#{pane_pid}`, `git rev-parse --git-common-dir`) | a socket connection to a Caller: a lane or none, a workspace or none. The domain never sees a pid, a pane id or a path |
| Fleet hook path `/secrets/requested` | a node's request, as the node saw it, to SecretRequested at the hub |
| Token shape catalog (`packages/protocol/catalog/secret-shapes.json`) | a vendor's documented token prefix to a shape id the redactor uses. The domain never names a vendor |
