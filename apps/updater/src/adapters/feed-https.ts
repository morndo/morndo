// The ReleaseFeed over HTTPS (design §4.6, §9.5–§9.6, §10.2): keys/<version>.json, <channel>.json and each Release's
// manifest.json, each with its .sig beside it, and nothing parsed — bytes and signatures are the Verifier's business
// (RL1), never the transport's. Every document is capped before it starts (§10.2 step 5): a Key set and a Feed at
// 64 KiB, a Manifest at the size its Feed entry names. A body that grew past its cap or that the wire cut short is
// refused outright: half a signed document is nothing the Feed ever vouched for.
import type { Channel } from "@morndo/domain";
import { FetchFailed, type ReleaseFeed, type Signed } from "../application/ports.ts";
import { httpsGet } from "./https-get.ts";

const DOC_CAP = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
// Two minutes for a whole document, every redirect hop included: these are small pages, and a host that dribbles
// one byte inside every idle window meets a wall here it cannot dribble past.
const DOC_DEADLINE_MS = 120_000;

export class HttpsFeed implements ReleaseFeed {
  private readonly base: string;
  private readonly ca: string | undefined;
  private readonly timeoutMs: number;
  private readonly deadlineMs: number;

  constructor(o: { base: string; ca?: string; timeoutMs?: number; deadlineMs?: number }) {
    // The CLI hands a base that ends in "/; a feed URL is joined, not parsed, so this stays a one-way detail.
    this.base = o.base.endsWith("/") ? o.base : `${o.base}/`;
    this.ca = o.ca;
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.deadlineMs = o.deadlineMs ?? DOC_DEADLINE_MS;
  }

  async keySet(version: number): Promise<Signed | null> {
    const doc = `${this.base}keys/${version}.json`;
    // Only this document's own 404 means "not published" (§10.2 step 2); its .sig must exist like anyone else's.
    const bytes = await this.fetch(doc, DOC_CAP);
    if (bytes === null) return null;
    return { bytes, signature: await this.required(`${doc}.sig`) };
  }

  async channel(name: Channel): Promise<Signed> {
    const doc = `${this.base}${name}.json`;
    return { bytes: await this.required(doc), signature: await this.required(`${doc}.sig`) };
  }

  async manifest(url: string, maxBytes: number): Promise<Signed> {
    return { bytes: await this.required(url, maxBytes), signature: await this.required(`${url}.sig`) };
  }

  // A document the caller must have: a 404 is a refusal like any other status.
  private async required(url: string, maxBytes: number = DOC_CAP): Promise<Uint8Array> {
    const bytes = await this.fetch(url, maxBytes);
    if (bytes === null) throw new FetchFailed("status", `HTTP 404 from ${url}`);
    return bytes;
  }

  // One capped document: bytes, or null for a 404, and a refusal for anything the wire did to it.
  private async fetch(url: string, maxBytes: number): Promise<Uint8Array | null> {
    const r = await httpsGet(url, { ...(this.ca === undefined ? {} : { ca: this.ca }), maxBytes, timeoutMs: this.timeoutMs, deadlineMs: this.deadlineMs });
    if (r.status === 404) return null;
    if (r.overLimit) throw new FetchFailed("too_large", `${url}: over its ${maxBytes}-byte cap at ${r.size} bytes`);
    if (r.cut) throw new FetchFailed("network", `${url}: the transfer ended early at ${r.size} bytes`);
    return r.bytes ?? new Uint8Array(0);
  }
}
