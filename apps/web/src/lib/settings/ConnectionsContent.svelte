<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { CONNECTION_WORDS } from "@morndo/protocol";
  import { api } from "$lib/api.ts";
  import ConnectionsBoard from "$lib/connections/ConnectionsBoard.svelte";

  let { embedded = false }: { embedded?: boolean } = $props();
  let connectionsOn = $state<boolean | null>(null);

  onMount(() => {
    void api.get<{ connections?: boolean }>("/api/me").then(
      me => { connectionsOn = me.connections === true; },
      () => { connectionsOn = true; },
    );
  });
</script>

<section class="connections" aria-labelledby={embedded ? "settings-connections" : undefined}>
  {#if embedded}<h2 id="settings-connections">{CONNECTION_WORDS.title}</h2>{/if}
  {#if connectionsOn === true}
    <ConnectionsBoard />
  {:else if connectionsOn === false}
    {#if !embedded}<h2>{CONNECTION_WORDS.sections.connections}</h2>{/if}
    <p>This hub has no connections home.</p>
  {/if}
</section>

<style>
  .connections { display: grid; gap: 12px; margin-top: 16px; }
  .connections h2 { margin: 0; font: 700 19px/24px var(--display, system-ui); }
  .connections p { margin: 0; }
</style>
