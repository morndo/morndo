<script lang="ts">
  // Today: Horizon, the phone's dashboard (ADR-0009, the design's dashboard A). It answers "when am I next needed?":
  // the earliest open item that needs him, or how many wait now; then a timeline where a filled dot needs him and an
  // open dot happens without him. Only times written down somewhere are shown; the rest sits under "Anytime".
  // Each row reads short (brief.ts, the owner's feedback of 2026-10-04): a title on one line, one sentence, a meta line,
  // and the rest behind More. A decision's row opens its card; a task's row has Done and Later (quick.ts), never
  // "Decide now", and his own words behind More.
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import PenLine from "@lucide/svelte/icons/pen-line";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import type { LiveFeed } from "../feed.svelte.ts";
  import type { CatchUpSession } from "../catchup/session.svelte.ts";
  import { REFUSALS, type DecisionItem } from "../desktop/decisions.ts";
  import { againLabel } from "../catchup/answer.ts";
  import { heroTime, horizon, keptForLater, timeLabel, untilLabel, type Row } from "./horizon.ts";
  import { actions, brief } from "./brief.ts";
  import { keptTasks } from "./quick.ts";
  import { renderMarkdown } from "../markdown.ts";
  import type { QuickAnswers } from "./quick.svelte.ts";

  let { feed, session, quick, verifiedFresh, verify, onCatchUp, onDecide }: {
    feed: LiveFeed; session: CatchUpSession; quick: QuickAnswers; verifiedFresh: boolean; verify: () => Promise<boolean>;
    onCatchUp: () => void; onDecide: (id: string) => void;
  } = $props();

  let now = $state(Date.now());
  $effect(() => { const t = setInterval(() => (now = Date.now()), 30_000); return () => clearInterval(t); });
  // Notices of answers the app closed on are settled by the board, once it is current (code review #2).
  $effect(() => { if (feed.primed) quick.confirm(feed.decisions); });
  const later = $derived(keptForLater(session.later, feed.decisions));
  const kept = $derived(keptTasks(quick.state, feed.decisions, now));
  const h = $derived(horizon({ decisions: feed.decisions, workers: feed.workers, later, kept, said: quick.state.sent, now }));
  const working = $derived(feed.workers.filter(w => w.state === "active").length);
  const decisions = $derived(session.cards.filter(c => c.kind === "decision").length);
  const anytime = $derived(h.anytimeTasks);
  const hm = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const STATUS = { connecting: "Connecting", live: "Live", reconnecting: "Reconnecting", offline: "Offline", ended: "Signed out" } as const;
  const agents = (n: number) => (n === 1 ? "1 agent is" : `${n} agents are`);
  const tasks = (n: number) => (n === 1 ? "1 task" : `${n} tasks`);
  // "2 decisions and 1 late task wait for you.", "1 decision waits for you.", "1 task is past its time."
  function waitsFor(decisions: number, late: number): string {
    const dec = decisions === 1 ? "1 decision" : `${decisions} decisions`;
    if (!late) return `${dec} ${decisions === 1 ? "waits" : "wait"} for you.`;
    if (!decisions) return late === 1 ? "1 task is past its time." : `${late} tasks are past their time.`;
    return `${dec} and ${late === 1 ? "1 late task" : `${late} late tasks`} wait for you.`;
  }
  const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  // Per row: More open, his own words being written, and a note when an answer couldn't start.
  let more = $state<Record<string, boolean>>({});
  let writing = $state<Record<string, boolean>>({});
  let words = $state<Record<string, string>>({});
  let note = $state<Record<string, string>>({});

  // A task's answer: the passkey check first when his setting asks for one, then the 5-second window (quick.ts).
  // Why the hub would refuse an answer now (its list unreadable, say), in its words; null when it can be answered.
  const paused = (d: DecisionItem) => (d.answerable === null ? null : REFUSALS[d.answerable] ?? d.answerable);
  async function answer(d: DecisionItem, body: { key: string } | { text: string }, label: string) {
    note = { ...note, [d.id]: "" };
    if (paused(d)) return false;                                     // the hub would refuse it: nothing starts
    // After a refusal for the passkey check, the check comes first whatever this page thinks is fresh (code review #3).
    const stale = quick.state.failed[d.id]?.code === "step_up";
    if ((!verifiedFresh || stale) && !(await verify())) { note = { ...note, [d.id]: "Not sent: the passkey check didn't finish." }; return false; }
    quick.answer(d.id, body, label, d.version);
    return true;
  }
  // "Confirm with passkey and send": the check, then the same answer again, with its 5-second window.
  async function confirmAndSend(d: DecisionItem) {
    const a = quick.state.failed[d.id]?.again;
    if (!a) return;
    if (!(await verify())) { note = { ...note, [d.id]: "Not sent: the passkey check didn't finish." }; return; }
    note = { ...note, [d.id]: "" };
    quick.answer(a.id, a.body, a.label, a.seen, a.requestId);              // the same request id: typed at most once
  }
  async function sendWords(d: DecisionItem) {
    const t = (words[d.id] ?? "").trim();
    if (t && await answer(d, { text: t }, "your own words")) { writing = { ...writing, [d.id]: false }; words = { ...words, [d.id]: "" }; }
  }
  // What a row says under its title when the item itself has a note to add: kept for later, or a prompt on a screen.
  function aside(d: DecisionItem): string | null {
    if (later.has(d.id)) return d.blocking ? "You kept this for later, but it blocks work until you answer." : "You kept this for later.";
    if (d.answerBy === "screen") return `${d.asker.kind === "manager" ? "The manager" : d.asker.name} waits at a prompt on its own screen.`;
    return null;
  }
</script>

{#snippet row(r: Row)}
  {@const d = r.item?.status === "open" ? r.item : null}
  {@const b = d ? brief(d, now) : null}
  {@const acts = d ? actions(d, "row") : []}
  {@const pending = d ? quick.state.pending[d.id] : undefined}
  {@const failed = d ? quick.state.failed[d.id] : undefined}
  {@const isKept = d ? kept.has(d.id) : false}
  {@const ownWords = acts.some(a => a.kind === "words") && !isKept}
  {@const said = d?.context && d.contextKind === "markdown" ? d.context : null}
  {@const hasMore = !!b && (!!b.more.text || !!said || !!b.more.link || !!b.more.ifNoAnswer || !!b.more.recommendation || ownWords)}
  <li class="ev" class:you={r.needsYou} data-row={r.key} data-needs={r.needsYou ? "you" : "without-you"} data-kind={d ? (d.need === "time" ? "task" : "decision") : r.item ? "answered" : "agent"}>
    {#if r.at === null}
      <span class="time ready" aria-hidden="true"></span>
    {:else}
      {@const l = timeLabel(r.at, now)}
      <time class="time" class:over={r.needsYou && r.at <= now} datetime={new Date(r.at).toISOString()}>{l.big}{#if l.small}<small>{l.small}</small>{/if}</time>
    {/if}
    <i class="mk" class:you={r.needsYou} class:open={r.at === null && !r.needsYou}></i>
    <span class="sr">{r.needsYou ? "Needs you." : "Happens without you."}</span>
    <b class="t" title={r.title}>{r.title}</b>
    {#if d && b}
      {#if b.sentence}<p class="s">{b.sentence}</p>{/if}
      {#if aside(d)}<p class="s note">{aside(d)}</p>{/if}
      {#if b.meta.length}<p class="meta">{sentenceCase(b.meta.join(" · "))}</p>{/if}
    {:else}
      <p class="s">{r.detail}</p>
    {/if}

    {#if d && pending}
      <div class="state" role="status">
        <span>{pending.sending ? `Sending “${pending.label}”…` : `“${pending.label}” goes in ${Math.max(1, Math.ceil((pending.commitAt - quick.now) / 1000))} s.`}</span>
        {#if !pending.sending}<button class="pbtn small" onclick={() => quick.undo(d.id)}>Undo</button>{/if}
      </div>
    {:else if d}
      {#if failed}<p class="err" role="alert">{failed.text}</p>{/if}
      {#if note[d.id]}<p class="err" role="alert">{note[d.id]}</p>{/if}
      {#if paused(d)}<p class="note paused">{paused(d)}</p>{/if}
      <div class="acts">
        {#if failed?.retry}<button class="pbtn small primary" onclick={() => quick.retry(d.id)}>{againLabel(failed.code)}</button>{/if}
        {#if failed?.again}<button class="pbtn small primary" onclick={() => void confirmAndSend(d)}><ShieldAlert size={16} />Confirm with passkey and send</button>{/if}
        {#if isKept}
          <button class="pbtn small" onclick={() => quick.back(d.id)}>Bring back</button>
        {:else}
          {#each acts as a (a.kind === "option" ? `o:${a.key}` : a.kind)}
            {#if a.kind === "decide"}<button class="pbtn small primary" onclick={() => onDecide(d.id)}>Decide now</button>
            {:else if a.kind === "done"}<button class="pbtn small primary" disabled={!!paused(d)} onclick={() => void answer(d, { text: "Done" }, "Done")}>Done</button>
            {:else if a.kind === "later"}<button class="pbtn small" onclick={() => quick.later(d.id, d.version)}>Later</button>
            {:else if a.kind === "option"}<button class="pbtn small opt" class:primary={a.recommended} disabled={!!paused(d)} onclick={() => void answer(d, { key: a.key }, a.label)}>{a.label}</button>
            {/if}
          {/each}
        {/if}
        {#if hasMore}
          <button class="pbtn small ghost" aria-expanded={!!more[r.key]} onclick={() => (more = { ...more, [r.key]: !more[r.key] })}>
            {more[r.key] ? "Less" : "More"}<span class="caret" class:up={more[r.key]}><ChevronDown size={16} /></span>
          </button>
        {/if}
      </div>
      {#if hasMore && more[r.key] && b}
        <div class="more">
          {#if b.more.text}<p class="long">{b.more.text}</p>{/if}
          <!-- The manager's message that asked it (untrusted text): rendered and sanitized, as on the decision card. -->
          {#if said}<div class="md ctx">{@html renderMarkdown(said)}</div>{/if}
          {#if b.more.recommendation}<p><b>Recommended:</b> {b.more.recommendation}</p>{/if}
          {#if b.more.ifNoAnswer}<p><b>{d.need === "time" ? "If you don't get to it:" : "If you don't answer:"}</b> {b.more.ifNoAnswer.replace(/\.?$/, ".")}</p>{/if}
          {#if b.more.link}<a class="pbtn small link" href={b.more.link} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} />Open the link</a>{/if}
          {#if ownWords}
            {#if writing[d.id]}
              <label class="sr" for="w-{d.id}">Your answer about {b.title}</label>
              <textarea id="w-{d.id}" rows="3" placeholder="Your answer for the manager…" bind:value={words[d.id]}></textarea>
              <div class="acts">
                <button class="pbtn small primary" disabled={!(words[d.id] ?? "").trim() || !!paused(d)} onclick={() => void sendWords(d)}>Send to the manager</button>
                <button class="pbtn small" onclick={() => (writing = { ...writing, [d.id]: false })}>Cancel</button>
              </div>
            {:else}
              <button class="pbtn words" disabled={!!paused(d)} onclick={() => (writing = { ...writing, [d.id]: true })}><PenLine size={18} />Answer in my own words</button>
            {/if}
          {/if}
        </div>
      {/if}
    {/if}
  </li>
{/snippet}

<header class="top">
  <svg class="mark" viewBox="0 0 48 48" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M0 0L48 0L48 48L0 48ZM8 26A16 16 0 0 1 40 26A16 16 0 0 1 8 26ZM0 27L48 27L48 33L0 33Z" /></svg>
  <b>morndo</b>
  <span class="conn {feed.status}" role="status"><i></i>{STATUS[feed.status]}</span>
  <a class="more-link" href="/devices" aria-label="Devices and sign out">⋯</a>
</header>

<main class="scroll">
  {#if feed.primed && session.count > 0}
    <button class="pbtn primary catch" onclick={onCatchUp}>
      <span>Decide · {session.count}</span>
      <small>{decisions ? `${decisions} ${decisions === 1 ? "decision waits" : "decisions wait"} for you` : "nothing to decide"}</small>
    </button>
  {/if}

  <section class="hero" aria-live="polite">
    {#if !feed.primed}
      <!-- No claim from what this page knew before: only the hub's current word says what needs him (review, 14). -->
      <p class="kicker">{feed.status === "offline" ? "Offline" : "Connecting"}</p>
      <p class="say">Waiting for the hub to say what needs you.{#if feed.caughtUpAt}{" "}You last caught up at {hm(feed.caughtUpAt)}.{/if}</p>
    {:else if h.waitingNow > 0}
      <p class="kicker">Needs you now</p>
      <p class="big num" data-waiting={h.waitingNow}>{h.waitingNow}<small>waiting now</small></p>
      <p class="say">{waitsFor(h.waitingDecisions, h.waitingTasks)}{" "}{#if working}<b>{agents(working)} working</b> meanwhile.{/if}</p>
    {:else if h.next}
      <p class="kicker">Nothing needs you until</p>
      <p class="big num"><time datetime={new Date(h.next.at ?? now).toISOString()} data-row={h.next.key}>{heroTime(h.next.at ?? now, now)}</time><small>{untilLabel(h.next.at ?? now, now)}</small></p>
      <p class="say">Then: <b>{h.next.title}</b>.{" "}{#if anytime}{tasks(anytime)} you can do anytime.{" "}{/if}{#if working}<b>{agents(working)} working</b> without you.{/if}</p>
    {:else}
      <p class="kicker">Nothing urgent</p>
      <p class="say">{#if anytime}{tasks(anytime)} you can do anytime; none has a time set.{:else}Nothing has a time set.{/if}{" "}{#if working}<b>{agents(working)} working</b> without you.{/if}</p>
    {/if}
    {#if feed.primed && feed.caughtUpAt}<p class="note">Caught up at {hm(feed.caughtUpAt)}{new Date(feed.caughtUpAt).toDateString() === new Date(now).toDateString() ? "" : `, ${new Date(feed.caughtUpAt).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}`}.</p>{/if}
  </section>

  <div class="legend"><span><i class="mk you"></i>Needs you</span><span><i class="mk"></i>Happens without you</span></div>

  {#if !feed.primed && (h.past.length || h.whenReady.length || h.coming.length)}<p class="note stale">As last known; it may have changed since.</p>{/if}
  <ol class="tl" aria-label="Your day">
    {#each h.past as r (r.key)}{@render row(r)}{/each}
    <li class="nowline" aria-label="Now"><i>NOW</i></li>
    {#if h.whenReady.length}<li class="sect"><i>Anytime</i></li>{/if}
    {#each h.whenReady as r (r.key)}{@render row(r)}{/each}
    {#if h.coming.length}<li class="sect"><i>Coming up</i></li>{/if}
    {#each h.coming as r (r.key)}{@render row(r)}{/each}
    {#if h.kept.length}<li class="sect"><i>Kept for later today</i></li>{/if}
    {#each h.kept as r (r.key)}{@render row(r)}{/each}
    {#if !h.past.length && !h.whenReady.length && !h.coming.length && !h.kept.length}
      <li class="empty note">{feed.primed ? "Nothing is planned, and no agent is working." : "Waiting for the hub…"}</li>
    {/if}
  </ol>
</main>

<style>
  /* The bar stays at the top and covers the status bar's area in the installed app (black-translucent draws the page
     under it): the owner's screenshot of 2026-10-04 showed the headline under the clock. */
  .top {
    position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 10px; background: var(--bg);
    padding: calc(var(--safe-top) + 10px) max(20px, var(--safe-right)) 8px max(20px, var(--safe-left));
    border-bottom: 1px solid transparent;
  }
  .mark { width: 26px; height: 26px; color: var(--ink); flex: none; }
  .top b { flex: 1; font: 600 19px/1 var(--display); letter-spacing: 0.02em; }
  .more-link { display: inline-grid; place-items: center; width: 44px; height: 44px; margin-right: -10px; border-radius: 12px; color: var(--fg); text-decoration: none; font-size: 1.4rem; }
  .scroll { flex: 1; padding: 0 max(20px, var(--safe-right)) 24px max(20px, var(--safe-left)); }
  .catch { width: 100%; margin-top: 10px; display: grid; gap: 4px; padding: 10px 18px; }
  .catch span { font: 600 18px/1.1 var(--display); }
  .catch small { font: 400 13px/1.2 var(--body); }
  .hero { padding: 16px 0 14px; }
  .big { font: 600 64px/66px var(--display); letter-spacing: -0.04em; margin: 4px 0 6px; overflow-wrap: anywhere; }
  .big small { font: 500 20px/1 var(--display); letter-spacing: 0; color: var(--muted); margin-left: 8px; }
  .say { font: 400 16px/23px var(--body); color: var(--muted); margin: 0 0 6px; }
  .say b { color: var(--fg); }
  .legend { display: flex; gap: 16px; padding: 10px 0 12px; border-top: 1px solid var(--line); font: 400 13px/16px var(--body); color: var(--muted); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .mk { width: 11px; height: 11px; border-radius: 50%; flex: none; display: inline-block; border: 1.5px solid var(--edge); background: var(--bg); }
  .mk.you { background: var(--ink); border-color: var(--ink); }
  .mk.open { border-style: dashed; }
  .tl { list-style: none; margin: 0; padding: 0 0 0 60px; position: relative; }
  .tl::before { content: ""; position: absolute; left: 49px; top: 6px; bottom: 0; width: 1px; background: var(--line); }
  .ev { position: relative; display: grid; justify-items: start; min-width: 0; padding: 0 0 20px; }
  .time { position: absolute; left: -60px; top: 0; width: 40px; text-align: right; font: 600 14px/20px var(--display); font-feature-settings: "tnum"; color: var(--fg); }
  .time small { display: block; font: 400 11px/13px var(--body); color: var(--muted); }
  .time.ready { height: 0; }
  .time.over { color: var(--bad-text); }
  .ev .mk { position: absolute; left: -16px; top: 5px; box-shadow: 0 0 0 4px var(--bg); }
  .t { max-width: 100%; font: 700 17px/22px var(--body); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ev:not(.you) .t { font-size: 15px; font-weight: 600; }
  .s { margin: 2px 0 0; font: 400 15px/21px var(--body); color: var(--fg); }
  .ev:not(.you) .s, .s.note { color: var(--muted); font-size: 14px; line-height: 19px; }
  .meta { margin: 3px 0 0; font: 400 13px/18px var(--body); color: var(--muted); }
  .acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 9px; }
  .acts .opt { max-width: 100%; text-align: left; }
  .acts .pbtn.ghost { border-color: transparent; padding: 0 8px; gap: 4px; }
  .caret { display: inline-flex; transition: transform 150ms; }
  .caret.up { transform: rotate(180deg); }
  @media (prefers-reduced-motion: reduce) { .caret { transition: none; } }
  .state { display: flex; align-items: center; gap: 10px; margin-top: 9px; padding: 6px 6px 6px 12px; border-radius: 12px; background: var(--fill); font: 400 14px/19px var(--body); }
  .state span { flex: 1; }
  .err { margin-top: 8px; }
  .paused { margin-top: 6px; }
  .more { width: 100%; margin-top: 8px; padding: 10px 0 0; border-top: 1px solid var(--line); display: grid; gap: 8px; justify-items: start; font: 400 14px/20px var(--body); }
  .more p { margin: 0; overflow-wrap: anywhere; }
  .more .long { white-space: pre-wrap; }
  .ctx { width: 100%; overflow-wrap: anywhere; }
  .ctx :global(p) { margin: 0 0 6px; }
  .ctx :global(ul), .ctx :global(ol) { margin: 2px 0 6px; padding-left: 20px; }
  .link { gap: 6px; }
  .words { width: 100%; min-height: 48px; font-size: 15px; }
  textarea { width: 100%; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--edge); background: var(--surface); color: var(--fg); font: 400 15px/21px var(--body); resize: vertical; }
  textarea::placeholder { color: var(--morndo-placeholder); }
  .nowline { display: flex; align-items: center; gap: 10px; margin: 0 0 13px -60px; font: 700 11px/1 var(--body); letter-spacing: 0.09em; color: var(--ok-text); }
  .nowline::after { content: ""; flex: 1; height: 1px; background: var(--ok); }
  .nowline i { width: 40px; text-align: right; font-style: normal; }
  .sect { margin: 2px 0 12px; font: 700 12px/16px var(--body); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
  .sect i { font-style: normal; }
  .empty { margin-left: -60px; padding: 8px 0; }
</style>
