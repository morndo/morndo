<!-- Phone: list-only index. Desktop: layout redirects to accounts. -->
<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  onMount(() => {
    if (window.matchMedia("(min-width: 900px)").matches) void goto("/settings/accounts", { replaceState: true });
  });
</script>
