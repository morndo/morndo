<script lang="ts">
  // The state gallery (ADR-0008 phase G; design reference: Signal's Storybook): the desktop's key components in every
  // state, with synthetic data, in the light or the dark theme. Dev only: the route imports this file only under
  // import.meta.env.DEV, and the build check fails if its marker is in a production build.
  import { onMount } from "svelte";
  import type { ConnState } from "../feed.svelte.ts";
  import DecisionCard, { type AnswerProblem } from "../desktop/DecisionCard.svelte";
  import MessageList from "../desktop/MessageList.svelte";
  import Sidebar from "../desktop/Sidebar.svelte";
  import TopNav from "../desktop/TopNav.svelte";
  import "../desktop/desk-tokens.css";
  import { REFUSALS } from "../desktop/decisions.ts";
  import { conversation, decisions, roster, sends } from "./data.ts";

  const now = Date.now();
  const r = roster(now);
  const chat = conversation(now);
  const search = r.workers.find(w => w.name === "search") ?? r.workers[0]!;
  const STATES: ConnState[] = ["connecting", "live", "reconnecting", "offline", "ended"];
  const noop = () => {};
  // Answering is the card's own state, reached by clicking: an answer that never comes back stays Sending…, and one
  // the hub refuses says why.
  const soon = decisions(now)[2]!.item;
  const answering: { label: string; answer: () => Promise<AnswerProblem | null> }[] = [
    { label: "Pick an option: the confirmation", answer: async () => null },
    { label: "Something else…: the answer in words", answer: async () => null },
    { label: "Pick, then Send answer: sending", answer: () => new Promise<AnswerProblem | null>(() => {}) },
    { label: "Pick, then Send answer: refused", answer: async () => ({ code: "busy", text: REFUSALS.busy ?? "busy" }) },
    { label: "Pick, then Send answer: may have been sent, Check again", answer: async () => ({ code: "uncertain", text: REFUSALS.uncertain ?? "uncertain" }) },
  ];
  const answeringCards = answering.map((a, i) => ({ ...a, item: { ...soon, id: `${soon.id}-${i}` as typeof soon.id } }));

  type Theme = "light" | "dark";
  let theme = $state<Theme>("light");
  function setTheme(t: Theme) {
    theme = t;
    document.documentElement.dataset.theme = t;
    const u = new URL(location.href);
    u.searchParams.set("theme", t);
    history.replaceState(history.state, "", u);
  }
  onMount(() => {
    setTheme(new URL(location.href).searchParams.get("theme") === "dark" ? "dark" : "light");
    return () => { delete document.documentElement.dataset.theme; };
  });
</script>

{#snippet noCard()}{/snippet}

<div class="gallery desk-tokens" data-morndo-gallery>
  <header>
    <h1>State gallery</h1>
    <p>Development only: never in a production build. Synthetic data.</p>
    <div class="themes" role="group" aria-label="Theme">
      <button aria-pressed={theme === "light"} onclick={() => setTheme("light")}>Light</button>
      <button aria-pressed={theme === "dark"} onclick={() => setTheme("dark")}>Dark</button>
    </div>
  </header>

  <section data-shot="pills">
    <h2>Status pills</h2>
    {#each STATES as status (status)}
      <div class="bar"><TopNav office="Demo office" sidebarWidth={260} workers={r.workers} {status} onPick={noop} /></div>
    {/each}
  </section>

  <section data-shot="sidebar">
    <h2>Sidebar rows: needs you, unread, muted, selected, starred, working, idle, offline</h2>
    <div class="side">
      <Sidebar office="Demo office" workers={r.workers} manager={r.manager} selected={r.selected} view="home" unread={r.unread}
        needsYouCount={1} decisions={3} decisionsOpen={false} prefsOf={r.prefsOf} onMenu={noop} onSelect={noop}
        onActivity={noop} onDecisions={noop} onCompose={noop} />
    </div>
  </section>

  <section data-shot="sends">
    <h2>Message rows in every send state</h2>
    <div class="frame tall">
      <MessageList worker={search} messages={chat.messages.slice(-2)} loading={false} outgoing={sends(now)} displayName="search"
        prefs={r.prefsOf("search")} decisionOf={() => undefined} card={noCard} focus={null}
        onRetry={noop} onDiscard={noop} onVerify={noop} onEdit={noop} dividerMark={null} />
    </div>
  </section>

  <section data-shot="divider">
    <h2>The "New messages" divider, and the jump button with what arrived while away</h2>
    <div class="frame">
      <MessageList worker={search} messages={chat.messages} loading={false} outgoing={[]} displayName="search"
        prefs={r.prefsOf("search")} decisionOf={() => undefined} card={noCard} focus={null}
        onRetry={noop} onDiscard={noop} onVerify={noop} onEdit={noop} dividerMark={chat.readUpTo} detached={true} newWhileDetached={3} />
    </div>
  </section>

  <section data-shot="decisions">
    <h2>Decision cards</h2>
    <div class="cards">
      {#each decisions(now) as d (d.item.id)}
        <figure>
          <figcaption>{d.label}</figcaption>
          <DecisionCard item={d.item} variant="panel" {now} verifiedFresh={d.label !== "Due soon"} onAnswer={async () => null} onOpenScreen={noop} />
        </figure>
      {/each}
      <figure>
        <figcaption>In the chat (inline)</figcaption>
        <DecisionCard item={decisions(now)[0]!.item} variant="inline" {now} verifiedFresh={true} onAnswer={async () => null} onOpenScreen={noop} />
      </figure>
    </div>
  </section>

  <section data-shot="answering">
    <h2>Answering a decision (click as the caption says)</h2>
    <div class="cards">
      {#each answeringCards as a, i (a.label)}
        <figure data-answering={i}>
          <figcaption>{a.label}</figcaption>
          <DecisionCard item={a.item} variant="panel" {now} verifiedFresh={true} onAnswer={a.answer} onOpenScreen={noop} />
        </figure>
      {/each}
    </div>
  </section>
</div>

<style>
  .gallery { min-height: 100vh; background: var(--main-bg); color: var(--text); font: 400 15px/22px var(--font); padding: 24px; display: grid; gap: 32px; }
  header { display: grid; gap: 4px; }
  h1 { margin: 0; font-size: 22px; }
  h2 { margin: 0 0 12px; font-size: 16px; }
  header p { margin: 0; color: var(--muted); }
  .themes { display: flex; gap: 8px; margin-top: 8px; }
  .themes button { padding: 4px 12px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--main-bg); color: var(--text); cursor: pointer; }
  .themes button[aria-pressed="true"] { background: var(--selected); border-color: var(--selected-bar); }
  .bar { height: 40px; background: var(--frame); margin-bottom: 8px; display: grid; grid-template-rows: 40px; }
  .side { width: 260px; height: 560px; display: flex; border: 1px solid var(--border); background: var(--sidebar-bg); }
  .frame { height: 620px; max-width: 900px; display: flex; flex-direction: column; border: 1px solid var(--border); background: var(--main-bg); position: relative; }
  .frame.tall { height: 1700px; }                      /* every send state on screen at once, none scrolled away */
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; align-items: start; }
  figure { margin: 0; display: grid; gap: 6px; }
  figcaption { font-size: 13px; color: var(--muted); }
</style>
