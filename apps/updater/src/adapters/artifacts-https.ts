// The ArtifactStore over HTTPS (design §4.6, §6.1 step 2, §10.2 step 5): one download into the downloads directory,
// streamed to disk so an Artifact never sits whole in memory, capped at the size its Manifest names and stopped
// there — the server's content-length is a claim, not a fact; the signed Manifest is what the bytes are checked
// against later (RL1). The file is `<name>.part` until that check passes, 0600 in a 0700 directory (§5): a half-
// written release tree is nobody's business, and the name is the Manifest's own artifact name or a refusal.
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { FetchFailed, type ArtifactStore, type Download } from "../application/ports.ts";
import { httpsGet } from "./https-get.ts";

// A plain file name: what a Manifest calls an Artifact. It cannot start with a dot ("..", ".hidden") and admits no
// separator, so no name can walk out of the downloads directory.
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class HttpsArtifacts implements ArtifactStore {
  private readonly dir: string;
  private readonly ca: string | undefined;

  constructor(o: { dir: string; ca?: string }) {
    this.dir = o.dir;
    this.ca = o.ca;
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  }

  async fetch(url: string, o: { name: string; maxBytes: number; timeoutMs: number }): Promise<Download> {
    const path = this.part(o.name);
    // 0600 and truncated, before anything is fetched: a retry never appends to a previous attempt's bytes.
    const sink = createWriteStream(path, { flags: "w", mode: 0o600 });
    // A full disk or any write error must fail the fetch here — not hang it on a stream nobody is reading, and not
    // crash on an 'error' nobody hears: the sink's own failure races the transfer, and the loser is heard through
    // the race. (Promise.race settles both sides; the transfer that loses stops on its own timeout.)
    const broken = new Promise<never>((_, reject) => sink.once("error", error => { reject(error); }));
    try {
      const r = await Promise.race([
        httpsGet(url, { ...(this.ca === undefined ? {} : { ca: this.ca }), maxBytes: o.maxBytes, timeoutMs: o.timeoutMs, sink }),
        broken,
      ]);
      if (r.status === 404) throw new FetchFailed("status", `HTTP 404 from ${url}`);
      sink.end();
      await finished(sink);
      return { path, size: r.size, overLimit: r.overLimit, cut: r.cut };
    } finally {
      if (!sink.writableEnded) sink.destroy();
    }
  }

  discard(name: string): void {
    rmSync(this.part(name), { force: true });
  }

  private part(name: string): string {
    if (!PLAIN_NAME.test(name)) throw new Error(`not a plain file name: ${name}`);
    return join(this.dir, `${name}.part`);
  }
}
