<script lang="ts">
  // Home (ADR-0016): the principal's dashboard. For now one thing on it: how much of every connected account is used,
  // as the agents' status lines report it. A KPI row (accounts, sessions reporting, the account nearest its 5-hour
  // and its weekly limit), then one card per account with a meter per window (the fill carries the level, the words
  // and an icon say it too), its spend where a gateway sets one, and the sessions on it right now.
  // S4 (plan 4.4): the card also says where its numbers come from — the state of the account's sources, a window's
  // title from its cadence, the account's seat, disagreements between sources, the hub's own notices, and the
  // principal's own acts (forget a source, clear a seat mark).
  import Armchair from "@lucide/svelte/icons/armchair";
  import Bell from "@lucide/svelte/icons/bell";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import CircleSlash from "@lucide/svelte/icons/circle-slash";
  import Clock from "@lucide/svelte/icons/clock";
  import House from "@lucide/svelte/icons/house";
  import Radio from "@lucide/svelte/icons/radio";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Users from "@lucide/svelte/icons/users";
  import Avatar from "./Avatar.svelte";
  import { LEVEL_WORDS, REASON_WORDS, accountHealth, accountLabel, ago, clockOf, fixWords, onDemandLine, pct, resetsIn, resetsOnLabel, seatLine, shownLevel, sourceLine, tightestShown, usageLevel, usd, type AccountUsage, type UsageNotice, type UsageWindow } from "./usage.ts";
  import type { UsageCommandResult } from "../usage-api.ts";

  // The principal's own acts on a card: the handler runs the command (the real one is usage-api's, never throwing);
  // its answer, when it gives one, is what the card shows of a failure.
  type Act = void | UsageCommandResult | Promise<void | UsageCommandResult>;

  // S4 (plan 4.4): the hub's own notices (from the feed), and those acts. Defaults, so a caller that has none of it
  // still renders.
  let {
    accounts, at, now, live, onOpenLane,
    notices = [],
    onForget = () => {},
    onClearSeat = () => {},
  }: {
    accounts: AccountUsage[]; at: number | null; now: number; live: boolean; onOpenLane: (name: string) => void;
    notices?: UsageNotice[];
    onForget?: (account: string, source: string, node: string | null) => Act;
    onClearSeat?: (account: string) => Act;
  } = $props();

  const sessions = $derived(accounts.reduce((n, a) => n + a.sessions.length, 0));
  const five = $derived(tightestShown(accounts, "fiveHour"));
  const week = $derived(tightestShown(accounts, "sevenDay"));
  const headline = $derived(shownLevel(accounts));
  // The label's tail (" · email · Team · plan") beside the name on the card; nothing when there is no profile.
  const identOf = (a: AccountUsage) => { const label = accountLabel(a); return label === a.account ? "" : label.slice(a.account.length); };
  // A headline tile names its account; with a profile, the label says which subscription that is.
  const labelOf = (name: string) => accountLabel(accounts.find(a => a.account === name) ?? { account: name });

  // A named disagreement's window, in the words the rows already use; a window a source named itself keeps its own id.
  const windowWords = (id: string) => id === "five_hour" ? "5-hour window" : id === "seven_day" ? "weekly window" : id;

  // The Forget of a source asks first: the first tap only says what it removes, the second runs it. Per source row. An
  // armed row does not wait for ever: it disarms after a few seconds, when it loses focus and when its row is gone, and
  // a second tap right on the first (a double click) is not a decision.
  const ARM_MS = 4000, DOUBLE_TAP_MS = 400;
  let confirming = $state<Record<string, boolean>>({});
  const armedAt: Record<string, number> = {};
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const disarm = (key: string) => { confirming[key] = false; const t = timers.get(key); if (t !== undefined) clearTimeout(t); timers.delete(key); };
  // A failed act's words, per account (the seat) and per source row (the forget); empty: none.
  let problems = $state<Record<string, string>>({});
  const problemOf = async (key: string, run: () => Act) => {
    const r = await run();
    problems[key] = r && typeof r === "object" && !r.ok ? r.problem : "";
  };
  const forget = (account: string, source: string, node: string | null) => {
    const key = `${account}|${source}|${node}`;
    if (!confirming[key]) {
      confirming[key] = true;
      armedAt[key] = Date.now();
      timers.set(key, setTimeout(() => disarm(key), ARM_MS));
      return;
    }
    if (Date.now() - (armedAt[key] ?? 0) < DOUBLE_TAP_MS) return;
    disarm(key);
    void problemOf(key, () => onForget(account, source, node));
  };
  // A row that is gone (or an account that went) leaves nothing armed; and no timer outlives the card.
  $effect(() => {
    const live = new Set(accounts.flatMap(a => (a.sources ?? []).map(s => `${a.account}|${s.source}|${s.node}`)));
    for (const key of [...timers.keys()]) if (!live.has(key)) disarm(key);
  });
  $effect(() => () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); });
  const clearMark = (account: string) => void problemOf(`seat|${account}`, () => onClearSeat(account));
</script>

{#snippet meter(label: string, w: UsageWindow | null, when: string | null, dim = false)}
  {#if w}
    {@const level = usageLevel(w.usedPercentage)}
    <div class="meter l-{level}" class:stale={dim} role="group" aria-label="{label}: {pct(w.usedPercentage)} used, {LEVEL_WORDS[level]}">
      <div class="mh"><span class="ml">{label}</span><span class="mv">{pct(w.usedPercentage)} <small>used</small></span></div>
      <div class="track" aria-hidden="true"><div class="fill" style:width="{Math.max(1, Math.min(100, w.usedPercentage))}%"></div></div>
      <div class="mf">
        <span class="lvl">{#if level === "ok"}<CircleCheck size={13} />{:else if level === "warning"}<TriangleAlert size={13} />{:else}<CircleAlert size={13} />{/if}{LEVEL_WORDS[level]}</span>
        {#if when}<span class="reset">{when}</span>{:else if resetsIn(w.resetsAt, now)}<span class="reset">{resetsIn(w.resetsAt, now)}</span>{/if}
      </div>
    </div>
  {:else}
    <div class="meter none" class:stale={dim} role="group" aria-label="{label}: not reported">
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

    {#if notices.length}
      <section class="notices" aria-label="Recent notices">
        <h3><Bell size={14} />Recent notices</h3>
        <ul>
          {#each notices.slice(0, 8) as n (n.id)}
            <li><span class="acct">{n.account}</span><span class="when">{ago(n.at, now)}</span><span class="text">{n.text}</span></li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if accounts.length === 0}
      <div class="empty">
        <h3>No account reports yet</h3>
        <p>Usage comes from each session's status line. Have the lanes post it to the hub with their agent token: <code>docs/agents/usage.md</code> has the three lines.</p>
      </div>
    {:else}
      <div class="cards">
        {#each accounts as a (a.account)}
          {@const h = accountHealth(a, now)}
          {@const dim = h.state === "stale"}
          <article class="card" data-account={a.account} aria-label="Account {accountLabel(a)}">
            <header>
              <Avatar name={a.account} kind="agent" size={28} />
              <div class="who"><h3>{a.account}</h3>{#if identOf(a)}<span class="ident">{identOf(a)}</span>{/if}</div>
              {#if a.seat}
                <span class="seat">
                  <Armchair size={14} />
                  <span>{seatLine(a.seat, now)}</span>
                  {#if a.seat.fix}<span class="seatfix">Fix: {fixWords(a.seat.fix)}</span>{/if}
                  <span class="seatby">set by {a.seat.by} · {a.seat.owner === "pool" ? "the pool" : "a lane's failure"}</span>
                </span>
                <button type="button" class="clearseat" aria-label="Clear this mark for {a.account}" onclick={() => clearMark(a.account)}>Clear this mark</button>
              {/if}
              {#if a.reportedAt > 0}<span class="when">reported {ago(a.reportedAt, now)}</span>{/if}
            </header>
            {#if problems[`seat|${a.account}`]}<p class="actproblem" role="alert">{problems[`seat|${a.account}`]}</p>{/if}
            {#if h.state === "unavailable"}
              {#each h.sources.filter(s => s.state === "unavailable") as s, i (`${a.account}|u|${i}`)}
                <div class="unreadable" role="status">
                  <p class="head"><CircleSlash size={15} />Can't read since {s.since === null ? "a while" : clockOf(s.since)}{s.reason === null ? "" : `, ${REASON_WORDS[s.reason]}`}{s.fix === null ? "" : `. Fix: ${fixWords(s.fix)}`}</p>
                  {#if s.hint !== null}<p class="hint">the source says: {s.hint}</p>{/if}
                </div>
              {/each}
            {:else if h.state === "missing"}
              <div class="unreadable" role="status">
                <p class="head"><CircleSlash size={15} />No reading yet</p>
                <p class="hint">Nothing has read this account yet.</p>
              </div>
            {:else}
              {#if dim}
                <p class="asof"><Clock size={13} />As of {clockOf(h.asOf ?? now)}</p>
                {#each h.sources.filter(s => s.state === "stale" && s.reason !== null) as s, i (`${a.account}|s|${i}`)}
                  <p class="srcnote">{sourceLine(s, now)}</p>
                {/each}
              {/if}
              {#if a.limits?.length}
                {#each a.limits as w, i (`${w.label}:${i}`)}
                  {@render meter(w.title ? `${w.label} · ${w.title}` : w.label, w, resetsOnLabel(w.resetsOn), dim)}
                {/each}
                {#if onDemandLine(a.onDemand)}<p class="ondemand">{onDemandLine(a.onDemand)}</p>{/if}
              {:else}
              {@render meter("5-hour window", a.fiveHour, null, dim)}
              {@render meter("Weekly window", a.sevenDay, null, dim)}
              {/if}
              {#if a.spend}
                {@render meter(`Spend limit${a.spend.period ? ` (${a.spend.period})` : ""}`, a.spend, null, dim)}
                {#if a.spend.usedUsd !== null}<p class="spend">{usd(a.spend.usedUsd)}{a.spend.limitUsd !== null ? ` of ${usd(a.spend.limitUsd)}` : ""}</p>{/if}
              {/if}
            {/if}
            {#each a.disagree ?? [] as d, i (`${a.account}|d|${i}`)}
              <p class="disagree" role="note"><TriangleAlert size={14} />Sources disagree about the {windowWords(d.window)}: {d.a.source} says {pct(d.a.usedPercent)} at {clockOf(d.a.capturedAt)}, {d.b.source} says {pct(d.b.usedPercent)} at {clockOf(d.b.capturedAt)}.</p>
            {/each}
            {#if h.sources.length}
              <div class="srcs">
                <span class="sl">Sources</span>
                {#each h.sources as s (`${a.account}|${s.source}|${s.node}`)}
                  {@const key = `${a.account}|${s.source}|${s.node}`}
                  <div class="src">
                    <span class="line">{sourceLine(s, now)}</span>
                    {#if s.state === "unavailable" || s.state === "stale"}
                      <button type="button" class="forget" aria-label="Forget {s.source} of {a.account}" onclick={() => forget(a.account, s.source, s.node)} onblur={() => disarm(key)}>{confirming[key] ? "Forget? (this removes it)" : "Forget"}</button>
                    {/if}
                  </div>
                  {#if problems[key]}<p class="actproblem" role="alert">{problems[key]}</p>{/if}
                {/each}
              </div>
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
  .ts { font: 400 12px/16px var(--font); color: var(--muted); overflow-wrap: anywhere; }   /* a label and a reset time wrap, they are not cut */
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
  /* The name, then the email, organization and plan after it, one line of text that wraps (on a phone) and never cuts the name. */
  .who { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .card .who h3 { display: inline; white-space: normal; }
  .ident { font: 400 13px/18px var(--font); color: var(--muted); }
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
  /* S4 (plan 4.4): the notices panel, above the cards — the hub's own words, plain text. */
  .notices { margin: 16px 0 0; padding: 10px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--main-bg); }
  .notices h3 { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; font: 700 13px/18px var(--font); color: var(--muted); }
  .notices ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
  .notices li { display: flex; align-items: baseline; gap: 8px; font: 400 13px/18px var(--font); flex-wrap: wrap; }
  .notices .acct { font-weight: 700; }
  .notices .when { color: var(--muted); font: 400 12px/16px var(--font); white-space: nowrap; }
  .notices .text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  /* The seat badge, in the card header: words, an icon and who set it — never colour alone. */
  .seat { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--code-bg); font: 400 12px/16px var(--font); }
  .seat :global(svg) { flex: none; color: var(--warn-fg); }
  .seatfix { color: var(--text); font-weight: 700; }
  .seatby { color: var(--muted); overflow-wrap: anywhere; }
  .clearseat { border: 1px solid var(--border); border-radius: 6px; background: var(--main-bg); color: var(--text); font: 400 12px/16px var(--font); padding: 4px 8px; cursor: pointer; }
  .clearseat:hover { background: var(--hover); }
  /* A state the meters cannot show: unreadable or never read, in words with an icon (role=status). */
  .unreadable { display: grid; gap: 4px; padding: 10px 12px; border-radius: 8px; background: var(--warn-bg); color: var(--warn-fg); }
  .unreadable .head { display: flex; align-items: center; gap: 8px; margin: 0; font: 600 13px/18px var(--font); flex-wrap: wrap; }
  .unreadable .hint { margin: 0; font: 400 13px/18px var(--font); overflow-wrap: anywhere; }
  /* Stale: the meters stay, dimmed, and the words below say how old the numbers are. */
  .meter.stale { opacity: 0.55; }
  .asof { display: flex; align-items: center; gap: 6px; margin: 0; font: 400 12px/16px var(--font); color: var(--muted); }
  .srcnote { margin: 0; font: 400 12px/16px var(--font); color: var(--muted); overflow-wrap: anywhere; }
  .disagree { display: flex; align-items: center; gap: 8px; margin: 0; padding: 6px 10px; border-radius: 8px; background: var(--warn-bg); color: var(--warn-fg); font: 400 13px/18px var(--font); flex-wrap: wrap; }
  /* The sources list, one line each, always visible; Forget asks before it removes. */
  .srcs { display: grid; gap: 4px; }
  .src { display: flex; align-items: center; gap: 8px; }
  .src .line { flex: 1; min-width: 0; font: 400 12px/16px var(--font); color: var(--muted); overflow-wrap: anywhere; }
  .forget { flex: none; border: 1px solid var(--border); border-radius: 6px; background: var(--main-bg); color: var(--text); font: 400 12px/16px var(--font); padding: 4px 8px; cursor: pointer; }
  .forget:hover { background: var(--hover); }
  .actproblem { margin: 0; font: 400 12px/16px var(--font); color: var(--bad-fg); overflow-wrap: anywhere; }
  @media (max-width: 900px) {
    .forget, .clearseat { min-height: 44px; }                 /* a tap target on the phone layout */
  }
</style>
