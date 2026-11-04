<script lang="ts">
  import SettingsNav from "../src/lib/settings/SettingsNav.svelte";
  import { settingsSections } from "../src/lib/settings/sections.ts";

  let active = $state("accounts");
  const sections = settingsSections({ engines: true, updates: true });
</script>

<SettingsNav {sections} {active} />
<button type="button" onclick={() => (active = "devices")}>go devices</button>
