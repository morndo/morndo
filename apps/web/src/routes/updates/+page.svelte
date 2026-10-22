<script lang="ts">
  // Updates (updates design §8.2 "Settings → Updates", PR 6c part 2): every machine's Version, Channel, mode and
  // state — the control plane first ("This machine"), then the nodes — with "Update now", "Roll back" and "Resume",
  // each a principal Command with step-up (AC7). The view is the hub's answer (GET /api/updates); the words are
  // lib/updates.ts's, the hub's own message shows as it came when it refuses.
  import "$lib/phone/phone.css";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import type { UpdatesView } from "@morndo/protocol";
  import { api, ApiError, explain } from "$lib/api.ts";
  import { withStepUp } from "$lib/stepup.ts";
  import { rolloutLine, updatesRows, type UpdatesRow } from "$lib/updates.ts";

  type Page = { kind: "loading" } | { kind: "off" } | { kind: "failed"; message: string } | { kind: "ready" };
  let page = $state<Page>({ kind: "loading" });
  let view = $state<UpdatesView | null>(null);
  let busy = $state(false);
  let confirming = $state<string | null>(null);        // the machine whose Roll back is asked about, as the devices page asks about a revoke
  let notice = $state("");
  let problem = $state<string | null>(null);

  const rows = $derived(view !== null ? updatesRows(view) : []);
  const line = $derived(view !== null ? rolloutLine(view.rollout, Date.now()) : null);

  async function load() {
    try {
      view = await api.get<UpdatesView>("/api/updates");
      problem = null;
      page = { kind: "ready" };
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return void goto("/");
      if (e instanceof ApiError && e.code === "updates_off") { page = { kind: "off" }; return; }
      page = { kind: "failed", message: explain(e) };
    }
  }

  // Every action goes through withStepUp: the hub answers 403 step_up until the passkey check is fresh, then the
  // command runs once more. Whatever it answers, the view loads again after.
  async function run(sentence: string, post: () => Promise<unknown>): Promise<void> {
    busy = true; notice = ""; problem = null;
    try {
      await post();
      notice = sentence;
      confirming = null;
      await load();
    } catch (e) {
      problem = refusal(e);
    } finally {
      busy = false;
    }
  }

  const apply = (row: UpdatesRow) =>
    run(`Asked ${row.machine === "control-plane" ? "this machine" : row.title} to take ${row.apply}.`,
      () => withStepUp(() => api.post("/api/updates/apply", { machine: row.machine, version: row.apply }), () => {}));
  const rollback = (row: UpdatesRow) =>
    run(`Asked this machine to roll back to ${row.rollback}.`,
      () => withStepUp(() => api.post("/api/updates/rollback", { machine: row.machine }), () => {}));
  const resume = (version: string) =>
    run(`Resumed the Rollout of ${version}.`,
      () => withStepUp(() => api.post("/api/updates/resume", { version }), () => {}));

  function refusal(e: unknown): string {
    if (!(e instanceof ApiError)) return explain(e);
    const message = typeof e.data.message === "string" ? e.data.message : "";
    // A step-up that already ran once and still refuses: this endpoint may not command.
    if (e.code === "step_up") return "A fresh passkey check wasn't enough — this device may not run commands.";
    // The fleet's (or the updater's) own words, as they came.
    if (e.status === 409) return message || `The hub refused: ${e.code}.`;
    if (e.status === 503) return message === "" ? "The fleet or the updater could not be asked." : `The fleet or the updater could not be asked: ${message}`;
    if (e.status === 404) return "Updates aren't available on this hub.";
    return explain(e);
  }

  onMount(load);
</script>

<div class="phone updates">
  <header class="top">
    <div class="in">
      <a class="back" href="/" aria-label="Back to Morndo"><ChevronLeft size={24} /></a>
      <div>
        <h1>Updates</h1>
        <p class="sum">Every machine's Version. Channel and mode are set with <code>morndo update</code> on the machine for now.</p>
      </div>
    </div>
  </header>

  <main class="body">
    {#if page.kind === "loading"}
      <p class="note">Asking the machines…</p>
    {:else if page.kind === "off"}
      <section class="card">
        <h2>Updates aren't available on this hub</h2>
        <p class="note">This hub has no fleet to ask and no updater CLI of its own, so it cannot show the machines here.</p>
      </section>
    {:else if page.kind === "failed"}
      <p class="err" role="alert">{page.message}</p>
      <button class="pbtn" onclick={load}>Try again</button>
    {:else if view}
      {#if line}
        <section class="card" data-rollout>
          <h2>Rollout {line.version}</h2>
          <p class="note halt">{line.sentence}</p>
          {#if line.resume}
            <button class="pbtn small" onclick={() => resume(line.version)} disabled={busy}>Resume</button>
          {/if}
        </section>
      {:else}
        <section class="card" data-rollout>
          <h2>No Rollout in flight</h2>
          <p class="note">Each machine follows its own checks.</p>
        </section>
      {/if}

      <ul class="machines">
        {#each rows as row (row.machine)}
          <li class="card" data-machine={row.machine}>
            <h2>{row.title}</h2>
            <p class="state">{row.state}</p>
            <p class="note">
              Version {row.version ?? "unknown"} ·
              {#if row.channel !== null}Channel {row.channel} · mode {row.mode}{:else}Channel and mode unknown here{/if}
            </p>
            <div class="acts">
              {#if row.apply !== null}
                <button class="pbtn small primary" onclick={() => apply(row)} disabled={busy}>Update now</button>
              {/if}
              {#if row.rollback !== null}
                {#if confirming === row.machine}
                  <span class="confirm">
                    Roll back to {row.rollback}?
                    <button class="pbtn small" onclick={() => rollback(row)} disabled={busy}>Roll back</button>
                    <button class="pbtn small" onclick={() => (confirming = null)}>Keep</button>
                  </span>
                {:else}
                  <button class="pbtn small" onclick={() => { confirming = row.machine; notice = ""; problem = null; }}>Roll back…</button>
                {/if}
              {/if}
              {#if row.rollbackNote !== null}<span class="note">{row.rollbackNote}</span>{/if}
            </div>
          </li>
        {/each}
      </ul>

      {#if notice}<p class="ok" role="status">{notice}</p>{/if}
      {#if problem}<p class="err" role="alert">{problem}</p>{/if}
    {/if}
  </main>
</div>

<style>
  .updates { min-height: 100dvh; }
  .top {
    position: sticky; top: 0; z-index: 2; background: var(--bg); border-bottom: 1px solid var(--line);
    padding: calc(var(--safe-top) + 10px) max(16px, var(--safe-right)) 12px max(8px, var(--safe-left));
  }
  /* The header's content lines up with the cards on a wide screen: the same 46rem column, the back arrow just outside. */
  .in { max-width: calc(46rem + 52px); margin: 0 auto; display: flex; align-items: flex-start; gap: 6px; padding-right: 52px; }
  @media (max-width: 899px) { .in { padding-right: 0; } }
  .in div { flex: 1; min-width: 0; }
  .back { flex: none; width: 44px; height: 44px; display: grid; place-items: center; color: var(--fg); border-radius: 12px; }
  h1 { margin: 0; font: 700 28px/34px var(--display); }
  .sum { margin: 2px 0 0; font: 400 14px/20px var(--body); color: var(--muted); }
  .sum code { font-family: var(--mono); font-size: 13px; }
  .body {
    width: 100%; max-width: 46rem; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px;
    padding: 16px max(16px, var(--safe-right)) 120px max(16px, var(--safe-left));
  }
  .card { display: grid; gap: 8px; padding: 16px; border-radius: 18px; background: var(--surface); box-shadow: var(--card-shadow); }
  .card h2 { margin: 0; font: 700 19px/24px var(--display); }
  .machines { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
  .state { margin: 0; font: 400 15px/21px var(--body); }
  .acts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font: 400 14px/20px var(--body); }
  .halt { color: var(--bad-text); }
  .ok { margin: 0; font: 400 14px/20px var(--body); color: var(--ok-text); }
</style>
