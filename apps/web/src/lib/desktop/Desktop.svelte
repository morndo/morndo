<script lang="ts">
  // The Slack-style desktop client (ADR-0006). Frame: 40px top bar, 70px rail, and a panel inset 4px at the right and
  // bottom with a 6px radius, holding the resizable sidebar, the channel, and the right-hand panel with the decisions.
  import { onDestroy, onMount, untrack } from "svelte";
  import type { Message, RosterEntry } from "@morndo/domain";
  import { LiveFeed } from "../feed.svelte.ts";
  import { noteActivity } from "../phone/chat/away.ts";
  import ActivityView from "./ActivityView.svelte";
  import BoardView from "./BoardView.svelte";
  import HomeView from "./HomeView.svelte";
  import { REFUSALS as BOARD_REFUSALS, workingOn } from "./board.ts";
  import ContextMenu, { type MenuEntry } from "./ContextMenu.svelte";
  import DetailsModal from "./DetailsModal.svelte";
  import PreferencesModal from "./PreferencesModal.svelte";
  import { STEP_UP_MS, type Policy } from "../SecurityChoices.svelte";
  import { ConversationSettings } from "./prefs.svelte.ts";
  import { withoutFileNotes } from "./present.ts";
  import ChannelView from "./ChannelView.svelte";
  import type { SentFile } from "../attach.ts";
  import type { Outgoing } from "./MessageList.svelte";
  import type { Outbox } from "../outbox/outbox.ts";
  import { startDeviceOutbox } from "../outbox/device.ts";
  import type { OutboxRecord } from "../outbox/state.ts";
  import Rail, { type View } from "./Rail.svelte";
  import Sidebar from "./Sidebar.svelte";
  import { sentTo } from "../manager.ts";
  import { SEEN_MARK, unseen } from "../alerts.ts";
  import TopNav from "./TopNav.svelte";
  import DecisionCard, { type AnswerBody, type AnswerProblem } from "./DecisionCard.svelte";
  import { UNKNOWN, hubRefusal } from "../catchup/answer.ts";
  import DecisionsPanel from "./DecisionsPanel.svelte";
  import RightPanel from "./RightPanel.svelte";
  import { REFUSALS, waitingCount, type DecisionItem } from "./decisions.ts";
  import { clampRight, layoutIsNarrow, widthAfterWindowChange } from "./panel-width.ts";
  import type { AskOutcome } from "./answer-session.ts";
  import { api, ApiError, explain } from "../api.ts";
  import { askForBrief as sharedAsk } from "../ask-brief.ts";
  import { decodeJobs, type ShownJob } from "./jobs.ts";
  import { stepUp, withStepUp } from "../stepup.ts";
  import LinkedNotice from "../LinkedNotice.svelte";
  import FleetNotice from "../FleetNotice.svelte";
  import "./desk-tokens.css";

  let { device, office, verifiedAt: initialVerifiedAt, policy: initialPolicy, desktop = false, engines = false, onSignedOut }: {
    device: string; office: string; verifiedAt: number | null; policy: Policy; desktop?: boolean; engines?: boolean; onSignedOut: () => void;
  } = $props();
  let policy = $state<Policy>({ stay: "7d", stepUp: "1h" });
  $effect.pre(() => { policy = initialPolicy; });
  let preferences = $state<"security" | "devices" | null>(null);

  const feed = new LiveFeed();
  feed.layout = "desk";
  feed.onEnded = () => onSignedOut();

  const store = {
    get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v === null ? d : (JSON.parse(v) as T); } catch { return d; } },
    set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked: fine */ } },
  };

  let view = $state<View>("dashboard");                 // Home (ADR-0016) is where the desktop opens
  let selected = $state<string | null>(null);
  // ADR-0015: the task open beside the board, by key.
  let openTask = $state<string | null>(null);
  let openJobId = $state<string | null>(null);
  async function loadHiddenJobs(before: string | null): Promise<{ jobs: ShownJob[]; next: string | null }> {
    const path = before === null ? "/api/jobs?hidden=1" : `/api/jobs?before=${encodeURIComponent(before)}`;
    const body = await api.get<{ jobs: unknown[]; next: string | null }>(path);
    return { jobs: decodeJobs(body.jobs).jobs, next: typeof body.next === "string" ? body.next : null };
  }
  const blockedTasks = $derived(feed.board.filter(t => t.status === "blocked").length);
  // A change to the board is a Command (AC7): a stale passkey check is redone first. Null when it went, else why not.
  async function boardCall(path: string, body: Record<string, unknown>): Promise<string | null> {
    try {
      await withStepUp(() => api.post(path, body), at => (verifiedAt = at));
      return null;
    } catch (e) {
      if (e instanceof ApiError) return BOARD_REFUSALS[e.code] ?? explain(e);
      return explain(e);
    }
  }
  const boardAct = (key: string, body: Record<string, unknown>) => boardCall(`/api/board/tasks/${encodeURIComponent(key)}`, body);
  const boardCreate = (body: Record<string, unknown>) => boardCall("/api/board/tasks", body);
  function showTask(key: string) { view = "board"; openTask = key; }
  function openLane(name: string) {
    const w = feed.workers.find(x => x.name === name);
    if (w) open(w.id);
  }
  let sidebarWidth = $state(store.get("morndo.sidebar", 300));
  // The stored width is the one the owner chose. A narrow window only changes what is drawn.
  let rightWidth = $state(clampRight(store.get("morndo.right.width", 440)));
  function setRightWidth(n: number, persist = false) {
    rightWidth = clampRight(n);
    if (persist) store.set("morndo.right.width", rightWidth);
  }
  // The right-hand panel with the decisions: open by default beside every conversation. Closing it is remembered on this
  // device.
  let right = $state<{ open: boolean }>(store.get("morndo.right", { open: true }));
  let overlayOpen = $state(false);                       // narrow windows: it opens over the conversation on demand only
  // The outbox (ADR-0008 phase C): Commands written down on this device, sent, retried, resumed after a reload, and
  // ended by their echo. `previews` are the images' thumbnails for this page's life (blob URLs aren't kept).
  let outgoing = $state<OutboxRecord[]>([]);
  const previews = new Map<string, string[]>();
  const sentFiles = new Map<string, SentFile[]>();
  let outbox: Outbox | null = null;
  let deviceOutbox: ReturnType<typeof startDeviceOutbox> | null = null;
  let markReady: (o: Outbox) => void = () => {};
  const outboxReady = new Promise<Outbox>(r => (markReady = r));
  let verifiedAt = $state<number | null>(null);
  $effect.pre(() => { if (verifiedAt === null) verifiedAt = initialVerifiedAt; });
  let searchEl = $state<HTMLInputElement | null>(null);
  const settings = new ConversationSettings();
  let menu = $state<{ x: number; y: number; id: string } | null>(null);
  let details = $state<{ id: string; tab: "about" | "settings" } | null>(null);
  const detailsWorker = $derived(details ? feed.workers.find(w => w.id === details?.id) ?? null : null);
  let composerEl = $state<HTMLTextAreaElement | null>(null);
  let now = $state(Date.now());
  let screenRequest = $state<{ worker: string; n: number } | null>(null);
  let focus = $state<{ id: string; n: number } | null>(null);

  // The roster lists the manager even while it has no window (a restart): not running, and a message to it can wait.
  const manager = $derived(feed.roster.find(w => w.name === "manager") ?? null);
  const current = $derived(feed.roster.find(w => w.id === selected) ?? null);
  const nameOf = (w: RosterEntry) => (w.name === "manager" ? "Manager" : w.name);
  // Activity's count: who waits for him, and the fleet's alerts he hasn't seen (they are on Activity too).
  const needsYouCount = $derived(feed.workers.filter(w => w.needsYou).length + unseen(feed.alerts, feed.reads[SEEN_MARK]));
  const decisionsWaiting = $derived(waitingCount(feed.decisions));
  const decisionByMessage = $derived(new Map(feed.decisions.filter(d => d.messageId).map(d => [d.messageId as string, d])));
  const stepUpMs = $derived(STEP_UP_MS[policy.stepUp]);
  // verifiedAt 0: a device added from another that hasn't verified for Commands yet (AC12; review L3).
  const verifiedFresh = $derived(verifiedAt !== null && verifiedAt > 0 && (stepUpMs === null || now - verifiedAt < stepUpMs));
  // Like Slack, the right-hand panel sits beside the conversation while the conversation keeps a readable width (560px);
  // in a narrower window it stays shut until asked for, and then lies over the conversation.
  let windowWidth = $state(typeof innerWidth === "number" ? innerWidth : 1920);
  const drawnRight = $derived(widthAfterWindowChange(rightWidth, windowWidth, sidebarWidth).drawn);
  const narrow = $derived(layoutIsNarrow(windowWidth, sidebarWidth));
  const rightShown = $derived(narrow ? overlayOpen : right.open);
  const decisionsShown = $derived(rightShown);
  function saveRight(next: { open: boolean }) { right = next; store.set("morndo.right", next); }
  function showRight() { saveRight({ open: true }); if (narrow) overlayOpen = true; }
  function toggleRight() { if (narrow) overlayOpen = !overlayOpen; else saveRight({ open: !right.open }); }
  function closeRight() { if (narrow) overlayOpen = false; else saveRight({ open: false }); }

  // The principal's Decision: the hub delivers it to the asker; a stale passkey check is redone first (AC7). The card
  // names the request id, so Check again sends the one that may have been typed, which the hub never types twice.
  // The hub's own word is its code ("uncertain": the asker's machine may have typed it); no word of the hub's own (the
  // connection failed, a proxy's page) is "unknown", which may have gone too; anything else (a cancelled passkey
  // prompt) sent nothing.
  async function answer(id: string, body: AnswerBody, requestId: string, seen?: string): Promise<AnswerProblem | null> {
    try {
      await withStepUp(() => api.post(`/api/escalations/${encodeURIComponent(id)}/answer`, { ...body, requestId, ...(seen ? { seen } : {}) }), at => (verifiedAt = at));
      return null;
    } catch (e) {
      if (e instanceof ApiError) return e.code === `http_${e.status}` ? { code: "unknown", text: UNKNOWN } : { code: hubRefusal(e), text: REFUSALS[hubRefusal(e)] ?? explain(e) };
      if (e instanceof TypeError) return { code: "unknown", text: UNKNOWN };     // fetch failed: no answer came
      return { code: "error", text: explain(e) };
    }
  }
  function openScreen(workerId: string) { open(workerId); overlayOpen = false; screenRequest = { worker: workerId, n: (screenRequest?.n ?? 0) + 1 }; }
  async function askForBrief(d: DecisionItem): Promise<AskOutcome> {
    return sharedAsk(d, feed.workers, c => onQueue({ target: c.worker, targetName: c.workerName, text: c.text, uploads: [], images: [], files: [], seen: c.seen }), async () => {
      if (verifiedFresh || navigator.onLine === false) return null;
      try { verifiedAt = await stepUp(); } catch (e) { return explain(e); }
      return null;
    });
  }
  function openChat(d: DecisionItem) {
    if (!d.asker.workerId || !d.messageId) return;
    open(d.asker.workerId);
    overlayOpen = false;
    focus = { id: d.messageId, n: (focus?.n ?? 0) + 1 };
  }
  // Mute and read marks live on the hub, the same on every device (phase D); show and star stay on this device.
  const prefsOf = (name: string) => ({ ...settings.get(name), muted: feed.muted.includes(name) });
  function setPrefs(name: string, patch: Partial<ReturnType<typeof prefsOf>>) {
    const { muted, ...rest } = patch;
    if (muted !== undefined) feed.setMuted(name, muted);
    if (Object.keys(rest).length) settings.set(name, rest);
  }
  const unread = (w: RosterEntry) => !feed.muted.includes(w.name) && !!w.lastMessageAt && w.lastMessageAt > (feed.reads[w.name] ?? 0) && !(view === "home" && selected === w.id);

  function openDetails(id: string, tab: "about" | "settings" = "about") { feed.askDetails(id); details = { id, tab }; }
  async function copy(text: string) { try { await navigator.clipboard.writeText(text); } catch { /* clipboard refused */ } }
  function menuFor(w: RosterEntry): MenuEntry[] {
    const p = prefsOf(w.name);
    return [
      { kind: "item", label: "Conversation details", action: () => openDetails(w.id) },
      { kind: "item", label: "Copy name", action: () => copy(nameOf(w)) },
      { kind: "item", label: p.starred ? "Unstar conversation" : "Star conversation", action: () => settings.set(w.name, { starred: !p.starred }) },
      { kind: "sep" },
      { kind: "label", text: "Show in chat…" },
      { kind: "radio", label: "Answers only", checked: p.show === "clean", action: () => settings.set(w.name, { show: "clean" }) },
      { kind: "radio", label: "Everything (verbose)", checked: p.show === "verbose", action: () => settings.set(w.name, { show: "verbose" }) },
      { kind: "item", label: "More options", submenu: true, action: () => openDetails(w.id, "settings") },
      { kind: "sep" },
      { kind: "item", label: "Open its terminal", action: () => openScreen(w.id) },
      { kind: "sep" },
      { kind: "item", label: p.muted ? "Unmute conversation" : "Mute conversation", action: () => setPrefs(w.name, { muted: !p.muted }) },
    ];
  }

  // Pick a channel: the last one, else the manager, else the first agent.
  $effect(() => {
    if (selected && feed.roster.some(w => w.id === selected)) return;
    const last = store.get<string | null>("morndo.channel", null);
    const pick = feed.roster.find(w => w.name === last) ?? manager ?? feed.roster[0];
    if (pick) selected = pick.id;
  });
  $effect(() => { if (view === "home") feed.watch(selected); });
  $effect(() => {
    const w = current;
    if (!w || view !== "home") return;
    store.set("morndo.channel", w.name);
  });
  // The read mark when a conversation's messages arrive, kept for its "New messages" divider until it is left (phase D),
  // for another conversation or another view (review M3): back from the Activity view it is read afresh.
  let opened = $state<{ worker: string; mark: number | null } | null>(null);
  $effect(() => {
    if (view !== "home") { opened = null; return; }
    const id = feed.historyFor;
    const w = feed.workers.find(x => x.id === id);
    if (id && w && opened?.worker !== id) opened = { worker: id, mark: untrack(() => feed.reads[w.name] ?? null) };
  });
  // Read (O7): this conversation open, the page visible, and its list at the bottom; the mark goes to the hub, up to the
  // last message the list holds, and never while the newest are trimmed away (detached): only what was on screen
  // (review M3). At the bottom of which conversation's list: the list says so, and says "not" when it goes (another
  // conversation, view or tab), so a flag left over never marks one read on its return.
  let atBottom = $state<{ worker: string; value: boolean } | null>(null);
  let visible = $state(typeof document === "undefined" || document.visibilityState === "visible");
  $effect(() => {
    const w = current;
    if (!w || view !== "home" || !visible || atBottom?.worker !== w.id || !atBottom.value || opened?.worker !== w.id) return;
    if (feed.detached || feed.historyFor !== w.id) return;
    const last = feed.messages.at(-1);
    if (last) feed.markRead(w.name, last.at);
  });

  // The principal's own messages as the conversation shows them end the matching Sent entries (S8). The echo carries
  // the notes for attached images after the text; matched on the text alone.
  const echoesOf = (messages: Message[]) => messages.filter(m => m.author.kind === "principal").map(m => ({ id: m.id, at: m.at, text: withoutFileNotes(m.text) }));
  $effect(() => {
    const worker = feed.historyFor;
    const messages = feed.messages;
    const name = feed.roster.find(w => w.id === worker)?.name ?? "";
    const sent = worker !== null && outgoing.some(r => sentTo(r, { id: worker, name }) && r.state === "sent");
    if (outbox && worker && sent) void outbox.echoes(worker, echoesOf(messages), name);
  });
  // Waiting sends try at once when the feed is live again (S7).
  $effect(() => { if (feed.status === "live") outbox?.connected(); });
  // Messages to the manager in the fleet's queue move on as the hub says (fleet-clients §9.1).
  $effect(() => { const items = feed.deliveries; if (items.length) void outboxReady.then(o => o.deliveries(items)); });

  function open(id: string) { view = "home"; selected = id; }
  // Resolves once the message is written down on this device; throws if it couldn't be, so the composer keeps the draft
  // (review M6). Waits for the outbox if the page has only just opened.
  async function onQueue(c: { target: string; targetName: string; text: string; uploads: string[]; images: string[]; files: SentFile[]; seen: string; held?: string }) {
    const o = await outboxReady;
    const r = await o.enqueue({ worker: c.target, workerName: c.targetName, text: c.text, uploads: c.uploads, seen: c.seen }, c.held);
    if (c.images.length) previews.set(r.id, c.images);
    if (c.files.length) sentFiles.set(r.id, c.files);
    // Reading far back: the latest come back, so the message and its echo show where they belong (review L4).
    if (feed.detached && feed.watching === c.target) feed.latest();
  }
  function forget(id: string) {
    const shown = previews.get(id);
    previews.delete(id);
    sentFiles.delete(id);
    setTimeout(() => shown?.forEach(u => URL.revokeObjectURL(u)), 60_000);   // the echoed message may still show them a while
  }
  async function onRetry(id: string) { await outbox?.retry(id); }
  async function onDiscard(id: string) { forget(id); await outbox?.discard(id); }
  // Cancel: the hub withdraws a message the manager's queue still holds (ruling 83); its entry then says Not delivered.
  async function onCancel(id: string) { await outbox?.cancel(id); }
  // "Not sent: verify": the passkey check, then the same request id again (AC7 is judged when it arrives).
  async function onVerify(id: string) {
    try { verifiedAt = await stepUp(); } catch { return; }
    await outbox?.retry(id);
  }
  // "The question changed": the text goes back into its box to be read again, and the entry goes.
  let editRequest = $state<{ worker: string; text: string; n: number } | null>(null);
  const onEdited = () => { editRequest = null; };                  // used once, never again on a remount (review M4)
  async function onEdit(id: string) {
    const r = outgoing.find(x => x.id === id);
    if (!r) return;
    editRequest = { worker: r.worker, text: r.text, n: (editRequest?.n ?? 0) + 1 };
    await onDiscard(id);
  }

  function startResize(e: PointerEvent) {
    const startX = e.clientX, startW = sidebarWidth;
    const move = (ev: PointerEvent) => { sidebarWidth = Math.min(480, Math.max(220, startW + ev.clientX - startX)); };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); store.set("morndo.sidebar", sidebarWidth); };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }

  function onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchEl?.focus(); return; }
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const order = [manager, ...feed.workers.filter(w => w !== manager).sort((a, b) => a.name.localeCompare(b.name))].filter(Boolean) as RosterEntry[];
      const i = order.findIndex(w => w.id === selected);
      const next = order[(i + (e.key === "ArrowDown" ? 1 : -1) + order.length) % order.length];
      if (next) { e.preventDefault(); open(next.id); }
    }
  }

  // Where a notification's click opens the app (phase F): ?view=decisions or ?view=activity, then a clean address. The
  // service worker navigates an open window there too, which loads the page again.
  function openFromAddress() {
    const v = new URLSearchParams(location.search).get("view");
    if (v === "decisions") showRight();
    else if (v === "activity" || v === "alerts") view = "activity";            // the fleet's alerts are on Activity
    if (v) history.replaceState(history.state, "", location.pathname);
  }

  onMount(() => {
    openFromAddress();
    const resized = () => (windowWidth = innerWidth);
    addEventListener("resize", resized);
    const shown = () => (visible = document.visibilityState === "visible");
    document.addEventListener("visibilitychange", shown);
    feed.start();
    // The device's outbox (outbox/device.ts): one sender across tabs, resumed after a reload.
    deviceOutbox = startDeviceOutbox({
      connected: () => feed.status === "live" && navigator.onLine !== false,
      onChange: records => {
        outgoing = records;
        for (const id of new Set([...previews.keys(), ...sentFiles.keys()])) if (!records.some(r => r.id === id)) forget(id);
      },
    });
    void deviceOutbox.ready.then(o => { outbox = o; markReady(o); });
    addEventListener("keydown", onKey);
    const onActivity = () => { try { noteActivity(localStorage, Date.now()); } catch { /* storage blocked */ } };
    for (const ev of ["pointerdown", "keydown", "touchstart"] as const) addEventListener(ev, onActivity, { capture: true });
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => {
      clearInterval(t);
      removeEventListener("resize", resized);
      document.removeEventListener("visibilitychange", shown);
      for (const ev of ["pointerdown", "keydown", "touchstart"] as const) removeEventListener(ev, onActivity, { capture: true });
    };
  });
  onDestroy(() => { feed.stop(); deviceOutbox?.stop(); removeEventListener("keydown", onKey); });
</script>

{#snippet inlineCard(d: DecisionItem)}
  <DecisionCard item={d} variant="inline" {now} {verifiedFresh} onAnswer={answer} onOpenScreen={openScreen} />
{/snippet}

<div class="desk desk-tokens">
  {#if menu}
    {@const w = feed.workers.find(x => x.id === menu?.id)}
    {#if w}<ContextMenu x={menu.x} y={menu.y} entries={menuFor(w)} label="{nameOf(w)} options" onClose={() => (menu = null)} />{/if}
  {/if}
  {#if preferences}
    <PreferencesModal {policy} tab={preferences} onPolicy={p => (policy = p)} onVerified={at => (verifiedAt = at)}
      onSignedOut={() => { preferences = null; onSignedOut(); }} onClose={() => (preferences = null)} />
  {/if}
  {#if details && detailsWorker}
    <DetailsModal worker={detailsWorker} displayName={nameOf(detailsWorker)} session={feed.details[detailsWorker.id]}
      prefs={prefsOf(detailsWorker.name)} tab={details.tab} onPrefs={p => detailsWorker && setPrefs(detailsWorker.name, p)}
      onScreen={() => { if (detailsWorker) openScreen(detailsWorker.id); }}
      onClose={() => (details = null)} />
  {/if}
  <LinkedNotice linked={feed.linked} onReview={() => (preferences = "devices")} onSeen={at => feed.seeLinked(at)} />
  <FleetNotice available={feed.fleetAvailable} />
  <TopNav {office} {sidebarWidth} workers={feed.workers} status={feed.status} onPick={open} bind:searchEl />
  <div class="body">
    <Rail {office} {view} needsYou={needsYouCount} managerUnread={!!manager && unread(manager)} {device} blocked={blockedTasks}
      decisions={decisionsWaiting} decisionsOpen={decisionsShown} onDecisions={showRight}
      onView={v => (view = v)} onManager={() => manager && open(manager.id)} onPreferences={t => (preferences = t)} />
    <div class="workspace">
      <div class="panel" class:over={narrow && rightShown} style:--right-w="{drawnRight}px" style:grid-template-columns="{sidebarWidth}px minmax(0, 1fr){rightShown && !narrow ? ` ${drawnRight}px` : ''}">
        <Sidebar {office} workers={feed.workers} {manager} {selected} {view} {unread} {needsYouCount} {engines} runs={feed.boardRuns}
          decisions={decisionsWaiting} decisionsOpen={decisionsShown} onDecisions={showRight}
          {prefsOf} onMenu={(id, x, y) => (menu = { x, y, id })}
          onSelect={open} onActivity={() => (view = "activity")} onCompose={() => { if (manager) { open(manager.id); setTimeout(() => composerEl?.focus(), 50); } }} />
        <div class="resizer" role="separator" aria-orientation="vertical" aria-label="Resize the sidebar" style:left="{sidebarWidth - 2}px" onpointerdown={startResize}></div>
        <main class="main">
          {#if view === "activity"}
            <ActivityView workers={feed.workers} onOpen={open} {nameOf}
              alerts={feed.alerts} seenAt={feed.reads[SEEN_MARK] ?? 0} onSeen={at => feed.markRead(SEEN_MARK, at)} />
          {:else if view === "dashboard"}
            <HomeView accounts={feed.usage} at={feed.usageAt} live={feed.usageAt !== null} {now} onOpenLane={openLane} />
          {:else if view === "board"}
            <BoardView tasks={feed.board} lanes={feed.boardLanes} runs={feed.boardRuns} live={feed.boardAt !== null} {now} open={openTask} jobs={feed.jobs} counts={feed.jobCounts} more={feed.jobsMore} openJob={openJobId} onOpen={k => (openTask = k)} onOpenJob={id => (openJobId = id)} onLoadJobs={loadHiddenJobs}
              onAct={boardAct} onCreate={boardCreate} onOpenLane={openLane} />
          {:else if current}
            <ChannelView worker={current} displayName={nameOf(current)} {feed} {verifiedAt} panel={rightShown}
              outgoing={outgoing.filter(r => current !== null && sentTo(r, current)).map((r): Outgoing => ({ ...r, images: previews.get(r.id) ?? [], files: sentFiles.get(r.id) ?? [] }))}
              {onQueue} {onRetry} {onDiscard} {onCancel} {onVerify} {onEdit} {editRequest} {onEdited}
              prefs={prefsOf(current.name)} onDetails={() => current && openDetails(current.id)}
              dividerMark={opened?.worker === current.id ? opened.mark : undefined} onAtBottom={(value, worker) => (atBottom = { worker, value })}
              {stepUpMs} onSecurity={() => (preferences = "security")}
              onPanel={toggleRight} onVerified={at => (verifiedAt = at)} bind:composerEl
              decisions={decisionsWaiting} decisionsOpen={decisionsShown} onDecisions={showRight}
              {screenRequest} decisionOf={id => decisionByMessage.get(id)} card={inlineCard} {focus} {desktop}
              task={workingOn(feed.board, current.name)} onOpenTask={showTask} />
          {:else}
            <div class="empty">{feed.status === "live" ? "No agents are running on this machine." : "Connecting to the hub…"}</div>
          {/if}
        </main>
        {#if rightShown}
          <RightPanel waiting={decisionsWaiting} width={drawnRight} chosen={rightWidth} onWidth={(n) => setRightWidth(n)} onCommit={(n) => setRightWidth(n, true)} onClose={closeRight}>
            <DecisionsPanel items={feed.decisions} ledger={feed.ledger} {now} {verifiedFresh} onAnswer={answer}
              onOpenScreen={openScreen} onOpenChat={openChat} onAskBrief={askForBrief} />
          </RightPanel>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  /* The colour tokens are in desk-tokens.css. */
  .desk {
    height: 100dvh; display: grid; grid-template-rows: 40px minmax(0, 1fr); background: var(--frame); color: var(--text);
    font: 400 15px/22px var(--font); overflow: clip;              /* clip, not hidden: the frame itself can never scroll */
    --fleet-notice-top: 48px;                                     /* "Fleet unavailable" below the 40px top bar */
  }
  /* Like Slack, the page never scrolls; only the sidebar list, the message pane and the screen do. */
  :global(html:has(.desk)), :global(body:has(.desk)) { overflow: hidden; overscroll-behavior: none; }
  .body { display: flex; min-height: 0; }
  .workspace { flex: 1; min-width: 0; min-height: 0; padding: 0 4px 4px 0; display: flex; }
  .panel {
    position: relative; flex: 1; min-width: 0; min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr);
    border-radius: 6px; overflow: clip; background: var(--main-bg);
  }
  .resizer { position: absolute; top: 0; bottom: 0; width: 4px; cursor: col-resize; z-index: 5; }
  .resizer:hover { background: var(--border-strong); }
  .main { display: flex; min-width: 0; min-height: 0; border-left: 1px solid var(--border-soft); }
  .empty { margin: auto; color: var(--muted); }
  .panel.over > :global(.side-panel) {
    position: absolute; top: 0; right: 0; bottom: 0; width: min(var(--right-w), calc(100% - 16px)); z-index: 6;
    box-shadow: -10px 0 28px rgba(0, 0, 0, 0.16);
  }
</style>
