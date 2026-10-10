<script lang="ts">
  // Development only: see +page.ts.
  const gallery = import.meta.env.DEV ? import("$lib/gallery/Gallery.svelte") : null;
</script>

<svelte:head><title>Morndo: state gallery</title></svelte:head>
{#if gallery}{#await gallery then g}<g.default />{/await}{/if}
