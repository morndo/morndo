<script lang="ts">
  // Home (ADR-0016): the principal's dashboard. For now one thing on it: how much of every connected account is used,
  // as the agents' status lines report it. A KPI row (accounts, sessions reporting, the account nearest its 5-hour
  // and its weekly limit), then one card per account with a meter per window (the fill carries the level, the words
  // and an icon say it too), its spend where a gateway sets one, and the sessions on it right now.
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import House from "@lucide/svelte/icons/house";
  import Radio from "@lucide/svelte/icons/radio";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Users from "@lucide/svelte/icons/users";
  import Avatar from "./Avatar.svelte";
  import { LEVEL_WORDS, accountLabel, ago, onDemandLine, pct, resetsIn, resetsOnLabel, shownLevel, tightestShown, usageLevel, usd, type AccountUsage, type UsageWindow } from "./usage.ts";

  let { accounts, at, now, live, onOpenLane }: { accounts: AccountUsage[]; at: number | null; now: number; live: boolean; onOpenLane: (name: string) => void } = $props();

  const sessions = $derived(accounts.reduce((n, a) => n + a.sessions.length, 0));
  const five = $derived(tightestShown(accounts, "fiveHour"));
  const week = $derived(tightestShown(accounts, "sevenDay"));
  const headline = $derived(shownLevel(accounts));
  // The label's tail (" · email · Team · plan") beside the name on the card; nothing when there is no profile.
  const identOf = (a: AccountUsage) => { const label = accountLabel(a); return label === a.account ? "" : label.slice(a.account.length); };
  // A headline tile names its account; with a profile, the label says which subscription that is.
  const labelOf = (name: string) => accountLabel(accounts.find(a => a.account === name) ?? { account: name });
</script>

{#snippet meter(label: string, w: UsageWindow | null, when: string | null)}
  {#if w}
    {@const level = usageLevel(w.usedPercentage)}
    <div class="meter l-{level}" role="group" aria-label="{label}: {pct(w.usedPercentage)} used, {LEVEL_WORDS[level]}">
      <div class="mh"><span class="ml">{label}</span><span class="mv">{pct(w.usedPercentage)} <small>used</small></span></div>
      <div class="track" aria-hidden="true"><div class="fill" style:width="{Math.max(1, Math.min(100, w.usedPercentage))}%"></div></div>
      <div class="mf">
        <span class="lvl">{#if level === "ok"}<CircleCheck size={13} />{:else if level === "warning"}<TriangleAlert size={13} />{:else}<CircleAlert size={13} />{/if}{LEVEL_WORDS[level]}</span>
        {#if when}<span class="reset">{when}</span>{:else if resetsIn(w.resetsAt, now)}<span class="reset">{resetsIn(w.resetsAt, now)}</span>{/if}
      </div>
    </div>
  {:else}
    <div class="meter none" role="group" aria-label="{label}: not reported">
      <div class="mh"><span class="ml">{label}</span><span class="mv muted">not reported</span></div>
      <div class="track" aria-hidden="true"></div>
      <div class="mf"><span class="reset">No window yet: it appears after a session's first reply.</span></div>
    </div>
  {/if}
{/snippet}

<section class="home">
  <header class="hh"><House size={18} /><h1>Home</h1>{#if at}<span class="upd">Usage as of {ago(at, now)}</span>{/if}</header>
  <div class="body">
    <h2>Usage across accounts</h2>
    {#if !live}
      <div class="warn-bar" role="status"><TriangleAlert size={16} /><span>The hub hasn't sent the accounts yet.</span></div>
    {/if}
    <div class="kpis" aria-label="Usage at a glance">
      <div class="tile"><span class="tl"><Users size={14} />Accounts</span><b>{accounts.length}</b><span class="ts">{accounts.length === 1 ? "connected" : "connected"}</span></div>
      <div class="tile"><span class="tl"><Radio size={14} />Sessions reporting</span><b>{sessions}</b><span class="ts">in the last 10 minutes</span></div>
      <div class="tile l-{five ? usageLevel(five.window.usedPercentage) : 'none'}">
        <span class="tl">Tightest 5-hour window</span>
        {#if five}<b>{pct(five.window.usedPercentage)}</b><span class="ts">{labelOf(five.account)}{resetsIn(five.window.resetsAt, now) ? ` · ${resetsIn(five.window.resetsAt, now)}` : ""}</span>{:else}<b class="muted">–</b><span class="ts">nobody reports one</span>{/if}
      </div>
      <div class="tile l-{week ? usageLevel(week.window.usedPercentage) : 'none'}">
        <span class="tl">Tightest weekly window</span>
        {#if week}<b>{pct(week.window.usedPercentage)}</b><span class="ts">{labelOf(week.account)}{resetsIn(week.window.resetsAt, now) ? ` · ${resetsIn(week.window.resetsAt, now)}` : ""}</span>{:else}<b class="muted">–</b><span class="ts">nobody reports one</span>{/if}
      </div>
    </div>
    {#if headline !== "ok"}
      <p class="note l-{headline}" role="status">{#if headline === "critical"}<CircleAlert size={15} />An account is nearly out of its window. Lanes on it will stop until it resets.{:else}<TriangleAlert size={15} />An account is running low on a window.{/if}</p>
    {/if}

    {#if accounts.length === 0}
      <div class="empty">
        <h3>No account reports yet</h3>
        <p>Usage comes from each session's status line. Have the lanes post it to the hub with their agent token: <code>docs/agents/usage.md</code> has the three lines.</p>
      </div>
    {:else}
      <div class="cards">
        {#each accounts as a (a.account)}
          <article class="card" data-account={a.account} aria-label="Account {accountLabel(a)}">
            <header><Avatar name={a.account} kind="agent" size={28} /><h3>{a.account}</h3>{#if identOf(a)}<span class="ident">{identOf(a)}</span>{/if}<span class="when">reported {ago(a.reportedAt, now)}</span></header>
            {#if a.limits?.length}
              {#each a.limits as w, i (`${w.label}:${i}`)}
                {@render meter(w.label, w, resetsOnLabel(w.resetsOn))}
              {/each}
              {#if onDemandLine(a.onDemand)}<p class="ondemand">{onDemandLine(a.onDemand)}</p>{/if}
            {:else}
            {@render meter("5-hour window", a.fiveHour, null)}
            {@render meter("Weekly window", a.sevenDay, null)}
            {/if}
            {#if a.spend}
              {@render meter(`Spend limit${a.spend.period ? ` (${a.spend.period})` : ""}`, a.spend, null)}
              {#if a.spend.usedUsd !== null}<p class="spend">{usd(a.spend.usedUsd)}{a.spend.limitUsd !== null ? ` of ${usd(a.spend.limitUsd)}` : ""}</p>{/if}
            {/if}
            <div class="sessions">
              <span class="sl">{a.sessions.length ? `${a.sessions.length} session${a.sessions.length === 1 ? "" : "s"} reporting` : "No session reporting right now"}</span>
              {#each a.sessions as s (s.sessionId)}
                <button class="sess" onclick={() => s.lane && onOpenLane(s.lane)} disabled={!s.lane} title={s.lane ? `Open #${s.lane}` : "A session without a lane name"}>
                  <span class="lane">{s.lane ? `#${s.lane}` : "unnamed"}</span>
                  {#if s.model}<span class="model">{s.model}</span>{/if}
                  {#if s.contextUsed !== null}<span class="ctx">{pct(s.contextUsed)} context</span>{/if}
                </button>
              {/each}
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </div>
</section>

<style>
  .home { display: flex; flex-direction: column; min-width: 0; min-height: 0; flex: 1; background: var(--main-bg); }
  .hh { height: 49px; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 18px; border-bottom: 1px solid var(--border); flex: none; }
  h1 { margin: 0; font: 900 18px/24px var(--font); }
  .upd { margin-left: auto; font: 400 12px/18px var(--font); color: var(--muted); }
  .body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 20px 32px; background: var(--sidebar-bg); }
  h2 { margin: 0 0 12px; font: 700 15px/22px var(--font); }
  .warn-bar { display: flex; gap: 8px; align-items: center; padding: 8px 12px; margin-bottom: 12px; border-radius: 8px; background: var(--warn-bg); color: var(--warn-fg); font: 400 13px/18px var(--font); }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
  .tile { display: grid; gap: 2px; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--main-bg); }
  .tl { display: inline-flex; align-items: center; gap: 6px; font: 700 12px/16px var(--font); color: var(--muted); }
  .tile b { font: 600 30px/36px var(--font); color: var(--text); }       /* proportional figures on a standalone value */
  .tile b.muted { color: var(--muted); }
  .ts { font: 400 12px/16px var(--font); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tile.l-warning b { color: var(--warn-fg); }
  .tile.l-critical b { color: var(--bad-fg); }
  .note { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; padding: 8px 12px; border-radius: 8px; font: 400 13px/18px var(--font); }
  .note.l-warning { background: var(--warn-bg); color: var(--warn-fg); }
  .note.l-critical { background: var(--bad-bg); color: var(--bad-fg); }
  .empty { margin-top: 16px; padding: 24px; border-radius: 10px; border: 1px dashed var(--border-strong); background: var(--main-bg); }
  .empty h3 { margin: 0 0 6px; font: 900 16px/22px var(--font); }
  .empty p { margin: 0; font: 400 14px/20px var(--font); color: var(--muted); max-width: 60ch; }
  .empty code { font: 400 13px/18px var(--mono); background: var(--code-bg); padding: 0 4px; border-radius: 4px; color: var(--text); }
  .cards { margin-top: 16px; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
  .card { display: grid; gap: 12px; padding: 14px 16px 16px; border-radius: 10px; border: 1px solid var(--border); background: var(--main-bg); }
  .card header { display: flex; align-items: center; gap: 10px; }
  .card h3 { margin: 0; font: 900 16px/22px var(--font); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The email, organization and plan beside the name; it may wrap on a phone, so it never widens the card. */
  .ident { min-width: 0; font: 400 13px/18px var(--font); color: var(--muted); overflow-wrap: anywhere; }
  .when { margin-left: auto; font: 400 12px/16px var(--font); color: var(--muted); white-space: nowrap; }
  /* The meter: a thin track in a lighter step of the same ramp; the fill carries the level, which the words and the
     icon below it say as well (never colour alone). */
  .meter { --fill: var(--morndo-ink); --track: var(--morndo-fill); display: grid; gap: 4px; }
  .meter.l-warning { --fill: var(--morndo-warning); --track: var(--morndo-warning-subtle); }
  .meter.l-critical { --fill: var(--morndo-danger); --track: var(--morndo-danger-subtle); }
  .mh { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .ml { font: 700 13px/18px var(--font); }
  .mv { font: 600 15px/18px var(--font); }
  .mv small { font: 400 12px/18px var(--font); color: var(--muted); }
  .mv.muted { font: 400 13px/18px var(--font); color: var(--muted); }
  .track { height: 8px; border-radius: 4px; background: var(--track); overflow: hidden; }
  .fill { height: 100%; border-radius: 4px; background: var(--fill); transition: width 0.3s; }
  .mf { display: flex; justify-content: space-between; gap: 8px; font: 400 12px/16px var(--font); color: var(--muted); }
  .lvl { display: inline-flex; align-items: center; gap: 4px; color: var(--text); }
  .l-warning .lvl { color: var(--warn-fg); }
  .l-critical .lvl { color: var(--bad-fg); }
  .spend { margin: -6px 0 0; font: 400 13px/18px var(--font); color: var(--muted); }
  .ondemand { margin: 0; font: 400 13px/18px var(--font); color: var(--muted); }
  .sessions { display: grid; gap: 4px; padding-top: 8px; border-top: 1px solid var(--border); }
  .sl { font: 700 12px/16px var(--font); color: var(--muted); margin-bottom: 2px; }
  .sess { display: flex; align-items: center; gap: 10px; padding: 4px 6px; margin: 0 -6px; border: 0; border-radius: 6px; background: transparent; color: var(--text); font: 400 13px/18px var(--font); text-align: left; cursor: pointer; }
  .sess:hover:not(:disabled) { background: var(--hover); }
  .sess:disabled { cursor: default; }
  .lane { font-weight: 700; }
  .model { color: var(--muted); }
  .ctx { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }
</style>
