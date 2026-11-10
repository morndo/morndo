<script lang="ts">
  // The Morndo mark (packages/brand/assets/mark/morndo-mark-currentcolor.svg), drawn from the same path data
  // (avatar-look.ts) so it cannot drift from the brand kit. Filled with currentColor: the tile it sits on sets the ink.
  import { MARK_PATH } from "./avatar-look.ts";

  let { size }: { size: number } = $props();
</script>

<svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d={MARK_PATH} /></svg>
