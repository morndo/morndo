<script lang="ts">
  import { settingsSections, type SettingsSection } from "./sections.ts";

  let { sections, active }: { sections: SettingsSection[]; active: string | null } = $props();
</script>

<nav class="sections" aria-label="Settings sections">
  {#each sections as s (s.href)}
    <a href={s.href} aria-current={active === s.id ? "page" : undefined}>{s.label}</a>
  {/each}
</nav>

<style>
  .sections { display: grid; gap: 4px; }
  .sections a {
    display: flex; align-items: center; min-height: 44px; padding: 8px 12px; border-radius: 12px;
    font: 600 15px/20px var(--body); color: var(--fg); text-decoration: none;
  }
  .sections a:hover { background: var(--hover); }
  .sections a[aria-current="page"] { background: var(--fill); }
</style>
