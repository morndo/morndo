<script lang="ts">
  // The 6-digit code typed on one device from the screen of another (ADR-0008 phase E, amendment 11): typed, not
  // compared, so approving needs the device in front of you (MFA number matching against approval fatigue). The
  // warning sits right next to the input: a lure can carry the code too.
  let { label, warning, value = $bindable(""), disabled = false }: { label: string; warning: string; value?: string; disabled?: boolean } = $props();
  const id = `code-${Math.random().toString(36).slice(2)}`;
</script>

<div class="code-input">
  <label for={id}>{label}</label>
  <input {id} {disabled} bind:value inputmode="numeric" pattern="[0-9]*" maxlength="7" autocomplete="off" spellcheck="false"
    oninput={e => { value = e.currentTarget.value.replace(/\D/g, "").slice(0, 6); }} aria-describedby="{id}-warning" />
  <p id="{id}-warning" class="warning">{warning}</p>
</div>

<style>
  .code-input { display: grid; gap: 6px; }
  label { font-size: 0.85rem; color: var(--muted); }
  input {
    font: 700 1.5rem/1.2 var(--mono); letter-spacing: 0.3em; text-align: center; font-variant-numeric: tabular-nums;
    min-height: 56px; max-width: 14rem; padding: 0 12px; border-radius: 12px; border: 1px solid var(--edge);
    background: var(--surface); color: var(--fg);
  }
  .warning { margin: 0; font-size: 0.9rem; color: var(--danger-text); }
</style>
