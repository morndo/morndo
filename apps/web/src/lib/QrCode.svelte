<script lang="ts">
  // A QR code as SVG, dark modules on white whatever the theme (a camera needs the contrast), with the 4-module quiet
  // zone the standard asks for. Encoded by uqr (MIT, unjs/uqr 0.1.3), loaded only when a code is shown, so the app's
  // first load doesn't carry it (ADR-0008 phase E).
  let { value, label, size = 208 }: { value: string; label: string; size?: number } = $props();
  let code = $state<{ d: string; n: number } | null>(null);
  $effect(() => {
    const v = value;
    let live = true;
    void import("uqr").then(({ encode }) => {
      if (!live) return;
      const { data } = encode(v, { ecc: "M", border: 4 });
      let d = "";
      data.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x} ${y}h1v1h-1z`; }));
      code = { d, n: data.length };
    });
    return () => { live = false; };
  });
</script>

{#if code}
  <svg class="qr" viewBox="0 0 {code.n} {code.n}" width={size} height={size} role="img" aria-label={label} shape-rendering="crispEdges">
    <rect width={code.n} height={code.n} fill="#fff" /><path d={code.d} fill="#000" />
  </svg>
{:else}
  <div class="qr" style:width="{size}px" style:height="{size}px" role="img" aria-label="{label} (drawing…)"></div>
{/if}

<style>
  .qr { display: block; border-radius: 8px; background: #fff; max-width: 100%; height: auto; aspect-ratio: 1; }
</style>
