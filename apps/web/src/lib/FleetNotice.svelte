<script lang="ts">
  // Fleet core §7: the hub can't reach the fleet service, so it can neither see nor steer the machines the agents run
  // on. It keeps the last list with every worker marked offline (its state unknown), and the app says why, in both
  // layouts, until the hub says the fleet is back (the feed's `fleet` frame). An icon plus the words (COLOR.md 2), in the
  // warning colours; nothing to dismiss, since it goes when its cause does. It lets clicks through to what lies beneath.
  // Placed at the top of the page: --fleet-notice-top moves it below a layout's own bar.
  import ServerOff from "@lucide/svelte/icons/server-off";
  let { available }: { available: boolean } = $props();
</script>

{#if !available}
  <div class="fleet" role="status">
    <ServerOff size={16} aria-hidden="true" />
    <span><strong>Fleet unavailable.</strong> The hub can't reach the machines the agents run on. They may still be running, but what you see may be out of date, and nothing can be sent to them until it's back.</span>
  </div>
{/if}

<style>
  .fleet {
    position: fixed; z-index: 50; top: var(--fleet-notice-top, calc(env(safe-area-inset-top, 0px) + 8px)); left: 16px; right: 16px;
    max-width: 34rem; margin-inline: auto; display: flex; gap: 10px; align-items: flex-start; pointer-events: none;
    padding: 10px 14px; border-radius: 12px; border: 1px solid var(--morndo-warning); background: var(--morndo-warning-subtle);
    color: var(--morndo-warning-text); box-shadow: 0 6px 24px rgb(0 0 0 / 0.18); font-size: 14px; line-height: 20px;
  }
  .fleet :global(svg) { flex: none; margin-top: 2px; }
</style>
