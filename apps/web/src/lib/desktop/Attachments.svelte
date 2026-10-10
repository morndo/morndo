<script lang="ts">
  // Files in a message, the way Slack shows them: images inline (click for full size), video and audio with players,
  // text and Markdown with a preview, PDFs to open, anything else as a file card to download. Each comes from the hub's
  // own copy (/api/files/<id>); one still being copied shows as copying, and a file the hub couldn't keep as not available.
  import Download from "@lucide/svelte/icons/download";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import FileIcon from "@lucide/svelte/icons/file";
  import FileCode from "@lucide/svelte/icons/file-code";
  import FileImage from "@lucide/svelte/icons/file-image";
  import FileMusic from "@lucide/svelte/icons/file-music";
  import FilePlay from "@lucide/svelte/icons/file-play";
  import FileText from "@lucide/svelte/icons/file-text";
  import ImageOff from "@lucide/svelte/icons/image-off";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import X from "@lucide/svelte/icons/x";
  import type { Attachment } from "@morndo/domain";
  import { renderMarkdown } from "../markdown.ts";

  let { attachments }: { attachments: Attachment[] } = $props();

  const url = (a: Attachment, download = false) => `/api/files/${a.id}${download ? "?download=1" : ""}`;
  const size = (n: number | null) => (n === null ? "" : n < 1024 ? `${n} B` : n < 1 << 20 ? `${Math.round(n / 1024)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);
  const label = (a: Attachment) => {
    const ext = a.name.includes(".") ? a.name.split(".").pop()?.toUpperCase() : "";
    return [a.kind === "pdf" ? "PDF" : ext || "File", size(a.size)].filter(Boolean).join(" · ");
  };
  const ICON = { image: FileImage, video: FilePlay, audio: FileMusic, pdf: FileText, text: FileCode, file: FileIcon } as const;

  let viewing = $state<Attachment | null>(null);
  let previews = $state<Record<string, { text: string; cut: boolean } | "error">>({});
  let open = $state<Record<string, boolean>>({});
  const PREVIEW_BYTES = 200_000;
  const isMarkdown = (a: Attachment) => /\.(md|markdown)$/i.test(a.name);

  // Text files: fetched once (the hub serves them as text/plain), shown folded until opened.
  $effect(() => {
    for (const a of attachments) {
      if (a.kind !== "text" || !a.id || previews[a.id]) continue;
      const id = a.id;
      fetch(url(a), { credentials: "same-origin" })
        .then(r => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
        .then(t => { previews[id] = { text: t.slice(0, PREVIEW_BYTES), cut: t.length > PREVIEW_BYTES }; })
        .catch(() => { previews[id] = "error"; });
    }
  });
</script>

<svelte:window onkeydown={e => { if (viewing && e.key === "Escape") { e.preventDefault(); viewing = null; } }} />

<div class="files">
  {#each attachments as a, i (`${a.id ?? a.name}-${i}`)}
    <figure class="att {a.kind}" class:gone={!a.id}>
      {#if a.pending}
        <div class="card">
          <span class="ico muted"><LoaderCircle size={20} /></span>
          <span class="meta"><strong>{a.name}</strong><small>Copying from its machine…</small></span>
        </div>
      {:else if !a.id}
        <div class="card">
          <span class="ico muted"><ImageOff size={20} /></span>
          <span class="meta"><strong>{a.name}</strong><small>Not available: the file was gone, too big, or in a private place</small></span>
        </div>
      {:else if a.kind === "image"}
        <button class="img" onclick={() => (viewing = a)} aria-label="Open {a.name}" title={a.name}>
          <img src={url(a)} alt={a.caption ?? a.name} loading="lazy" decoding="async" />
        </button>
      {:else if a.kind === "video"}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video class="media" controls preload="metadata" src={url(a)}></video>
      {:else if a.kind === "audio"}
        <audio class="audio" controls preload="none" src={url(a)}></audio>
      {:else}
        {@const Icon = ICON[a.kind]}
        <div class="card">
          <span class="ico {a.kind}"><Icon size={20} /></span>
          <span class="meta"><strong>{a.name}</strong><small>{label(a)}</small></span>
          <span class="acts">
            {#if a.kind === "text"}
              <button class="ab" onclick={() => (open[a.id ?? ""] = !open[a.id ?? ""])} aria-expanded={!!open[a.id ?? ""]}>{open[a.id ?? ""] ? "Hide" : "Preview"}</button>
            {/if}
            {#if a.kind === "pdf"}<a class="ab" href={url(a)} target="_blank" rel="noopener" title="Open in a new tab"><ExternalLink size={14} />Open</a>{/if}
            <a class="ab icon" href={url(a, true)} download={a.name} aria-label="Download {a.name}" title="Download"><Download size={15} /></a>
          </span>
        </div>
        {#if a.kind === "text" && a.id && open[a.id]}
          {@const p = previews[a.id]}
          <div class="preview">
            {#if p === "error"}<p class="muted">The preview couldn't be loaded.</p>
            {:else if !p}<p class="muted">Loading…</p>
            {:else if isMarkdown(a)}<div class="md">{@html renderMarkdown(p.text)}</div>
            {:else}<pre>{p.text}</pre>{/if}
            {#if p && p !== "error" && p.cut}<p class="muted">Only the first 200 KB are shown; download it for the rest.</p>{/if}
          </div>
        {/if}
      {/if}
      {#if a.caption}<figcaption>{a.caption}</figcaption>{/if}
    </figure>
  {/each}
</div>

{#if viewing}
  <div class="viewer" role="dialog" aria-modal="true" aria-label={viewing.name} tabindex="-1" onclick={e => { if (e.target === e.currentTarget) viewing = null; }} onkeydown={() => {}}>
    <header>
      <strong>{viewing.name}</strong>{#if viewing.size}<small>{size(viewing.size)}</small>{/if}
      <a class="vb" href={url(viewing, true)} download={viewing.name} aria-label="Download {viewing.name}"><Download size={18} /></a>
      <button class="vb" onclick={() => (viewing = null)} aria-label="Close"><X size={20} /></button>
    </header>
    <img src={url(viewing)} alt={viewing.caption ?? viewing.name} />
    {#if viewing.caption}<p>{viewing.caption}</p>{/if}
  </div>
{/if}

<style>
  .files { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 2px; }
  .att { margin: 0; display: grid; gap: 4px; max-width: 100%; }
  .att.text, .att.pdf, .att.file, .att.gone { flex-basis: 100%; }
  .img { padding: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--code-bg); cursor: zoom-in; display: block; }
  .img img { display: block; max-width: min(360px, 100%); max-height: 300px; object-fit: contain; }
  .img:hover { border-color: var(--border-strong); }
  .media { max-width: min(480px, 100%); max-height: 320px; border-radius: 8px; background: #000; }
  .audio { width: min(360px, 100%); }
  /* A file card is a surface of its own: on a tinted row (a hovered message) its muted text stays muted (COLOR.md 8). */
  .card { --muted: var(--morndo-text-muted); display: flex; align-items: center; gap: 12px; width: min(420px, 100%); padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--main-bg); }
  .ico { width: 40px; height: 40px; border-radius: 8px; display: grid; place-items: center; flex: none; color: var(--main-bg); background: var(--text); }
  .ico.muted { background: var(--muted-bg); color: var(--text); }
  .meta { display: grid; min-width: 0; flex: 1; }
  .meta strong { font: 700 15px/20px var(--font); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta small { font: 400 13px/18px var(--font); color: var(--muted); }
  .acts { display: flex; gap: 6px; flex: none; }
  .ab { display: inline-flex; align-items: center; gap: 5px; height: 28px; min-height: 28px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--outline); background: var(--main-bg); color: var(--text); font: 700 13px/1 var(--font); cursor: pointer; text-decoration: none; }
  .ab:hover { background: var(--row-hover); }
  .ab.icon { width: 28px; padding: 0; justify-content: center; }
  .preview { width: min(640px, 100%); max-height: 360px; overflow: auto; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--pre-bg); }
  .preview pre { margin: 0; font: 12px/18px var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); }
  .preview .md { font: 400 14px/21px var(--font); overflow-wrap: anywhere; }
  .preview .md :global(h1), .preview .md :global(h2), .preview .md :global(h3) { font: 900 15px/22px var(--font); margin: 8px 0 2px; }
  .preview .md :global(p) { margin: 0 0 6px; }
  .preview .md :global(code) { font: 12px/18px var(--mono); padding: 1px 3px; border-radius: 3px; background: var(--code-bg); border: 1px solid var(--code-border); }
  .preview .md :global(a) { color: var(--link); }
  .preview .md :global(table) { border-collapse: collapse; font-size: 13px; }
  .preview .md :global(th), .preview .md :global(td) { border: 1px solid var(--border); padding: 3px 6px; }
  .muted { margin: 0; color: var(--muted); font: 400 13px/18px var(--font); }
  figcaption { font: 400 13px/18px var(--font); color: var(--muted); max-width: 420px; }
  .viewer { position: fixed; inset: 0; z-index: 80; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; place-items: center; padding: 16px; background: color-mix(in srgb, var(--morndo-neutral-950) 88%, transparent); }
  .viewer header { width: 100%; display: flex; align-items: center; gap: 10px; color: #fff; }
  .viewer header strong { font: 700 15px/20px var(--font); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .viewer header small { color: rgba(255, 255, 255, 0.7); font: 400 13px/1 var(--font); }
  .vb { margin-left: auto; width: 36px; height: 36px; min-height: 36px; border: 0; border-radius: 8px; background: transparent; color: #fff; display: grid; place-items: center; cursor: pointer; }
  .vb + .vb { margin-left: 0; }
  .vb:hover { background: rgba(255, 255, 255, 0.14); }
  .viewer img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 4px; background: #fff; }
  .viewer p { color: #fff; margin: 8px 0 0; font: 400 14px/20px var(--font); }
</style>
