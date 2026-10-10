# ADR-0006: A Slack-style desktop client, for agents

- **Status:** Accepted, 2026-10-01. Decided by the owner; built by lane A.
- **Builds on:** ADR-0004 (the web endpoint) and ADR-0005 (stack).

## Context

The requirement: a desktop web app that follows Slack's layout, tuned for agents rather than a human team. The shape is familiar because many people already use Slack to talk to teammates, and the same shape should work for agents. Most messages go to the manager; other channels stay visible.

Slack's web client was measured read-only on 2026-10-01: DOM geometry and computed styles of an open tab through the Chrome DevTools Protocol, with no input and no navigation. Only content-free metrics were kept (frame 40px top bar and 70px rail; 28px sidebar rows at 15px/28px; 49px channel header; 36px avatars with a radius of about 8px; 900-weight 15px sender names; 12px grey timestamps; the three-part composer with an 8px radius).

## Decision

1. **Same structure and metrics as Slack; our own brand.**
   - Layout, sizes, spacing, type scale and interaction patterns follow the measurements.
   - Colors, logo, icons and name are Morndo's own. Morndo will be sold, and Slack's logo, brand colors and icon set are its trade dress; the familiar structure is what people recognize.
   - Text is set in Lato (OFL-1.1, via `@fontsource/lato` 5.3.0), the typeface Slack's own font is based on. Icons are Lucide (`@lucide/svelte` 1.49.0, ISC).
2. **The concepts, mapped to agents:**

   | Slack | Morndo | Why |
   |---|---|---|
   | Workspace | This machine (the "office", in the owner's words) | "a machine is an office and i deploy them there" (product lane charter). |
   | Direct message | The manager | The principal talks mainly to the manager. |
   | Channel | One worker (a tmux pane running an agent), `#<window name>` | You watch agents work the way you watch a team channel. |
   | Sidebar sections | Direct messages, Working, Idle | Sorted by what the agent is doing, not alphabetically. |
   | Unread / mention badge | New messages / needs you | A red badge means the agent waits for the principal: an open question, or a menu on its screen. |
   | Activity tab | Everything that needs you, across agents | The principal's inbox. |
   | Message | A prompt or an agent's reply; tool use collapses to one activity line | Agents are chatty with tools; humans read the answers. |
   | Huddle / canvas side panel | The worker's live screen | The raw terminal stays one click away. |
   | Typing indicator | "<agent> is working…" | From the Observation state (active / quiet). |
   | Composer | Types into that worker's input, after a fresh passkey check | See 4. |

3. **Where messages come from:** Claude Code's session registry (`~/.claude/sessions/<pid>.json`, whose `tmux` field names the pane) and its transcript files.
   - Both are internal. The docs say the transcript format "is internal to Claude Code and changes between versions" (https://code.claude.com/docs/en/sessions, 2026-10-01).
   - So they sit behind one anti-corruption adapter: read-only, tested on synthetic fixtures, and pinned to the version it was checked on (2.1.286).
   - The supported path, HTTP hooks (`MessageDisplay`, `Stop`, `Notification`; https://code.claude.com/docs/en/hooks), replaces the adapter once the owner agrees to register hooks for all sessions.
   - Authors come from the entry's origin field (human, peer session, task notification, channel), never from what the text claims. The one exception is the `Manager:` prefix the manager uses when it types into a lane, which is display only (O4).
   - The hub never stores message text.
4. **Sending (steering) starts now, with guards:**
   - A command needs a Session whose user verification is fresher than 10 minutes (AC7). Otherwise the client asks for the passkey again (Face ID or Touch ID).
   - The hub pastes the text into the pane as one tmux command list (a bracketed paste, then Enter), only if no menu is open and the input line is empty, so it never types into a half-written prompt.
   - Every send is audited with its length and a hash, never the text.
5. **Desktop first:** the Slack layout applies from 900px wide. Narrower screens keep the phone layout from increment 1.

## Consequences

- **Good:** a familiar frame for a new kind of team. The manager conversation and every agent's channel sit side by side.
- **Risk:** the transcript adapter breaks when Claude Code changes its format. Its contract tests show it, and the hooks path is the fix.
- **Risk:** typing into a pane can still race another writer (kira, a lane event) between the empty-input check and the paste. The window is milliseconds. Hooks and channels remove it later.
- **Third-party pieces, all permissive:** Lato (OFL-1.1), Lucide (ISC), marked 18.0.14 (MIT), DOMPurify 3.4.16 (MPL-2.0 or Apache-2.0). Every agent message is sanitized before rendering, because agent text is untrusted.

## Addendum (2026-10-01): conversation settings, like Slack's

The requirement: quiet labels are hidden by default. Each channel or direct message has a setting for a verbose view. Direct-message settings open from a right-click, in a modal, as Slack does.

Slack's sidebar menu and details modal were measured the same read-only way (one right-click and one click on the open channel, then Escape; nothing navigated or marked read):
- **Menu:** 300px wide, 28px items at 400 15px/28px with 24px padding, a "Notify you about…" radio group, separators with 8px around, radius 4.
- **Modal:** 580px wide and 85% of the window tall, radius 8, a 98px header with 22px title and 28px outline buttons, 36px tabs, and a #f8f8f8 body with a white card (radius 12) of fields padded 16px 20px.

Decisions:
1. **Right-click any conversation in the sidebar for Slack's menu, rebuilt for agents:**
   - Conversation details; Copy name; Star;
   - "Show in chat…" with Answers only or Everything (verbose), and More options;
   - Open the screen beside; Mute.
   - Clicking the channel name in the header opens the same details modal, as in Slack.
2. **The details modal:**
   - About: working on, state, folder, session, terminal, pane ID.
   - Settings: show mode, tool activity, mute.
3. **"Answers only" is the default:**
   - It drops leading machine markers such as `[quiet]` (a leading `[word]` or `[word detail]`, never a link or a one-letter checkbox).
   - It hides system plumbing: lane events, background-task notes and compaction.
   - "Everything" shows each message exactly as written.
4. **Settings are per conversation, per device** (browser storage), keyed by the agent's name. Moving them to the hub, so they follow the principal across devices, is a later step.

## Addendum (2026-10-01, later): the access policy is the principal's choice, and ghost text isn't a draft

The requirement: sign-in and step-up timing is longer, or chosen by the user. Asking for a passkey every 10 minutes is too often.

1. **Access policy (AC5, AC7, AC8 in `docs/domain.md`):**
   - The hub stores one policy for the principal, so no browser can relax it on its own.
   - Sign-in lasts 12 hours, 7 days (default) or 30 days. Sending asks for the passkey every 10 minutes, every hour (default), every 8 hours, or only at sign-in.
   - Loosening needs a passkey check from the last 5 minutes; tightening never does. Every change is audited as PolicyChanged.
   - Desktop: Preferences (the rail's avatar), Security tab. Phone: the Devices page. The session cookie lives as long as the longest choice; the hub enforces the real limit.
2. **Prompt suggestions are not drafts:**
   - "Manager has half-typed text in its input" was a false alarm. After a turn, Claude Code pre-fills a suggested next prompt as dim ghost text ("Prompt suggestions", `promptSuggestionEnabled`, default on; https://code.claude.com/docs/en/settings-reference, 2026-10-01). Other tools hit the same thing (github.com/umputun/agterm/issues/564).
   - The ghost text is drawn with SGR dim, `ESC[2m` (github.com/bradbrok/PinkyBot/issues/1291). The input check now reads the pane with its colors (`capture-pane -e`) and counts only text that isn't dim.
   - A real-tmux test shows both sides: dim ghost text lets a send through, and normal text blocks it.
   - Refused sends are now logged by reason, never by text.

## Addendum (2026-10-01, morning): decisions get their own panel, and buttons in the chat

The requirement: decisions have a right-hand sidebar, and the same decisions appear in the chat. They must be easier to see and to answer. The work follows the domain rules and includes a manual check.

**Where decisions come from.** These are the Escalation context's Asks (`docs/domain.md`), joined from three sources, each behind its own adapter:
1. **The manager's needs-you list:** its ledger file, read-only, `MORNDO_LEDGER`.
   - It gives the question, what happens if nobody answers (`default`), the recommendation, the deadline, whether it blocks, and the project.
   - It also says whether an item is still open. The manager is its only writer.
2. **The manager's chat protocol** (kira's MANAGER-UI.md):
   - A last line `[buttons <id>] key=Label | …` asks a decision, recommended option first. The grammar is a port of kira's `parseAnswer`, with its limits, and a contract test with kira's cases.
   - A principal message `[tap <id>] <key> (<Label>)` shows that the decision was answered on another endpoint, such as Telegram.
3. **Workers:** an open AskUserQuestion, with its options, or a menu on the screen, with the screen's last lines. These are answered on the worker's own screen. The hub never presses keys in a menu.

The list and the buttons are joined by id. The list's wording wins, and the message supplies the options and the context. While the list can't be read, the last readable wording stays, and answers wait.

**Rules** (domain, `packages/domain/src/escalation.ts`; E8 to E11 in `docs/domain.md`):
- **E8:** one Decision per ask.
- **E9:** an answer is one of the ask's own options, or words. The label comes from the ask, never from the request.
- **E10:**
  - A list item is answerable only while the list has it open.
  - An unreadable list refuses answers and changes nothing (fails closed).
  - An id not on the list yet waits out kira's 10-minute grace period, then is settled, with no Decision (K-1, product decision 2026-10-02 §12).
  - An id that is not a list id expires after 24 hours, as in kira.
- **E11:** a re-ask reopens. If the manager posts buttons again for an id, an earlier answer doesn't answer the new ask.

**Answering is a Command (AC7).**
- It needs the same passkey freshness as typing, and each request counts once.
- The hub types exactly what kira types for a tap, `[tap <id>] <key> (<Label>)`, or for words `About <id>: <text>`, into the manager's pane. It goes through the same guards (no menu open, an empty input box).
- The hub now takes the lock that kira and lane-events-push take around typing into the manager's pane (`MORNDO_PANE_LOCK`, flock(2) through flock(1), like kira). That closes the race risk listed above for the manager's pane, for decisions and plain messages alike.
- A Decision is recorded only once it was delivered:
  - its provenance (endpoint, session, time) goes into the audit;
  - for words, only their length and a hash are kept;
  - it survives a hub restart.

**What the principal sees:**
- **Right panel** (440px, Slack's right-hand panel), opened from the rail, the sidebar or the manager's header:
  - a summary at the top: to decide, urgent, on your plate;
  - then groups: *Needs your call*, *On your plate* (items that need his time), *Answered, the manager is on it*, and *Decided* (folded, with the manager's own resolution).
- **Each card** is built like a Slack message attachment:
  - a color bar for urgency: red when blocking or overdue, amber when due within a day, green when answered, grey when done;
  - chips for blocking, the deadline, and "asked again";
  - the question; a box with **Recommended** and **If you don't answer**;
  - the options as Block Kit buttons, the recommended one primary. There is also "Something else…" for words, and "Go with the default" or "Done" where there are no buttons.
- **Confirming:** picking an option asks once more ("Your answer: …"), with Escape to go back. Then it says "You chose … · time", and later "Decided: …" with how the manager settled it.
- **Links back:** "Why the manager asks" expands the manager's message. "Show in chat" scrolls to it and highlights it.
- **In the chat**, the manager's message no longer shows the raw `[buttons …]` line (clean mode). The same card sits under it, so a decision can be made where it was asked. A principal's tap shows as "You chose “…” · ny-…".
- **Narrow windows:** below a readable conversation width (560px), the right panel lies over the conversation instead of squeezing it, as Slack does.

**Not done here:**
- Answering a worker's menu from the panel. That needs key presses into a menu, checked against Claude Code's menu behavior first.
- A queue for answers refused because the manager's input box is busy. kira queues taps; the hub says why and lets the principal try again.
- Notifications.

**Update (same morning), from the owner's feedback:** "the decisions should be default and also the right sidebar should always be open when you are in the chat with the manager or in general for all chats".
- The right panel is now open by default beside every conversation, and its first tab is **Decisions**.
- The agent's live screen moved into the panel's second tab, **Screen**. The channel's own Screen tab stays.
- The header's panel button only shows or hides the panel.
- Closing the panel is remembered on the device, under a new storage key, so an older "screen panel" setting doesn't carry over.
- In a window too narrow for the panel beside a 560px conversation, the panel stays shut until asked for, then lies over the conversation.

## Addendum (2026-10-01, morning): Desktop and Terminal tabs replace Screen

The requirement, after a look at noVNC, KasmVNC, Selkies, ttyd and xterm.js: a Desktop tab (a browser view of the desktop) and a separate tab for the tmux pane. The old Screen tab goes. Watching is open; control starts only after a passkey check.

1. **Every conversation's tabs are now Messages, Desktop and Terminal.** The text Screen tab, and the screen in the right-hand panel, are gone. The right panel holds the decisions only.
2. **Desktop** is the office's shared desktop, display :1 (TigerVNC 1.13), shown with noVNC 1.7.0 in the browser.
   - **The bridge** is the hub's own `/api/desktop` WebSocket to the VNC server (`MORNDO_VNC`). It doesn't depend on the box's websockify.
   - **Login:** the hub logs in itself with the vncpasswd file (`MORNDO_VNC_PASSWORD_FILE`, default `~/.vnc/passwd`). It offers the browser only security type None, so the VNC password never reaches a browser.
   - **DES:** VNC's login needs single DES, which Node's OpenSSL 3 doesn't offer. It runs as 3DES with three equal keys (checked against the FIPS 81 vector), with VNC's bit-mirrored key bytes. A test reads back a password that `vncpasswd -f` wrote, and logs in to a real, private Xtigervnc.
3. **Terminal** is the agent's tmux pane, drawn by xterm.js 6.0.0.
   - **Frames:** the hub sends a frame every 80 ms, and only when it changed. A frame is `capture-pane -e` with colors, plus the cursor and size from `display-message`.
   - **No client attaches**, so nobody else's window is resized or switched.
   - **Keys** go in with `send-keys`: ASCII as hex bytes (`-H`), everything else as literal UTF-8 (`-l`). Arrows, Ctrl keys and Enter therefore arrive as typed. That makes an agent's menu answerable from the browser.
4. **Watching and control (AC9):**
   - Watching needs a valid session.
   - Control is a Command (AC7), granted per connection on "Take control", which asks for Face ID or Touch ID unless the last check is fresh.
   - A watching desktop connection parses every client message. It forwards only what shapes the picture (pixel format, encodings, update requests, continuous updates, fences). It drops clipboard, which noVNC announces on connect even in view-only mode. Keys, pointer, resizing and power close the connection.
   - A watching terminal connection that sends keys is closed.
   - Control lapses with the passkey freshness: the hub checks every 5 seconds and closes a lapsed control connection.
   - Starting and ending control are audited (`ControlStarted`, `ControlEnded` with "released" or "lapsed"). Keystrokes and pointer moves never are.
5. **Performance and size:**
   - noVNC uses Tight/JPEG (quality 6, compression 2) and scales to the tab, with a full-screen button.
   - Both tabs load their libraries only when first opened, so the chat stays light: no chunk over the 500 kB warning.

**Third-party pieces:**
- **noVNC 1.7.0:** MPL-2.0 core, used unmodified from npm. MPL is file-level copyleft: if we ever change a noVNC file, that file's source must be offered under the MPL. Using it unchanged needs only its license kept with copies.
- **xterm.js 6.0.0:** MIT.
- No code was copied from either.

**Rejected:**
- **KasmVNC (GPL-2.0):** faster encoders, but it would replace the TigerVNC server every agent and the owner use, and it's strong copyleft.
- **Selkies (MPL-2.0, WebRTC):** video-grade streaming, but it needs GStreamer and a second capture of the display.
- **ttyd:** last release 1.7.7 in March 2024.
- **Attaching a tmux client per viewer:** with `window-size latest`, a viewer's size would resize the agents' windows. `capture-pane` needs no client.

**Update (same morning), after the product lane's architecture review:**
1. **Starting control needs a fresh passkey check (within 5 minutes), whatever the step-up setting.** Before, "only when I sign in" with a 30-day sign-in let control of the desktop (with the owner's logged-in Chrome) start without Face ID. The owner chose "control after passkey"; the step-up setting is about sending messages. Once started, control holds while the step-up policy holds.
2. **An agent's own `STATUS: DONE` now shows as a neutral "Says done", no longer as a green "Done".** It is the worker's claim; the domain shows success only for a Verdict from a check run by someone other than the worker (V1, V4, E6). Blocked, Failed and Needs decision keep their colors: those aren't success claims.

## Addendum (2026-10-01, midday): files and images in the chat

The requirement: the messages tab shows files and images an agent sends.

**Where files come from**, read in the transcript adapter (`claude-sessions.ts`):
- **An agent sends** with the box's `lanes sendfile <path> [caption]`. It hands the absolute path to the chat bot and prints `sent <path>` for each file. The adapter takes the paths from those printed lines, never from the command, because commands often use variables or loops.
  - Captions come from the command only where they are plain text and each call sent one file. A caption is never guessed.
  - A failed send, or another command printing "sent …", makes no file.
- **The principal attaches** a file through the chat bot, which types `[The owner attached a file: <path>]` into the lane. The file is attached to his message. Clean mode hides that note; verbose mode shows it.

**The hub keeps its own copy** (`files.ts`):
- **Why a copy:** agents often send from temporary scratchpads that are deleted later. The copy is made when the message is first read, so the chat keeps showing what was sent.
- **How copies are kept:** content-addressed with SHA-256, under the hub's data directory, at most 25 MB each and 2 GB in all, oldest dropped first. An index keeps a copy reachable after the original is gone.
- **Refused, whatever a transcript claims**, checked on the resolved real path (a symbolic link doesn't get around it):
  - anything that isn't a regular file, or is over the cap;
  - anything under places where credentials live (`.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`, `gcloud` and `gh` configuration, keyrings, `.vnc`, Claude Code's credentials, `/etc`), or in the hub's own data directory;
  - anything named like a secret (`.env`, `*.pem`, `*.key`, `id_*`, `.netrc`, …).
- **Serving:** a copy is served only by its id (`/api/files/<32 hex>`) to a signed-in session, never by path.
  - **Never as a page of the hub:** every response is sandboxed (CSP `sandbox`, no scripts, an opaque origin) with nosniff, and text is served as text/plain. An SVG or HTML file opened in its own tab therefore can't act as the principal.
  - **PDFs** are the exception: Chrome's viewer refuses sandboxed documents, so they get a CSP that allows nothing instead.
  - Anything that isn't an image, video, audio, text or PDF downloads as an attachment.

**How the chat shows them**, as Slack does:
- images inline (up to 360×300), opening full size in a viewer (Escape closes);
- video and audio with players;
- text and Markdown as a card with a preview (Markdown rendered and sanitized, the first 200 KB);
- PDFs with Open and Download;
- anything else as a download card;
- a file the hub couldn't keep as "Not available".

**Not done here:** images an agent only looked at (Read results) aren't shown; they aren't sent to the principal.

## Addendum (2026-10-01, afternoon): paste images for an agent to look at

The requirement: the user can paste an image into the chat so the manager can look at it.

**How an image reaches an agent:**
- Claude Code takes an image three ways: dragged into its window, pasted with Ctrl+V from its own machine's clipboard, or by path ("Analyze this image: /path/to/your/image.png"). Source: https://code.claude.com/docs/en/common-workflows#work-with-images, checked 2026-10-01.
- A browser elsewhere can only use the third. The hub saves the image on the office's machine and sends its path after the principal's text.
- The note is the one the box's chat bot already types for Telegram photos, `[The owner attached a file: <path>]`. The manager's instructions name it, and one definition (`attachment-note.ts`) serves both the writing and the transcript reading.

**Proof:** a headless Claude Code 2.1.286 session (`claude -p … --allowedTools Read`) got only that note for a synthetic 240×120 PNG, green on the left and purple on the right. It answered "Left is green, right is purple."

**Rules (domain `steering.ts`; S1 to S3 in `docs/domain.md`):**
- **S1:** an upload is an image by its own bytes (PNG, JPEG, GIF or WebP magic bytes, never the browser's claim; SVG is refused) and at most 10 MB.
- **S2:** a Command attaches only uploads from its own Endpoint, within a day, each once, at most six.
- **S3:** the notes follow the text, one per image, and a Command may be only images.
- Sending stays a Command under AC7. The audit records how many images were attached, never their paths or bytes.

**Storage:**
- **The inbox** is `MORNDO_INBOX`, default `~/.cache/morndo/inbox`. It lies outside the hub's data directory, so the file store keeps its own copy when the message shows up, and the chat shows the image under the principal's message.
- **Files** are readable by this user only, and are removed after a week.
- **Metadata:** before an image goes on to a model provider, JPEG EXIF, XMP and IPTC segments and comments are dropped, and so are PNG text, time and EXIF chunks (location, camera, captions). GIF and WebP pass unchanged.

**The composer:**
- Paste a screenshot, drop images on the box, or use the paperclip.
- Images upload at once and show as thumbnails you can remove. A non-image is refused with a note.
- Enter sends the text with the images, and the sent message shows the thumbnails until the conversation shows it.
- A send that fails keeps the images in the box.
- The app's CSP adds `blob:` to img-src for the thumbnails.
