# ADR-0033: A message the principal types may be 100,000 characters, typed as one paste

- **Status:** Accepted, 2026-10-21.
- **Number:** the next after ADR-0032.
- **Builds on:** ADR-0012 (typed operations on many machines), ADR-0030 (engine lane sessions). Fleet clients §4 (the delivery queue).

## Context

1. **The app refused a long paste.** Every layer carried the same cap, `LIMITS.maxSendText` (8000 characters): the app's outbox, the hub's steering service, the fleet's delivery body, and the node agent's `pane.send` and `lane.deliver` arguments. A long brief, a log or a pasted document came back `too_long`.
2. **The cap was not the transport's.** The node agent already types text as one bracketed paste: tmux `load-buffer` from stdin, `paste-buffer -p -d`, then Enter. That has no length limit of its own, and a paste is atomic.
3. **The same constant also bounds things that must stay short:** the lane-event parts the fleet pushes to the manager, the jobs notice (`NOTICE_MAX`), a lane's first prompt (`lane.start`), and the inline text of a voice note.
4. **Agents update at different times.** A node agent that predates this change checks `pane.send` and `lane.deliver` text against 8000 and refuses more as `bad_args`.

## Decision

1. **One paste, no chunks.** A long message travels as one `pane.send` or `lane.deliver` argument and is typed as the one paste the agent already makes. Chunking would add a state in which half a message is in the input box; there is none now.
2. **A bound of its own.** `LIMITS.maxMessageText` is 100,000 characters (JavaScript string length) for text a principal types: `pane.send`, `lane.deliver`, the app's send body (which already took 100,000) and `lanes send`. `maxSendText` stays 8000 for everything in context 3.
   - 100,000 characters is about 25,000 tokens, a large share of a coding agent's context. Past it, the text is a file to upload (`LIMITS.maxFileBytes`), which the lane reads.
   - The hub drops, before it sends, the control characters the agent drops when it pastes (every C0 control but newline and tab, and DEL; `pasteText` in the steering service). What it sends is then at most three bytes a character as JSON (a control character alone is six), so 100,000 characters stay under `LIMITS.maxMessageBytes` (512 KiB). `lanes send` and other API clients send the text as given: control-heavy text there is refused `too_large` by the fleet before it is sent, as for any op, and the app words that for a text, not a file.
3. **The hub's HTTP body cap rises for the two send routes only** (`SEND_MAX_BODY`: every character escaped as `\uXXXX`, plus the other fields). Every other route keeps 64 KiB.
4. **Old agents refuse cleanly.** The agent says in its hello that it takes long messages (`caps` carries `CAP_LONG_TEXT`). The fleet sends `pane.send` or `lane.deliver` text over 8000 characters only to a live node that said so; to any other it answers `unknown_op`, executed "no", nothing sent, and the app says the agent needs updating. No new error code: an older end reads an unknown code as `internal`, executed "maybe". An older fleet refuses over 8000 itself (`bad_args`) and an older hub `too_long`; for a message over 8000 the app reads `unknown_op` and `bad_args` as "update Morndo on that machine", not as a malformed message.
5. **The receipt needs nothing new.** Claude Code 2.1.305 wraps a long paste in `<pasted_content id="…">` tags in its transcript; `promptMatches` strips them already. Observed with real Claude Code on 100,000 characters, single-line and multi-line: the transcript held the text intact.

## Consequences

- **The engine layer's input reader decodes each terminal read on its own.** A multibyte character cut at a read boundary can arrive corrupted in a long paste to an engine lane, and the lane's transcript then does not match the text, so the delivery is not marked delivered. This is outside this repository and was true above about 4 KB before this change; it is tracked with the engine layer. Text in ASCII is unaffected.
- A text with attachment notes is checked as a whole: a 100,000-character text with an image attached is `too_long` by the length of the note.

## Where things live

| Piece | Where |
|---|---|
| The bounds, `CAP_LONG_TEXT`, the op arguments | `packages/protocol/src/fleet.ts` |
| The capability gate | `apps/fleet/src/application/connections.ts` (`request`) |
| The hello's capability | `apps/node-agent/src/agent.ts` |
| The send routes' body cap, steering's bound | `apps/hub/src/adapters/http.ts`, `apps/hub/src/application/steering-service.ts` |
| The app's bound and wording | `apps/web/src/lib/outbox/state.ts`, `words.ts` |
