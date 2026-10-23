<script lang="ts">
  // The Updates route page (updates §8.2) beside the two links that reach it — the desktop Sidebar's and the phone
  // SettingsSheet's, offered like the Engines ones. One page, one stubbed hub at the browser's edge (the fetch stub
  // lives in updates-page.test.ts's PAGE, which mounts this file).
  import Sidebar from "../src/lib/desktop/Sidebar.svelte";
  import SettingsSheet from "../src/lib/phone/chat/SettingsSheet.svelte";
  import { DEFAULT_PREFS } from "../src/lib/desktop/present.ts";
  import Updates from "../src/routes/updates/+page.svelte";

  const prefs = () => DEFAULT_PREFS;
  const quiet = () => {};
  const side = (updates: boolean) => ({
    office: "Office", workers: [], manager: null, selected: null, view: "home" as const, unread: () => false,
    needsYouCount: 0, decisions: 0, decisionsOpen: false, prefsOf: prefs, updates,
    onMenu: quiet, onSelect: quiet, onActivity: quiet, onDecisions: quiet, onCompose: quiet,
  });
</script>

<div data-updates><Updates /></div>
<div data-side="off"><Sidebar {...side(false)} /></div>
<div data-side="on"><Sidebar {...side(true)} /></div>
<!-- The sheets' fixed scrim and panel would cover the page under test, so their wrappers let clicks pass through. -->
<div data-sheet="off" class="sheets"><SettingsSheet setting="4h" updates={false} onChoose={quiet} onClose={quiet} /></div>
<div data-sheet="on" class="sheets"><SettingsSheet setting="4h" updates={true} onChoose={quiet} onClose={quiet} /></div>

<style>
  .sheets { pointer-events: none; }
</style>
