<script lang="ts">
  // Settings (ADR-0039 §8): one page for Accounts, LLM connections, Devices and Updates. On a wide screen the
  // sections sit on the left and the open one on the right; on a phone /settings is the list, and inside a section the
  // header's chevron is Back to it. The app renders only in the browser (ssr = false), so the width is known before
  // first paint.
  import "$lib/phone/phone.css";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import { api } from "$lib/api.ts";
  import { isSettingsIndex, sectionFromPath, settingsSections } from "$lib/settings/sections.ts";
  import SettingsNav from "$lib/settings/SettingsNav.svelte";

  let { children } = $props();
  let engines = $state(false);
  let updates = $state(false);
  const WIDE = "(min-width: 900px)";
  let wide = $state(window.matchMedia(WIDE).matches);

  const pathname = $derived(page.url.pathname);
  const sections = $derived(settingsSections({ engines, updates }));
  const active = $derived(sectionFromPath(pathname));
  const indexOnly = $derived(!wide && isSettingsIndex(pathname));
  const phoneSection = $derived(!wide && !isSettingsIndex(pathname));

  onMount(() => {
    const mq = window.matchMedia(WIDE);
    const set = () => { wide = mq.matches; };
    mq.addEventListener("change", set);
    void api.get<{ engines?: boolean; updates?: boolean }>("/api/me").then(
      me => { engines = me.engines === true; updates = me.updates === true; },
      () => {},
    );
    return () => mq.removeEventListener("change", set);
  });

  $effect(() => {
    if (wide && isSettingsIndex(pathname)) void goto("/settings/accounts", { replaceState: true });
  });
</script>

<div class="phone settings">
  <header class="top">
    <div class="in" class:wide={wide}>
      <!-- On a phone, inside a section, this goes back to the list of sections; elsewhere it goes home. -->
      {#if phoneSection}
        <a class="back" href="/settings" aria-label="Back"><ChevronLeft size={24} /></a>
      {:else}
        <a class="back" href="/" aria-label="Home"><ChevronLeft size={24} /></a>
      {/if}
      <div>
        <h1>Settings</h1>
      </div>
    </div>
  </header>

  <div class="shell" class:wide={wide} class:phoneSection={phoneSection}>
    {#if !phoneSection}
      <SettingsNav {sections} {active} />
    {/if}

    {#if !indexOnly}
      <div class="panel">{@render children()}</div>
    {/if}
  </div>
</div>

<style>
  .settings { min-height: 100dvh; }
  .top {
    position: sticky; top: 0; z-index: 2; background: var(--bg); border-bottom: 1px solid var(--line);
    padding: calc(var(--safe-top) + 10px) max(16px, var(--safe-right)) 12px max(8px, var(--safe-left));
  }
  .in { max-width: calc(46rem + 52px); margin: 0 auto; display: flex; align-items: flex-start; gap: 6px; padding-right: 52px; }
  @media (max-width: 899px) { .in { padding-right: 0; } }
  .in.wide { max-width: calc(56rem + 52px); padding-right: 0; }
  .in div { flex: 1; min-width: 0; }
  .back {
    flex: none; width: 44px; height: 44px; display: grid; place-items: center; color: var(--fg); border-radius: 12px;
    text-decoration: none;
  }
  h1 { margin: 0; font: 700 28px/34px var(--display); }
  .shell {
    width: 100%; max-width: 46rem; margin: 0 auto; padding: 16px max(16px, var(--safe-right)) 120px max(16px, var(--safe-left));
    display: grid; gap: 16px;
  }
  .shell.wide {
    max-width: calc(56rem + 52px);
    grid-template-columns: minmax(10rem, 13rem) minmax(0, 1fr);
    align-items: start;
  }
  .shell.wide.phoneSection { grid-template-columns: minmax(0, 1fr); }
  .panel { min-width: 0; display: grid; gap: 14px; }
  @media (min-width: 900px) {
    .shell.wide .sections { position: sticky; top: calc(var(--safe-top) + 72px); }
  }
</style>
