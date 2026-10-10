<script lang="ts">
  // Engines (ADR-0013): per role, which provider and model does the work and what falls back, as the engine layer's
  // CLI holds it. The page edits a draft with the domain's rules; Save sends only what changed, with the version it
  // was read at, after a fresh passkey check when the step-up window has passed (a save is a Command, AC7).
  import "$lib/phone/phone.css";
  import { onMount } from "svelte";
  import { beforeNavigate, goto } from "$app/navigation";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import { changesBetween, type RoleEngines } from "@morndo/domain";
  import { CONNECTION_WORDS, type EnginesView } from "@morndo/protocol";
  import { api, ApiError, explain } from "$lib/api.ts";
  import { withStepUp } from "$lib/stepup.ts";
  import ConnectionsBoard from "$lib/connections/ConnectionsBoard.svelte";
  import RoleCard from "$lib/engines/RoleCard.svelte";
  import { availabilityWords, engineWords, problemWords, providerName } from "$lib/engines/words.ts";

  type Page = { kind: "loading" } | { kind: "off" } | { kind: "failed"; message: string } | { kind: "ready" };
  let page = $state<Page>({ kind: "loading" });
  let saved = $state<EnginesView | null>(null);
  let draft = $state<RoleEngines[]>([]);
  let saving = $state(false);
  let notice = $state("");
  let problem = $state<{ text: string; reload?: boolean } | null>(null);
  const changes = $derived(saved ? changesBetween(saved.roles, draft) : []);
  const changedRoles = $derived(new Set(changes.map(c => c.role)));

  // A plain deep copy to edit: $state.snapshot clones arrays and plain objects, proxied or not (svelte 5.57.1,
  // src/internal/shared/clone.js; svelte.dev/docs/svelte/$state, read 2026-10-07).
  const copy = (v: EnginesView): RoleEngines[] => ($state.snapshot(v.roles) as EnginesView["roles"]).map(({ now: _, ...r }) => r);

  async function load() {
    try {
      const v = await api.get<EnginesView>("/api/engines");
      saved = v; draft = copy(v); problem = null; page = { kind: "ready" };
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return void goto("/");
      if (e instanceof ApiError && e.code === "engines_off") { page = { kind: "off" }; return; }
      if (e instanceof ApiError && e.code === "unsupported" && typeof e.data.message === "string") { page = { kind: "failed", message: e.data.message }; return; }
      page = { kind: "failed", message: e instanceof ApiError && typeof e.data.message === "string" ? `The engines CLI didn't answer: ${e.data.message}` : explain(e) };
    }
  }

  async function save() {
    if (!saved || !changes.length) return;
    saving = true; notice = ""; problem = null;
    try {
      const body = { version: saved.version, changes };
      const v = await withStepUp(() => api.post<EnginesView>("/api/engines", body), () => {});
      saved = v; draft = copy(v);
      notice = "Saved. New tasks use it; lanes already running keep their engine.";
    } catch (e) {
      problem = refusal(e);
    } finally {
      saving = false;
    }
  }

  function refusal(e: unknown): { text: string; reload?: boolean } {
    if (!(e instanceof ApiError)) return { text: explain(e) };
    const role = typeof e.data.role === "string" ? saved?.roles.find(r => r.role === e.data.role)?.label ?? e.data.role : null;
    const message = typeof e.data.message === "string" ? e.data.message : "";
    if (e.code === "changed") return { text: "The engines were changed elsewhere (in the terminal or by the manager) since this page loaded. Reload to see them, then make your change again.", reload: true };
    if (e.code === "refused") return { text: `The engines CLI refused ${role ?? "it"}: ${message}${Array.isArray(e.data.saved) && e.data.saved.length ? ` (saved before it: ${e.data.saved.join(", ")})` : ""}`, reload: true };
    if (e.code === "unavailable") return { text: `The engines CLI didn't answer: ${message}`, reload: true };
    if (e.code === "unsupported") return { text: message };
    if (e.code === "duplicate" && role && typeof e.data.engine === "string") {
      return { text: `${role}: ${engineWords(e.data.engine, saved?.providers ?? [])} is in this list twice. Remove one copy.` };
    }
    if (e.status === 400 && role) return { text: `${role}: ${problemWords(e.code)}` };
    return { text: explain(e) };
  }

  function discard() { if (saved) { draft = copy(saved); problem = null; notice = ""; } }
  const edit = (i: number) => (next: RoleEngines) => { draft[i] = next; notice = ""; };

  // Unsaved changes: leaving within the app asks first; closing or reloading the tab gets the browser's own prompt,
  // which cancel() triggers for a "leave" navigation (beforeNavigate in @sveltejs/kit 2.70.3's types/index.d.ts and
  // svelte.dev/docs/kit/$app-navigation, read 2026-10-07; mobile browsers may not show it, MDN beforeunload).
  beforeNavigate(nav => {
    if (!changes.length) return;
    if (nav.type === "leave" || !confirm("Leave without saving your engine changes?")) nav.cancel();
  });
  onMount(() => void load());
</script>

<div class="phone engines">
  <header class="top">
    <div class="in">
      <a class="back" href="/" aria-label="Back to Morndo"><ChevronLeft size={24} /></a>
      <div>
        <h1>{CONNECTION_WORDS.title}</h1>
        <p class="sum">Which AI does each role's work. The first one that's available runs; the others are fallbacks, in order.</p>
      </div>
    </div>
  </header>

  <main class="body">
    <ConnectionsBoard />
    {#if page.kind === "loading"}
      <p class="note">Asking the engines…</p>
    {:else if page.kind === "off"}
      <section class="card">
        <h2>Engines aren't connected</h2>
        <p>This hub doesn't know where the engine layer's CLI is. Set <code>MORNDO_ENGINES</code> to its <code>bin/engines</code> and restart the hub.</p>
      </section>
    {:else if page.kind === "failed"}
      <p class="err" role="alert">{page.message}</p>
      <button class="pbtn" onclick={load}>Try again</button>
    {:else if saved}
      {#if !saved.enabled}
        <p class="banner">Engine lanes are switched off on this box, so lanes still run on Claude as before. These choices apply once they're switched on.</p>
      {/if}

      <section class="providers" aria-labelledby="providers">
        <h2 class="kicker" id="providers">Providers</h2>
        <ul aria-label="Providers">
          {#each saved.providers as p (p.name)}
            {@const a = availabilityWords(p)}
            <li>
              <span class="pname"><b>{providerName(p)}</b>{#if p.kind === "studio"}<span class="note">via the studio lane</span>{/if}</span>
              <span class="chip {a.tone}">{a.word}</span>
            </li>
          {/each}
        </ul>
      </section>

      <h2 class="kicker">Roles</h2>
      {#each draft as r, i (r.role)}
        {@const savedRole = saved.roles.find(x => x.role === r.role)}
        <RoleCard role={r} changed={changedRoles.has(r.role)} now={savedRole?.now ?? { engine: null, skipped: [] }}
          providers={saved.providers} onChange={edit(i)} />
      {/each}
    {/if}
  </main>

  {#if page.kind === "ready"}
    <footer class="savebar" class:open={changes.length > 0 || notice || problem}>
      <div class="msg">
        <p role="status" aria-live="polite">{#if notice}{notice}{:else if changes.length}{changes.length === 1 ? "1 role changed" : `${changes.length} roles changed`}{/if}</p>
        {#if problem}<p class="err" role="alert">{problem.text}</p>{/if}
      </div>
      {#if problem?.reload}<button class="pbtn small" onclick={load}>Reload</button>{/if}
      {#if changes.length}
        <button class="pbtn small" onclick={discard} disabled={saving}>Discard</button>
        <button class="pbtn small primary" onclick={save} disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
      {/if}
    </footer>
  {/if}
</div>

<style>
  .engines { min-height: 100dvh; }
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
  .body {
    width: 100%; max-width: 46rem; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px;
    padding: 16px max(16px, var(--safe-right)) 120px max(16px, var(--safe-left));
  }
  .kicker { margin-top: 6px; }
  .banner { margin: 0; padding: 12px 14px; border-radius: 14px; background: var(--warn-soft); color: var(--warn-text); font: 400 14px/20px var(--body); }
  .card { display: grid; gap: 8px; padding: 16px; border-radius: 18px; background: var(--surface); box-shadow: var(--card-shadow); }
  .card h2 { margin: 0; font: 700 19px/24px var(--display); }
  .providers ul { list-style: none; margin: 6px 0 0; padding: 0; border-radius: 18px; background: var(--surface); box-shadow: var(--card-shadow); overflow: hidden; }
  .providers li { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 8px 16px; border-bottom: 1px solid var(--line); }
  .providers li:last-child { border-bottom: 0; }
  .pname { flex: 1; min-width: 0; display: grid; }
  .pname b { font: 700 15px/20px var(--body); }
  .savebar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 4; display: none; flex-wrap: wrap; align-items: center; gap: 8px;
    padding: 10px max(16px, var(--safe-right)) max(10px, var(--safe-bottom)) max(16px, var(--safe-left));
    background: var(--surface); border-top: 1px solid var(--line); box-shadow: 0 -10px 30px -20px rgb(0 0 0 / 0.35);
  }
  .savebar.open { display: flex; }
  .msg { flex: 1 1 100%; min-width: 0; display: grid; gap: 2px; }
  .msg p { margin: 0; font: 400 14px/20px var(--body); }
  .savebar .pbtn { flex: 1; }
  @media (min-width: 640px) { .msg { flex-basis: 12rem; } .savebar .pbtn { flex: none; } }
  @media (min-width: 900px) {
    .savebar { left: 50%; right: auto; bottom: 16px; width: min(46rem, calc(100% - 32px)); transform: translateX(-50%); border: 1px solid var(--line); border-radius: 16px; }
  }
</style>
