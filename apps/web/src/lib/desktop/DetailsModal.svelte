<script lang="ts">
  // Slack's conversation-details modal, for an agent: About (what it works on, where, which session) and Settings
  // (show mode, tool activity, mute). The frame is SlackModal; the measurements are in ADR-0006.
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Copy from "@lucide/svelte/icons/copy";
  import Hash from "@lucide/svelte/icons/hash";
  import Star from "@lucide/svelte/icons/star";
  import Terminal from "@lucide/svelte/icons/terminal";
  import type { RosterEntry } from "@morndo/domain";
  import type { SessionInfo } from "../feed.svelte.ts";
  import type { ConversationPrefs } from "./present.ts";
  import Avatar from "./Avatar.svelte";
  import SlackModal from "./SlackModal.svelte";

  let { worker, displayName, session, prefs, tab: initialTab = "about", onPrefs, onScreen, onClose }: {
    worker: RosterEntry; displayName: string; session: SessionInfo | undefined; prefs: ConversationPrefs;
    tab?: "about" | "settings"; onPrefs: (p: Partial<ConversationPrefs>) => void; onScreen: () => void; onClose: () => void;
  } = $props();

  let tab = $state("about");
  $effect.pre(() => { tab = initialTab; });
  let showMenu = $state(false);
  let copied = $state(false);
  const isManager = $derived(worker.name === "manager");
  const stateText = $derived(worker.needsYou ? "Needs you: it asked a question or shows a menu" : worker.state === "active" ? "Working" : "Idle");

  async function copyId() {
    try { await navigator.clipboard.writeText(worker.id); copied = true; setTimeout(() => (copied = false), 1500); } catch { /* clipboard refused */ }
  }
</script>

<svelte:window onkeydown={e => { if (e.key === "Escape" && showMenu) { e.preventDefault(); showMenu = false; } }} />
<SlackModal label="{displayName} details" {onClose} tabs={[{ id: "about", label: "About" }, { id: "settings", label: "Settings" }]} bind:tab>
  {#snippet title()}
    {#if isManager}<Avatar name="Manager" kind="peer" size={24} />{:else}<Hash size={20} />{/if}<span>{displayName}</span>
  {/snippet}
  {#snippet actions()}
    <button class="ob star" class:on={prefs.starred} onclick={() => onPrefs({ starred: !prefs.starred })} aria-label={prefs.starred ? "Unstar" : "Star"} aria-pressed={prefs.starred}>
      <Star size={16} /><ChevronDown size={14} />
    </button>
    <div class="dd">
      <button class="ob" onclick={() => (showMenu = !showMenu)} aria-expanded={showMenu}>{prefs.show === "clean" ? "Answers only" : "Everything"}<ChevronDown size={14} /></button>
      {#if showMenu}
        <div class="ddmenu" role="menu">
          {#each [["clean", "Answers only"], ["verbose", "Everything (verbose)"]] as [value, label]}
            <button role="menuitemradio" aria-checked={prefs.show === value} class:checked={prefs.show === value}
              onclick={() => { onPrefs({ show: value as ConversationPrefs["show"] }); showMenu = false; }}>
              <span class="mark">{#if prefs.show === value}<Check size={16} />{/if}</span>{label}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <button class="ob" onclick={() => { onScreen(); onClose(); }}><Terminal size={14} />Terminal</button>
  {/snippet}

  {#if tab === "about"}
    <div class="card">
      <div class="field"><strong>Working on</strong><p class:ph={!worker.title}>{worker.title ?? "No title yet"}</p></div>
      <div class="field"><strong>State</strong><p>{stateText}</p></div>
      <div class="field"><strong>Folder</strong><p class="mono">{session?.cwd || worker.location}</p></div>
      <div class="field"><strong>Session</strong><p class:ph={!session}>{session ? `${session.name ?? "unnamed"} · agent CLI ${session.version ?? "?"}` : "No agent session found in this pane"}</p></div>
      <div class="field"><strong>Terminal</strong><p>tmux window <span class="mono">{worker.name}</span></p></div>
    </div>
    <p class="foot">Pane ID: {worker.id} <button class="copy" onclick={copyId} aria-label="Copy pane ID">{#if copied}<Check size={14} />{:else}<Copy size={14} />{/if}</button></p>
  {:else}
    <div class="card">
      <div class="field">
        <strong>Show in chat</strong>
        <label class="opt"><input type="radio" name="show" id="show-clean" checked={prefs.show === "clean"} onchange={() => onPrefs({ show: "clean" })} />
          <span><b>Answers only</b> (default). Hides machine markers such as <code>[quiet]</code> at the start of a message, and system plumbing like lane events and background-task notes.</span></label>
        <label class="opt"><input type="radio" name="show" id="show-verbose" checked={prefs.show === "verbose"} onchange={() => onPrefs({ show: "verbose" })} />
          <span><b>Everything (verbose)</b>. Every message exactly as written, and every event.</span></label>
      </div>
      <div class="field row">
        <div><strong>Tool activity</strong><p>Show the folded lines like "Used Bash, Read ×2".</p></div>
        <input class="switch" type="checkbox" role="switch" id="pref-activity" checked={prefs.activity} onchange={e => onPrefs({ activity: e.currentTarget.checked })} aria-label="Show tool activity" />
      </div>
      <div class="field row">
        <div><strong>Mute conversation</strong><p>No bold name or unread dot. A red badge still shows when it waits for you.</p></div>
        <input class="switch" type="checkbox" role="switch" id="pref-muted" checked={prefs.muted} onchange={e => onPrefs({ muted: e.currentTarget.checked })} aria-label="Mute conversation" />
      </div>
    </div>
    <p class="foot">Settings are kept on this device.</p>
  {/if}
</SlackModal>

<style>
  .star { padding: 0 4px 1px 6px !important; gap: 2px !important; }
  .star.on :global(svg:first-child) { fill: var(--text); color: var(--text); }
  .dd { position: relative; }
  .ddmenu {
    position: absolute; top: 32px; left: 0; z-index: 2; width: 240px; padding: 12px 0; border-radius: 4px; background: var(--menu-bg);
    box-shadow: 0 0 0 1px var(--border), 0 4px 12px 0 rgba(0, 0, 0, 0.12);
  }
  .ddmenu button {
    display: flex; align-items: center; width: 100%; height: 28px; padding: 0 24px 0 4px; border: 0; background: transparent;
    color: var(--text); font: 400 15px/28px var(--font); text-align: left; cursor: pointer;
  }
  .ddmenu button.checked { color: var(--menu-checked); }
  .ddmenu button:hover { background: var(--menu-hover); color: var(--menu-hover-fg); }
  .mark { width: 20px; display: grid; place-items: center; }
  .copy { width: 20px; height: 20px; border: 0; border-radius: 4px; background: transparent; color: var(--muted); display: grid; place-items: center; cursor: pointer; }
  .copy:hover { background: var(--hover); color: var(--text); }
</style>
