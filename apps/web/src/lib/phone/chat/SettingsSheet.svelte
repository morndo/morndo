<script lang="ts">
  // The phone's settings (ADR-0011): when the digest after an absence shows (H4; his choice, on this device), the way
  // to his devices and sign-out that the old Agents tab carried, to the Engines page (ADR-0013) when the hub has it,
  // and to Updates (updates §8.2) when the hub can show it.
  import { AWAY_CHOICES, type AwaySetting } from "@morndo/domain";
  import { AWAY_WORDS } from "./away.ts";

  let { setting, engines = false, updates = false, onChoose, onClose }: { setting: AwaySetting; engines?: boolean; updates?: boolean; onChoose: (v: AwaySetting) => void; onClose: () => void } = $props();
</script>

<div class="scrim" role="presentation" onclick={onClose}></div>
<div class="sheet" role="dialog" aria-modal="true" aria-label="Settings">
  <h2>Show “While you were away”</h2>
  <p class="note">Updates wait quietly in each lane's chat. A short digest shows when you come back after this long without using Morndo on any device.</p>
  <div class="choices" role="radiogroup" aria-label="Show the digest">
    {#each Object.keys(AWAY_CHOICES) as k (k)}
      <button role="radio" aria-checked={setting === k} class:on={setting === k} onclick={() => onChoose(k as AwaySetting)}>{AWAY_WORDS[k as AwaySetting]}</button>
    {/each}
  </div>
  {#if engines}<a class="pbtn" href="/engines">Engines: which AI does what</a>{/if}
  {#if updates}<a class="pbtn" href="/updates">Updates: every machine's Version</a>{/if}
  <a class="pbtn" href="/devices">Devices and sign out</a>
  <button class="pbtn primary" onclick={onClose}>Done</button>
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 7; background: rgb(0 0 0 / 0.4); }
  .sheet {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 8; display: grid; gap: 12px; background: var(--surface); color: var(--fg);
    border-radius: 20px 20px 0 0; padding: 20px max(16px, var(--safe-right)) max(16px, var(--safe-bottom)) max(16px, var(--safe-left));
  }
  h2 { margin: 0; font: 700 20px/26px var(--display); }
  .choices { display: grid; gap: 6px; }
  .choices button { min-height: 48px; padding: 0 14px; border-radius: 12px; border: 1px solid var(--edge); background: transparent; color: var(--fg); font: 400 16px/1.2 var(--body); text-align: left; cursor: pointer; }
  .choices button.on { background: var(--ink); color: var(--ink-fg); border-color: var(--ink); font-weight: 700; }
</style>
