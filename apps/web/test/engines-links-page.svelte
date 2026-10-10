<script lang="ts">
  import Sidebar from "../src/lib/desktop/Sidebar.svelte";
  import { DEFAULT_PREFS } from "../src/lib/desktop/present.ts";
  import Devices from "../src/routes/devices/+page.svelte";

  const prefs = () => DEFAULT_PREFS;
  const quiet = () => {};
</script>

<div data-side="off">
  <Sidebar office="Office" workers={[]} manager={null} selected={null} view="home" unread={() => false}
    needsYouCount={0} decisions={0} decisionsOpen={false} prefsOf={prefs} engines={false}
    onMenu={quiet} onSelect={quiet} onActivity={quiet} onDecisions={quiet} onCompose={quiet} />
</div>
<div data-side="on">
  <Sidebar office="Office" workers={[]} manager={null} selected={null} view="home" unread={() => false}
    needsYouCount={0} decisions={0} decisionsOpen={false} prefsOf={prefs} engines={true}
    onMenu={quiet} onSelect={quiet} onActivity={quiet} onDecisions={quiet} onCompose={quiet} />
</div>
<div data-devices>
  <Devices />
</div>
