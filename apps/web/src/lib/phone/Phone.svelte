<script lang="ts">
  // The phone (ADR-0009, ADR-0011): under 900px wide, Chats (the manager pinned, then every
  // lane, newest on top; a tap opens the conversation and its composer), Today (Horizon, when he is next needed) and
  // Status (every lane in one line), plus the board (ADR-0015) and Home (ADR-0016). Decisions keep their cards (catch-up, decisions only), opened from Today, the chat
  // list, a chat that waits, or a push. Updates no longer come as cards: they wait in each chat, and a digest sums them
  // up only when he comes back after a real absence. One live feed and one outbox serve it all.
  import { onDestroy, onMount, untrack } from "svelte";
  import { goto, pushState } from "$app/navigation";
  import { page } from "$app/state";
  import { decisionKey } from "@morndo/domain";
  import { LiveFeed } from "../feed.svelte.ts";
  import LinkedNotice from "../LinkedNotice.svelte";
  import FleetNotice from "../FleetNotice.svelte";
  import { api, ApiError, explain } from "../api.ts";
  import type { SentFile } from "../attach.ts";
  import BoardView from "../desktop/BoardView.svelte";
  import HomeView from "../desktop/HomeView.svelte";
  import { REFUSALS as BOARD_REFUSALS } from "../desktop/board.ts";
  import { stepUp, withStepUp } from "../stepup.ts";
  import { STEP_UP_MS, type Policy } from "../SecurityChoices.svelte";
  import { postAnswer } from "../catchup/answer.ts";
  import type { Body } from "../catchup/run.ts";
  import { AnswerSession } from "../desktop/answer-session.svelte.ts";
  import type { AskOutcome } from "../desktop/answer-session.ts";
  import type { DecisionItem } from "../desktop/decisions.ts";
  import { briefFromPageState, decisionFromSearch } from "./brief-route.ts";
  import BriefSheet from "./BriefSheet.svelte";
  import { startDeviceOutbox } from "../outbox/device.ts";
  import type { Outbox } from "../outbox/outbox.ts";
  import type { OutboxRecord } from "../outbox/state.ts";
  import { CatchUpSession } from "../catchup/session.svelte.ts";
  import { QuickAnswers } from "./quick.svelte.ts";
  import CatchUp from "./CatchUp.svelte";
  import Today from "./Today.svelte";
  import TabBar, { type Tab } from "./TabBar.svelte";
  import ChatList from "./chat/ChatList.svelte";
  import Conversation from "./chat/Conversation.svelte";
  import Status from "./chat/Status.svelte";
  import Digest from "./chat/Digest.svelte";
  import SettingsSheet from "./chat/SettingsSheet.svelte";
  import { Away } from "./chat/away.svelte.ts";
  import { chatEntry, keptChat, restoredChat, restoredScreen } from "./chat/history.ts";
  import { chatRows } from "./chat/rows.ts";
  import type { DigestLine } from "@morndo/domain";
  import "./phone.css";

  let { verifiedAt: initialVerifiedAt, policy, engines = false, onSignedOut }: {
    device: string; verifiedAt: number | null; policy: Policy; engines?: boolean; onSignedOut: () => void;
  } = $props();

  const feed = new LiveFeed();
  feed.layout = "phone";
  feed.onEnded = () => onSignedOut();

  // AC7: deciding and replying need a passkey check fresher than his setting; the card asks first, then goes on.
  let verifiedAt = $state<number | null>(null);
  $effect.pre(() => { if (verifiedAt === null) verifiedAt = initialVerifiedAt; });
  let now = $state(Date.now());
  const stepUpMs = $derived(STEP_UP_MS[policy.stepUp]);
  const verifiedFresh = $derived(verifiedAt !== null && verifiedAt > 0 && (stepUpMs === null || now - verifiedAt < stepUpMs));
  async function verify(): Promise<boolean> {
    try { verifiedAt = await stepUp(); now = Date.now(); return true; }
    catch { return false; }
  }

  // The principal's Decision through the existing path (E8–E12): catchup/answer.ts.
  const session = new CatchUpSession({ feed, answer: (id, body, seen, requestId) => postAnswer(id, body, seen, requestId) });
  // A task's buttons on Today (Done, Later, its options, his own words): the same answer path, its own 5-second window.
  const quick = new QuickAnswers((id, body, seen, requestId) => postAnswer(id, body, seen, requestId));

  // The outbox (ADR-0008 phase C), shared with the desktop's code: replies from a card are Commands like any other.
  let outgoing = $state<OutboxRecord[]>([]);
  let pendingFiles = $state<Record<string, SentFile[]>>({});
  let outbox: Outbox | null = null;
  const device$ = startDeviceOutbox({
    connected: () => feed.status === "live" && navigator.onLine !== false,
    onChange: r => {
      outgoing = r;
      const live = new Set(r.map(x => x.id));
      const kept: Record<string, SentFile[]> = {};
      for (const [id, files] of Object.entries(pendingFiles)) if (live.has(id)) kept[id] = files;
      if (Object.keys(kept).length !== Object.keys(pendingFiles).length) pendingFiles = kept;
    },
  });
  void device$.ready.then(o => { outbox = o; });
  $effect(() => { if (feed.status === "live") outbox?.connected(); });

  // Where he is. A push's click opens the app with ?view=decisions (the decision cards) or ?view=activity (the chats,
  // where a lane that needs him says so). The address is cleaned either way.
  // The tab he used last, on this device (Chats the first time).
  const TAB_KEY = "morndo.tab";
  let tab = $state<Tab>((() => { try { const t = localStorage.getItem(TAB_KEY); return t === "today" || t === "status" || t === "board" || t === "home" ? t : "chats"; } catch { return "chats"; } })());
  $effect(() => { try { localStorage.setItem(TAB_KEY, tab); } catch { /* this page only */ } });
  let deciding = $state(false);                              // the decision cards, full screen, over the tab
  let chat = $state<string | null>(null);                    // the open conversation, by worker id
  let settings = $state(false);
  // The cards open once the feed has said what waits (the roster, the board, the read marks), so a run holds the real
  // cards and never ends empty on a page that is still connecting.
  let want = $state<{ decision?: string; decisions?: boolean } | null>(null);
  // `/?decision=<id>` opens catch-up with that brief's sheet. The query is dropped; the sheet is a history entry.
  let linkedBrief = $state<string | null>(null);
  if (typeof location !== "undefined") {
    const linked = decisionFromSearch(location.search);
    const v = new URLSearchParams(location.search).get("view");
    if (linked) { deciding = true; want = { decision: linked }; linkedBrief = linked; }
    else if (v === "decisions") { deciding = true; want = { decisions: true }; }
    else if (v === "activity") tab = "chats";
    if (linked || v) history.replaceState(history.state, "", location.pathname);
  }
  $effect(() => {
    if (!deciding || !feed.primed || !want) return;
    session.open(want);
    want = null;
  });
  function decide(o: { decision?: string } = {}) { want = o; deciding = true; scrollTo(0, 0); }
  function stopDeciding() { session.leave(); deciding = false; }
  const briefId = $derived(briefFromPageState(page.state));
  let sessions = $state<Record<string, AnswerSession>>({});
  let briefNote = $state<string | null>(null);
  $effect(() => {
    const id = briefId;
    const list = feed.decisions;
    untrack(() => {
      if (!id) { briefNote = null; return; }
      const d = list.find(x => x.id === id);
      if (!d) return;
      const cur = sessions[id];
      if (!cur) sessions[id] = new AnswerSession(d);
      else cur.bind(d, true);
    });
  });
  const briefItem = $derived(briefId ? feed.decisions.find(d => d.id === briefId) ?? null : null);
  const briefSession = $derived(briefId ? sessions[briefId] ?? null : null);
  const briefAnswering = $derived(session.run?.answering && briefId && session.run.answering.id === briefId
    ? { label: session.run.answering.label, sending: session.run.answering.sending, commitAt: session.run.answering.commitAt }
    : null);
  // The sheet is open while page.state.brief is set. Back (and the browser's back) pop that entry.
  function openBrief(id: string) {
    if (!deciding) { want = { decision: id }; deciding = true; }
    else if (!(session.top?.kind === "decision" && session.top.id === id)) session.open({ decision: id });
    if (briefFromPageState(page.state) !== id) pushState("", { brief: id });
    scrollTo(0, 0);
  }
  $effect(() => {
    const id = linkedBrief;
    if (!id || !feed.primed || !feed.decisions.some(d => d.id === id)) return;
    linkedBrief = null;
    if (briefFromPageState(page.state) !== id) pushState("", { brief: id });
  });
  async function answerFromSheet(body: Body, label: string): Promise<boolean> {
    const id = briefId;
    const held = id ? sessions[id] : null;
    if (!id || !held || held.stale) return false;
    briefNote = null;
    if (feed.status !== "live" || navigator.onLine === false) {
      briefNote = "You're offline. A decision goes only while Morndo is connected, so nothing was sent; it stays here.";
      return false;
    }
    if (!verifiedFresh && !(await verify())) { briefNote = "Not answered: the passkey check didn't finish."; return false; }
    if (!session.opened || session.top?.kind !== "decision" || session.top.id !== id) session.open({ decision: id });
    const key = decisionKey(id);
    if (!session.run?.cards[key]) return false;
    session.answer(key, id, body, label, held.seen);
    return session.run.answering?.id === id;
  }
  async function askForBrief(d: DecisionItem): Promise<AskOutcome> {
    const worker = d.asker.workerId;
    if (!worker) return { ok: false, error: "This decision has no one to ask." };
    if (!verifiedFresh && navigator.onLine !== false && !(await verify())) return { ok: false, error: "Not sent: the passkey check didn't finish." };
    const w = feed.workers.find(x => x.id === worker);
    try {
      await queue({ worker, workerName: w?.name ?? d.asker.name, text: `Please restate ${d.id} as a decision brief: morndo-decide template`, uploads: [], seen: w?.waitingOn ?? "none" });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  function go(t: Tab) {
    if (deciding) stopDeciding();
    tab = t;
    scrollTo(0, 0);
  }
  // A conversation is a page of its own: the phone's back gesture closes it (history), as the button does.
  let chatScreen = $state(false);
  function openChat(worker: string, screen = false) {
    if (deciding) stopDeciding();
    chat = worker;
    chatScreen = screen;
    const entry = { chat: worker, screen };
    if (chatEntry(history.state?.chat, worker) === "stay") { history.replaceState(entry, "", location.pathname); return; }
    history.pushState(entry, "", location.pathname);
  }
  function closeChat() { if (history.state?.chat) history.back(); else { chat = null; chatScreen = false; } }
  const onPop = () => { chat = restoredChat(history.state); chatScreen = chat !== null && restoredScreen(history.state); };
  $effect(() => {
    const next = keptChat(chat, feed.workers, feed.primed);
    if (next === chat) return;
    chat = next;
    chatScreen = false;
  });
  // The cards still to come follow the live feed (answered, settled or read elsewhere, or new).
  $effect(() => { void session.cards; void feed.primed; if (deciding) session.follow(); });

  // The chat list (H1, H2): asked for when the feed is current, and again (at most every 2 s) when a lane spoke, a mark
  // moved or the roster changed; each row's status from the roster and the board.
  const rows = $derived(chatRows({ workers: feed.workers, chats: feed.chats, decisions: feed.decisions, muted: feed.muted, now }));
  const unreadChats = $derived(feed.primed ? rows.filter(r => r.unread > 0).length : 0);
  let askedChats = "";
  let askedChatsAt = 0;
  $effect(() => {
    if (!feed.primed) { askedChats = ""; return; }
    const change = `${feed.workers.map(w => `${w.id}:${w.name}:${w.lastMessageAt}`).join(",")}|${JSON.stringify(feed.reads)}`;
    if (change === askedChats) return;
    const t = setTimeout(() => { if (feed.requestChats()) { askedChats = change; askedChatsAt = Date.now(); } }, Math.max(0, 2000 - (Date.now() - askedChatsAt)));
    return () => clearTimeout(t);
  });

  // The digest after a real absence (H4, H5).
  const away = new Away(feed);
  $effect(() => { void feed.presence.n; void feed.primed; away.check(); });
  $effect(() => { if (feed.primed && away.pending) away.refresh(); });
  const digestData = $derived(away.pending && feed.digest?.since === away.pending.since ? feed.digest.conversations : null);
  function markDigestRead(lines: DigestLine[]) {
    for (const l of lines) if (l.lastAt !== null) feed.markRead(l.name, l.lastAt);
    away.close();
  }
  const echoes = (worker: string, e: { id: string; at: number; text: string }[]) => void outbox?.echoes(worker, e);
  const queue = async (c: { worker: string; workerName: string; text: string; uploads: string[]; seen: string; files?: SentFile[] }) => {
    const o = outbox ?? await device$.ready;
    const { files, ...command } = c;
    const r = await o.enqueue(command);
    if (files?.length) pendingFiles = { ...pendingFiles, [r.id]: files };
  };
  // Retry and Send again from a chat pass the passkey check first when it isn't fresh, as a first send does (AC7;
  // validated review finding #1): the hub refuses them step_up otherwise.
  async function again(id: string, how: "retry" | "again") {
    if (!verifiedFresh && navigator.onLine !== false && !(await verify())) return;
    await (how === "retry" ? outbox?.retry(id) : outbox?.again(id));
  }
  const chatWorker = $derived(chat ? feed.workers.find(w => w.id === chat) ?? null : null);
  const blockedTasks = $derived(feed.board.filter(t => t.status === "blocked").length);
  let openTask = $state<string | null>(null);
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
  function openLane(name: string) {
    const w = feed.workers.find(x => x.name === name);
    if (w) openChat(w.id);
  }

  const onHidden = () => { if (document.visibilityState === "hidden") { session.leave(); quick.flush(); } };
  onMount(() => {
    const open = restoredChat(history.state);
    if (open) { chat = open; chatScreen = restoredScreen(history.state); }
    feed.start();
    session.start();
    quick.start();
    away.start();
    document.addEventListener("visibilitychange", onHidden);
    addEventListener("popstate", onPop);
    const t = setInterval(() => (now = Date.now()), 15_000);
    return () => { clearInterval(t); removeEventListener("popstate", onPop); };
  });
  onDestroy(() => {
    session.leave();
    session.stop();
    quick.flush();
    quick.stop();
    away.stop();
    feed.stop();
    device$.stop();
    document.removeEventListener("visibilitychange", onHidden);
  });
</script>

<div class="phone" class:full={deciding || chat !== null || away.open || briefId !== null}>
  {#if deciding}
    <CatchUp {feed} {session} {quick} {outgoing} {verifiedFresh} {verify} onBack={stopDeciding} onDay={() => { session.finish(); stopDeciding(); }}
      onQueue={queue} onRetry={id => void outbox?.retry(id)} onDiscard={id => void outbox?.discard(id)}
      onEchoes={(worker, e) => void outbox?.echoes(worker, e)}
      onScreen={id => { stopDeciding(); openChat(id, true); }} onOpenBrief={openBrief} />
  {:else if tab === "chats"}
    <ChatList {rows} status={feed.status} {now} decisions={feed.primed ? session.count : 0} digestWaiting={!!away.pending && !away.open}
      onOpen={openChat} onDecide={() => decide()} onDigest={() => (away.open = true)} onSettings={() => (settings = true)} />
  {:else if tab === "today"}
    <Today {feed} {session} {quick} {verifiedFresh} {verify} onCatchUp={() => decide()} onDecide={id => decide({ decision: id })} onReadBrief={openBrief} />
  {:else if tab === "status"}
    <Status {rows} status={feed.status} primed={feed.primed} onOpen={openChat} />
  {:else if tab === "board"}
    <div class="phone-wide">
      <BoardView tasks={feed.board} lanes={feed.boardLanes} live={feed.boardAt !== null} {now} open={openTask} onOpen={k => (openTask = k)}
        onAct={boardAct} onCreate={boardCreate} onOpenLane={openLane} />
    </div>
  {:else}
    <div class="phone-wide">
      <HomeView accounts={feed.usage} at={feed.usageAt} live={feed.usageAt !== null} {now} onOpenLane={openLane} />
    </div>
  {/if}
  {#if !deciding}<TabBar {tab} chats={unreadChats} decisions={feed.primed ? session.count : 0} blocked={blockedTasks} onTab={go} />{/if}
  <!-- Not under the digest: an open chat there would mark itself read while he reads the digest (review, 2026-10-05). -->
  {#if chatWorker && !deciding && !away.open}
    {#key chatWorker.id}
      <Conversation {feed} worker={chatWorker} {outgoing} {pendingFiles} {now} {verifiedFresh} {verify} screen={chatScreen} onBack={closeChat} onDecide={id => decide({ decision: id })}
        onQueue={queue} onRetry={id => void again(id, "retry")} onDiscard={id => void outbox?.discard(id)}
        onAgain={id => void again(id, "again")} onCheck={id => void outbox?.check(id)} onEchoes={echoes} />
    {/key}
  {/if}
  {#if away.open && away.pending}
    <Digest since={away.pending.since} until={away.pending.until} data={digestData} workers={feed.workers} decisions={feed.decisions} muted={feed.muted}
      waiting={feed.primed ? session.count : 0} onOpen={w => { away.open = false; openChat(w); }} onDecide={() => { away.open = false; decide(); }}
      onMarkRead={markDigestRead} onLater={() => (away.open = false)} />
  {/if}
  {#if settings}<SettingsSheet setting={away.setting} {engines} onChoose={v => away.choose(v)} onClose={() => (settings = false)} />{/if}
  {#if briefItem && briefSession}
    <BriefSheet item={briefItem} {now} session={briefSession} answering={briefAnswering} note={briefNote}
      onPick={answerFromSheet} onUndo={() => session.undo()} onAskBrief={askForBrief} />
  {/if}
  <LinkedNotice linked={feed.linked} onReview={() => void goto("/devices")} onSeen={at => feed.seeLinked(at)} />
  <FleetNotice available={feed.fleetAvailable} />
</div>

<style>
  .phone-wide { flex: 1; min-width: 0; overflow: auto; }
</style>
