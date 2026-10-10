<script lang="ts">
  // One role on the Engines page (ADR-0013): its chain as a numbered list, the first choice on top, each engine with a
  // provider, model and effort picker and its provider's availability; reorder, remove, add a fallback; the
  // reviewer-from-another-provider switch on every role (the draft holds it, so turning it off leaves it there to
  // turn back on); what runs now by the resolver. Every edit goes through the domain's rules (R3) and is only a draft
  // until the page saves.
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import X from "@lucide/svelte/icons/x";
  import {
    MAX_CHAIN, addFallback, effortFromText, engineText, moveEngine, removeEngine, repeatsAbove, replaceEngine, retarget, setOtherProvider, suggestFallback,
    type Engine, type EngineProvider, type RoleEngines,
  } from "@morndo/domain";
  import type { EnginesNow } from "@morndo/protocol";
  import { availabilityWords, engineWords, problemWords, providerName } from "./words.ts";

  let { role, changed, now, providers, onChange }: {
    role: RoleEngines; changed: boolean; now: EnginesNow; providers: EngineProvider[];
    onChange: (next: RoleEngines) => void;
  } = $props();
  let problem = $state<string | null>(null);
  // A refusal belongs to the role as it was: a new draft (an edit, Discard, a save) clears it.
  $effect(() => { void role; problem = null; });

  const id = $derived(`role-${role.role}`);
  // One wording for an engine's place, in the buttons' and pickers' names and, capitalised, on the card.
  const position = (i: number) => (i === 0 ? "first choice" : `fallback ${i}`);
  const Position = (i: number) => position(i).charAt(0).toUpperCase() + position(i).slice(1);
  const providerOf = (name: string) => providers.find(p => p.name === name);
  // A provider that lists no efforts (null) takes any: a free text field, empty for its default (verify round, finding 8:
  // other providers' efforts aren't its own).
  const effortsOf = (p: EngineProvider | undefined) => p?.efforts ?? [];
  function typeEffort(i: number, e: Engine, input: HTMLInputElement) {
    const effort = effortFromText(input.value);
    if (effort === null) { problem = "An effort is lowercase letters, such as high; leave it empty for the provider's default."; input.value = e.effort; return; }
    if (effort !== e.effort) {
      const next = replaceEngine(role, i, { ...e, effort }, providers);
      if (!next.ok) input.value = e.effort;
      apply(next);
    }
  }

  function apply(r: { ok: true; value: RoleEngines } | { ok: false; error: string }, select?: HTMLSelectElement, was?: string) {
    if (r.ok) { problem = null; onChange(r.value); return; }
    problem = problemWords(r.error);
    if (select && was !== undefined) select.value = was;           // the picker shows what the draft holds
  }
  const choose = (i: number, e: Engine, select: HTMLSelectElement, was: string) => apply(replaceEngine(role, i, e, providers), select, was);

  function chip(e: Engine, i: number) {
    if (repeatsAbove(role.chain, i)) return { word: "Also above: never runs", tone: "warn" };
    const p = providerOf(e.provider);
    if (!p) return { word: "Unknown provider", tone: "bad" };
    const paused = p.pausedModels.find(m => m.model === e.model);
    // The resolver skips a paused model whenever the provider itself would run (ready, or a sign-in not yet checked).
    return paused && (p.availability === "ready" || p.availability === "unconfirmed") ? { word: "Model paused", tone: "warn" } : availabilityWords(p, true);
  }
  function add() {
    const e = suggestFallback(role, providers);
    if (!e) { problem = "Every engine the providers offer is in this list already."; return; }
    apply(addFallback(role, e, providers));
  }
</script>

<section class="role" aria-labelledby={id} data-role={role.role}>
  <header>
    <h3 id={id}>{role.label}</h3>
    {#if changed}<span class="chip">Not saved</span>{/if}
  </header>
  {#if !changed}
    {#if now.engine}
      <p class="now">Runs now: <b>{engineWords(now.engine, providers)}</b></p>
    {:else}
      <p class="now none">Nothing in this list can run now.</p>
    {/if}
    {#if now.skipped.length}
      <details>
        <summary>Why not {now.skipped.length === 1 ? "the one above it" : `the ${now.skipped.length} above it`}?</summary>
        <!-- Keyed by position and entry: a chain holding one engine twice is skipped twice (review of PR #13, finding 1). -->
        <ul class="skipped">{#each now.skipped as s, i (`${i}:${s.engine}`)}<li><b>{engineWords(s.engine, providers)}</b>: {s.reason}</li>{/each}</ul>
      </details>
    {/if}
  {:else}
    <p class="now">What runs is checked again after you save.</p>
  {/if}

  <ol class="chain">
    <!-- Keyed by position: the CLI takes the same engine twice in a chain, and a duplicate key would stop the page. -->
    {#each role.chain as e, i (i)}
      {@const p = providerOf(e.provider)}
      {@const c = chip(e, i)}
      <li class="engine">
        <div class="line">
          <span class="pos">{Position(i)}</span>
          <span class="chip {c.tone}">{c.word}</span>
          <span class="acts">
            <button class="ib" aria-label="Move {position(i)} up" disabled={i === 0} onclick={() => apply(moveEngine(role, i, -1))}><ArrowUp size={18} /></button>
            <button class="ib" aria-label="Move {position(i)} down" disabled={i === role.chain.length - 1} onclick={() => apply(moveEngine(role, i, 1))}><ArrowDown size={18} /></button>
            <button class="ib" aria-label="Remove {position(i)}" disabled={role.chain.length === 1} onclick={() => apply(removeEngine(role, i))}><X size={18} /></button>
          </span>
        </div>
        <div class="pickers">
          <label class="provider"><span>Provider</span>
            <select aria-label="Provider, {position(i)}" value={e.provider}
              onchange={ev => choose(i, retarget(e, ev.currentTarget.value, providers, role.chain.filter((_, j) => j !== i)), ev.currentTarget, e.provider)}>
              {#if !p}<option value={e.provider}>{e.provider}</option>{/if}
              {#each providers as o (o.name)}<option value={o.name}>{providerName(o)}{o.availability === "ready" ? "" : ` (${availabilityWords(o).word.toLowerCase()})`}</option>{/each}
            </select>
          </label>
          <label class="model"><span>Model</span>
            <select aria-label="Model, {position(i)}" value={e.model}
              onchange={ev => choose(i, { ...e, model: ev.currentTarget.value }, ev.currentTarget, e.model)}>
              {#if !p?.models.includes(e.model)}<option value={e.model}>{e.model} (set by hand)</option>{/if}
              {#each p?.models ?? [] as m (m)}<option value={m}>{m}</option>{/each}
            </select>
          </label>
          {#if p && p.efforts === null}
            <label class="effort"><span>Effort</span>
              <input aria-label="Effort, {position(i)}" value={e.effort} placeholder="default" autocomplete="off" autocapitalize="none" spellcheck="false"
                onchange={ev => typeEffort(i, e, ev.currentTarget)} />
            </label>
          {:else if effortsOf(p).length || e.effort}
            <label class="effort"><span>Effort</span>
              <select aria-label="Effort, {position(i)}" value={e.effort}
                onchange={ev => choose(i, { ...e, effort: ev.currentTarget.value }, ev.currentTarget, e.effort)}>
                <option value="">Default</option>
                {#if e.effort && !effortsOf(p).includes(e.effort)}<option value={e.effort}>{e.effort}</option>{/if}
                {#each effortsOf(p) as x (x)}<option value={x}>{x}</option>{/each}
              </select>
            </label>
          {/if}
        </div>
      </li>
    {/each}
  </ol>
  {#if role.chain.length < MAX_CHAIN}
    <button class="tlink add" onclick={add}>+ Add a fallback</button>
  {:else}
    <p class="note">{role.chain.length > MAX_CHAIN ? `This list is longer than ${MAX_CHAIN} engines (set outside the page). You can reorder or change its engines and save it at this length or shorter.` : `A list holds at most ${MAX_CHAIN} engines.`}</p>
  {/if}

  <div class="rule">
      <div>
        <b id="{id}-rule">Reviewer from another provider</b>
        <p class="note">The reviewer's model comes from another family than the implementer's, so Claude never reviews Claude's work.</p>
      </div>
      <button class="switch" role="switch" aria-checked={role.otherProvider} aria-labelledby="{id}-rule"
        onclick={() => onChange(setOtherProvider(role, !role.otherProvider))}><i></i></button>
    </div>
  {#if role.riskChain}
    <p class="note risk">For risky work: {role.riskChain.map(x => engineWords(engineText(x), providers)).join(" → ")}</p>
  {/if}
  {#if problem}<p class="err" role="alert">{problem}</p>{/if}
</section>

<style>
  /* Grid items keep min-width 0 all the way down, so a long option in a picker never widens the page (390 px). */
  .role {
    min-width: 0; display: grid; gap: 12px; padding: 16px; border-radius: 18px; background: var(--surface); box-shadow: var(--card-shadow);
  }
  header { display: flex; align-items: center; gap: 10px; }
  h3 { flex: 1; margin: 0; font: 700 19px/24px var(--display); }
  .now { margin: 0; font: 400 14px/20px var(--body); color: var(--muted); }
  .now b { color: var(--fg); }
  .now.none { color: var(--bad-text); font-weight: 700; }
  details { font: 400 13px/18px var(--body); color: var(--muted); }
  summary { cursor: pointer; min-height: 32px; display: flex; align-items: center; }
  .skipped { margin: 4px 0 0; padding-left: 18px; }
  .chain { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  .engine { min-width: 0; display: grid; gap: 8px; padding: 12px; border-radius: 14px; border: 1px solid var(--line); }
  .engine:first-child { border-color: var(--edge); }
  .line { display: flex; align-items: center; gap: 8px; min-height: 36px; min-width: 0; }
  .line .chip { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .pos { white-space: nowrap; font: 700 12px/16px var(--body); letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
  .acts { margin-left: auto; display: flex; gap: 2px; }
  .ib {
    width: 40px; height: 40px; display: grid; place-items: center; border: 0; border-radius: 10px; background: transparent; color: var(--fg); cursor: pointer;
  }
  .ib:disabled { color: var(--muted); opacity: 0.4; cursor: default; }
  .ib:not(:disabled):active { background: var(--hover); }
  .pickers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .pickers .model { grid-column: 1 / -1; grid-row: 2; }
  @media (min-width: 640px) {
    .pickers { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.4fr) minmax(0, 0.8fr); }
    .pickers .model { grid-column: auto; grid-row: auto; }
  }
  label { display: grid; gap: 3px; min-width: 0; }
  label span { font: 700 11px/14px var(--body); letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
  /* 16px text: iOS zooms into a smaller select. 44px high: Apple's minimum hit target. */
  select, input {
    width: 100%; min-width: 0; min-height: 44px; padding: 0 10px; border-radius: 11px; border: 1px solid var(--edge);
    background: var(--bg); color: var(--fg); font: 400 16px/1.2 var(--body);
  }
  .add { justify-self: start; padding-left: 0; }
  .rule { display: flex; align-items: center; gap: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
  .rule div { flex: 1; display: grid; gap: 2px; }
  .rule b { font: 700 15px/20px var(--body); }
  .switch {
    position: relative; flex: none; width: 52px; height: 32px; border-radius: 16px; border: 1px solid var(--edge); background: var(--fill); cursor: pointer;
  }
  .switch i { position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%; background: var(--fg); transition: left 0.15s; }
  .switch[aria-checked="true"] { background: var(--ink); border-color: var(--ink); }
  .switch[aria-checked="true"] i { left: 23px; background: var(--ink-fg); }
  .risk { padding-top: 10px; border-top: 1px solid var(--line); }
</style>
