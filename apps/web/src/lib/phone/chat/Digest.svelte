<script lang="ts">
  // The digest after he was away (ADR-0011, H5), Slack's recap idea for agents: one screen, one line per lane that spoke
  // or needs him, sorted needs you, blocked, finished, then the rest; the manager first. Decisions keep their cards: a
  // button opens them. "Mark all read" moves each lane's Read mark to the last message covered; "Later" keeps them
  // unread and leaves the digest on the chat list.
  import X from "@lucide/svelte/icons/x";
  import { digestLines, type DigestLine, type RosterEntry } from "@morndo/domain";
  import type { CatchUpConversationWire } from "@morndo/protocol";
  import type { DecisionItem } from "../../desktop/decisions.ts";
  import { spanLabel } from "../words.ts";
  import { MANAGER, displayName, plain } from "./rows.ts";

  let { since, until, data, workers, decisions, muted, waiting, onOpen, onDecide, onMarkRead, onLater }: {
    since: number; until: number; data: CatchUpConversationWire[] | null; workers: readonly RosterEntry[]; decisions: readonly DecisionItem[];
    muted: readonly string[]; waiting: number;
    onOpen: (worker: string) => void; onDecide: () => void; onMarkRead: (lines: DigestLine[]) => void; onLater: () => void;
  } = $props();

  // The lanes that spoke (from the hub's digest), and those that need him now without having spoken.
  const lines = $derived.by(() => {
    if (!data) return [];
    const spoke = new Map(data.map(c => [c.worker as string, c]));
    const convs = workers.filter(w => spoke.has(w.id) || (!muted.includes(w.name) && (w.needsYou || decisions.some(d => d.status === "open" && d.asker.workerId === w.id)))).map(w => {
      const c = spoke.get(w.id);
      return {
        worker: w.id, name: w.name, messages: c?.messages ?? [], needsYou: w.needsYou, tools: c?.tools ?? 0, files: c?.files ?? 0, lastAt: c?.lastAt ?? null,
        asks: decisions.filter(d => d.status === "open" && d.asker.workerId === w.id).map(d => d.shortTitle ?? d.title),
      };
    });
    return digestLines(convs, MANAGER);
  });
  const hm = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const KIND = { needs_you: "Needs you", blocked: "Blocked", finished: "Finished", working: "Update" } as const;
  function say(l: DigestLine): string {
    if (l.kind === "needs_you") return l.ask ? plain(l.ask) : l.answer ? plain(l.answer.text) : "Waits at a prompt on its screen.";
    return l.answer ? plain(l.answer.text, 140) : "Worked without a word for you.";
  }
  function counts(l: DigestLine): string {
    const out = [l.count === 1 ? "1 message" : `${l.count} messages`];
    if (l.tools) out.push(l.tools === 1 ? "1 tool use" : `${l.tools} tool uses`);
    if (l.files) out.push(l.files === 1 ? "1 file" : `${l.files} files`);
    if (l.lastAt) out.push(`last at ${hm(l.lastAt)}`);
    return out.join(" · ");
  }
</script>

<section class="digest" aria-label="While you were away">
  <header class="top">
    <div>
      <p class="kicker">While you were away</p>
      <h1>{spanLabel(until - since)} since {hm(since)}</h1>
    </div>
    <button class="icon" onclick={onLater} aria-label="Close, keep unread"><X size={22} /></button>
  </header>
  <div class="body">
    {#if waiting}
      <button class="pbtn primary decide" onclick={onDecide}>{waiting === 1 ? "1 decision waits for you" : `${waiting} decisions wait for you`} · Decide</button>
    {/if}
    {#if !data}
      <p class="note">Asking the hub what happened…</p>
    {:else if !lines.length}
      <p class="note">Nothing happened in the lanes while you were away.</p>
    {:else}
      <ul>
        {#each lines as l (l.worker)}
          <li>
            <button class="line {l.kind}" data-digest={l.name} onclick={() => onOpen(l.worker)}>
              <span class="head"><b>{displayName(l.name)}</b><span class="chip" class:bad={l.kind === "needs_you"} class:warn={l.kind === "blocked"}>{KIND[l.kind]}</span></span>
              <span class="say">{say(l)}</span>
              <span class="note">{counts(l)}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  <footer>
    <button class="pbtn" onclick={onLater}>Later</button>
    <button class="pbtn primary" disabled={!data} onclick={() => onMarkRead(lines)}>Mark all read</button>
  </footer>
</section>

<style>
  .digest { position: fixed; inset: 0; z-index: 6; display: flex; flex-direction: column; background: var(--bg); }
  .top { display: flex; align-items: flex-start; gap: 12px; padding: calc(var(--safe-top) + 14px) max(16px, var(--safe-right)) 10px max(16px, var(--safe-left)); border-bottom: 1px solid var(--line); }
  .top div { flex: 1; }
  h1 { margin: 2px 0 0; font: 700 24px/30px var(--display); }
  .icon { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; border: 1px solid var(--edge); background: transparent; color: var(--fg); cursor: pointer; }
  .body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px max(12px, var(--safe-right)) 12px max(12px, var(--safe-left)); }
  .decide { width: 100%; margin-bottom: 12px; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .line {
    width: 100%; display: grid; gap: 4px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface);
    color: var(--fg); text-align: left; cursor: pointer; box-shadow: var(--card-shadow);
  }
  .line.needs_you { border: 2px solid var(--bad); }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .head b { font: 700 16px/22px var(--body); }
  .say { font: 400 15px/21px var(--body); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  footer { display: grid; grid-template-columns: 1fr 1.4fr; gap: 10px; padding: 10px max(12px, var(--safe-right)) max(12px, var(--safe-bottom)) max(12px, var(--safe-left)); border-top: 1px solid var(--line); background: var(--surface); }
</style>
