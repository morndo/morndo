<script lang="ts">
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
  let wide = $state(false);

  const pathname = $derived(page.url.pathname);
  const sections = $derived(settingsSections({ engines, updates }));
  const active = $derived(sectionFromPath(pathname) ?? (isSettingsIndex(pathname) ? "accounts" : null));
  const indexOnly = $derived(!wide && isSettingsIndex(pathname));
  const phoneSection = $derived(!wide && !isSettingsIndex(pathname));

  onMount(() => {
    const mq = window.matchMedia("(min-width: 900px)");
    const set = () => { wide = mq.matches; };
    set();
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
    <div class="in">
      <a class="back home" href="/" aria-label="Morndo"><ChevronLeft size={24} /></a>
      <div>
        <h1>Settings</h1>
      </div>
    </div>
  </header>

  <div class="shell" class:wide={wide} class:phoneSection={phoneSection}>
    {#if !phoneSection}
      <SettingsNav {sections} {active} />
    {/if}

    {#if phoneSection}
      <a class="back list" href="/settings">Back</a>
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
  .in div { flex: 1; min-width: 0; }
  .back {
    flex: none; width: 44px; height: 44px; display: grid; place-items: center; color: var(--fg); border-radius: 12px;
    text-decoration: none;
  }
  .back.list {
    width: auto; height: auto; min-height: 44px; padding: 0 8px; font: 700 15px/20px var(--body); justify-content: start;
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
