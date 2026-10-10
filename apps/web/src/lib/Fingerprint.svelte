<script lang="ts">
  // The hub identity as 16 groups of 4, laid out like a Signal safety number, for comparing with the terminal.
  let { value }: { value: string } = $props();
  const groups = $derived((value.replace(/[^0-9a-f]/gi, "").toLowerCase().match(/.{1,4}/g) ?? []));
</script>

<div class="fp" aria-label="Hub identity">
  {#each groups as g}<span>{g}</span>{/each}
</div>

<style>
  .fp {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 10px;
    font: 500 1.05rem/1.4 var(--mono); letter-spacing: 0.06em; text-align: center;
    background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px;
    font-variant-numeric: tabular-nums;
  }
</style>
