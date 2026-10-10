<script lang="ts">
  // One agent's conversation on the phone, read-only (ADR-0009): "Open the chat" on a decision opens the asker's at the
  // question; a tap on a message in an update card opens it there. Back (the button, or the phone's own back) returns
  // to the same card (the catch-up's top bar holds Back). Reading it here moves no read mark (C6): only the card's "Mark as
  // read" does.
  import { tick } from "svelte";
  import type { Message } from "@morndo/domain";
  import type { LiveFeed } from "../feed.svelte.ts";
  import { renderMarkdown } from "../markdown.ts";
  import { present, withoutFileNotes } from "../desktop/present.ts";

  let { feed, worker, name, focus }: { feed: LiveFeed; worker: string; name: string; focus: string | null } = $props();

  $effect(() => { feed.watch(worker); });
  const loaded = $derived(feed.historyFor === worker);
  // Consecutive tool calls fold into one row with their count (review of PR #7, finding 11).
  const messages = $derived.by(() => {
    if (!loaded) return [];
    const out: Message[] = [];
    for (const m of present(feed.messages, { show: "clean", activity: true })) {
      const prev = out.at(-1);
      if (m.kind === "activity" && prev?.kind === "activity" && m.id !== focus && prev.id !== focus) out[out.length - 1] = { ...prev, tools: [...(prev.tools ?? []), ...(m.tools ?? [])] };
      else out.push(m);
    }
    return out;
  });
  const used = (tools: string[] = []) => `Used ${tools.length === 1 ? "1 tool" : `${tools.length} tools`}${tools.length ? `: ${[...new Set(tools)].slice(0, 3).join(", ")}` : ""}`;
  const found = $derived(focus !== null && messages.some(m => m.id === focus));
  let list = $state<HTMLOListElement | null>(null);
  let placed = false;
  $effect(() => {
    if (!loaded || placed || !list) return;
    placed = true;
    void tick().then(() => {
      const el = focus ? list?.querySelector<HTMLElement>(`[data-msg="${CSS.escape(focus)}"]`) : null;
      if (el) el.scrollIntoView({ block: "center" });
      else list?.lastElementChild?.scrollIntoView({ block: "end" });
    });
  });
  const clock = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
</script>

<section class="chat" aria-label="Conversation with {name}">
  <header>
    <div class="t"><b>{name}</b><span class="note">Reading here marks nothing as read.</span></div>
  </header>
  {#if !loaded}
    <p class="note pad">Loading the conversation…</p>
  {:else}
    {#if focus && !found}<p class="note pad">That message is older than what is loaded here.</p>{/if}
    <ol bind:this={list}>
      {#each messages as m (m.id)}
        <li data-msg={m.id} class:focus={m.id === focus} class:activity={m.kind === "activity"}>
          {#if m.kind === "activity"}
            <span class="note">{used(m.tools)}</span>
          {:else}
            <p class="who"><b>{m.author.kind === "principal" ? "You" : m.author.name}</b><time>{clock(m.at)}</time></p>
            {#if m.text}<div class="text">{@html renderMarkdown(m.author.kind === "principal" ? withoutFileNotes(m.text) : m.text)}</div>{/if}
            {#each m.attachments ?? [] as a, i (`${a.id ?? a.name}-${i}`)}
              {#if a.id}<a class="file" href="/api/files/{a.id}" target="_blank" rel="noopener">{a.name}</a>{:else if a.pending}<span class="note">{a.name}: copying…</span>{:else}<span class="note">{a.name}: not available</span>{/if}
            {/each}
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .chat { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 8px; padding: 4px 20px 10px; border-bottom: 1px solid var(--line); }
  .t { display: grid; }
  .t b { font: 700 16px/20px var(--body); }
  .pad { padding: 12px 20px; }
  ol { flex: 1; min-height: 0; overflow-y: auto; list-style: none; margin: 0; padding: 8px 0 24px; }
  li { padding: 8px 20px; }
  li.focus { background: var(--fill); }
  li.focus .note, li.focus time { color: var(--fg); }
  .who { margin: 0; display: flex; gap: 6px; align-items: baseline; }
  .who b { font: 700 14px/20px var(--body); }
  time { font: 400 12px/20px var(--body); color: var(--muted); }
  .text { font: 400 14.5px/21px var(--body); overflow-wrap: anywhere; }
  .text :global(p) { margin: 0 0 6px; }
  .text :global(pre) { white-space: pre-wrap; font: 12.5px/18px var(--mono); background: var(--fill); color: var(--fg); padding: 6px 8px; border-radius: 8px; }
  .file { display: inline-flex; align-items: center; min-height: 44px; color: var(--fg); font-weight: 700; }
</style>
