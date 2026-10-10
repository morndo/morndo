<script lang="ts">
  // AC13: a device was added from a signed-in device or a Link request, and every device is told, so an addition the
  // principal didn't make doesn't go unseen: live, or at the next hello of a device that was away (review M2). It
  // stays until dismissed or reviewed here, which tells the hub this device has seen it.
  let { linked, onReview, onSeen }: {
    linked: { name: string; at: number; by: string | null } | null; onReview: () => void; onSeen: (at: number) => void;
  } = $props();
</script>

{#if linked}
  <div class="linked" role="status">
    <span>A device was added: <strong>{linked.name}</strong>{#if linked.by}, from {linked.by}{/if}, at {new Date(linked.at).toLocaleString()}. Not you?</span>
    <button class="review" onclick={() => { onSeen(linked.at); onReview(); }}>Review devices</button>
    <button class="x" aria-label="Dismiss" onclick={() => onSeen(linked.at)}>×</button>
  </div>
{/if}

<style>
  .linked {
    position: fixed; z-index: 50; left: 16px; right: 16px; bottom: calc(env(safe-area-inset-bottom, 0px) + 16px);
    max-width: 30rem; margin-inline: auto; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    padding: 12px 14px; border-radius: 12px; border: 1px solid var(--morndo-border); background: var(--morndo-surface);
    color: var(--morndo-text); box-shadow: 0 6px 24px rgb(0 0 0 / 0.18); font-size: 14px;
  }
  .linked span { flex: 1 1 14rem; }
  .review { min-height: 36px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--morndo-border); background: transparent; color: inherit; cursor: pointer; font-weight: 600; }
  .x { min-width: 36px; min-height: 36px; border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 18px; }
</style>
