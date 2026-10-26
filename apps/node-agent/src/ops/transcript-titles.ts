// The topic and the last prompt of a Claude Code session (RECONCILIATION.md ruling 13; README §5): its transcript's latest
// `ai-title` entry (`aiTitle`, as the hub reads it, apps/hub/src/adapters/claude-sessions.ts) and latest `last-prompt`
// entry (`lastPrompt`; a last-prompt without one is skipped, ruling 56), which kira shows in its Overview and Mini App. Each is cut to 200 characters, so
// 64 panes still fit one inventory message.
// - A tail scan, cached per session: the first read of a session reads its transcript's last 4 MiB, and each later read
//   only what was appended since the last whole line it saw. An inventory read every 2 s costs a stat for a transcript
//   that didn't grow.
// - A transcript that got shorter (rewritten) is scanned again from its tail. One that grew by more than the tail is
//   scanned from its tail too, keeping what was known until a newer entry shows. One that can't be read keeps what was
//   known.
// - An ai-title further back than the tail isn't seen until Claude Code writes a new one (open question 4).
import { open, type FileHandle } from "node:fs/promises";

export type Titles = { topic: string | null; lastPrompt: string | null };
type Seen = Titles & { size: number };

const TAIL_BYTES = 4 << 20;
const TEXT_MAX = 200;
const NONE: Titles = { topic: null, lastPrompt: null };

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

// The latest of each entry in these whole lines. A line that names neither kind is never parsed.
function scan(text: string, into: Titles): void {
  for (const line of text.split("\n")) {
    if (!line.includes("\"ai-title\"") && !line.includes("\"last-prompt\"")) continue;
    let e: unknown;
    try { e = JSON.parse(line); } catch { continue; }
    if (e === null || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (o.type === "ai-title" && typeof o.aiTitle === "string") into.topic = o.aiTitle.slice(0, TEXT_MAX);
    if (o.type === "last-prompt" && typeof o.lastPrompt === "string") into.lastPrompt = o.lastPrompt.slice(0, TEXT_MAX);
  }
}

export class TranscriptTitles {
  #path: (sessionId: string) => string | null;
  #seen = new Map<string, Seen>();

  constructor(transcriptPath: (sessionId: string) => string | null) { this.#path = transcriptPath; }

  async read(sessionId: string): Promise<Titles> {
    const was = this.#seen.get(sessionId);
    const known = (): Titles => (was ? { topic: was.topic, lastPrompt: was.lastPrompt } : NONE);
    const path = this.#path(sessionId);
    if (path === null) return known();
    let fh: FileHandle;
    try { fh = await open(path, "r"); } catch { return known(); }
    try {
      const size = (await fh.stat()).size;
      if (was !== undefined && was.size === size) return known();
      const kept = was !== undefined && was.size < size ? was : null;        // it grew: what was known still holds
      const grew = kept !== null && size - kept.size <= TAIL_BYTES;
      const from = kept !== null && grew ? kept.size : Math.max(0, size - TAIL_BYTES);
      const buf = await readAt(fh, from, size - from);
      const end = buf.lastIndexOf(0x0a);
      const next: Seen = { ...(kept ?? NONE), size: from };
      if (end !== -1) {
        let text = buf.subarray(0, end).toString("utf8");
        if (!grew && from > 0) text = text.slice(text.indexOf("\n") + 1);   // the tail's first line is a part of one
        scan(text, next);
        next.size = from + end + 1;
      }
      this.#seen.set(sessionId, next);
      return { topic: next.topic, lastPrompt: next.lastPrompt };
    } catch {
      return known();
    } finally {
      await fh.close();
    }
  }
}
