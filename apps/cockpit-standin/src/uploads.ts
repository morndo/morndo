import { randomUUID } from "node:crypto";
import type { Attachment, UploadInput } from "@morndo/cockpit-api";
import { BASE, missing, Problem } from "./protocol.ts";

const MAX_FILE = 512 * 1024;
const MAX_READER_SIZE = 2 * 1024 * 1024;
const MAX_READER_COUNT = 8;
const MAX_STORE = 16 * 1024 * 1024;
const UPLOAD_TTL = 24 * 60 * 60 * 1000;

export class Uploads {
  private readonly entries = new Map<string, { owner: string; bytes: Buffer; expires: number }>();
  private size = 0;
  private readonly usage = new Map<string, { bytes: number; count: number }>();

  private readonly origin: () => string;

  constructor(origin: () => string) {
    this.origin = origin;
  }

  add(input: UploadInput, owner: string): Attachment {
    const bytes = Buffer.from(input.data, "base64");
    if (bytes.length > MAX_FILE) throw new Problem("payloadTooLarge", "Files are limited to 512 KiB.");
    if (bytes.toString("base64") !== input.data) throw new Problem("badRequest", "The file data must be canonical base64.");
    const usage = this.usage.get(owner) ?? { bytes: 0, count: 0 };
    if (usage.bytes + bytes.length > MAX_READER_SIZE) throw new Problem("payloadTooLarge", "This reader has reached the 2 MiB upload limit.");
    if (usage.count >= MAX_READER_COUNT) throw new Problem("rateLimited", "This reader already has eight active uploads.");
    if (this.size + bytes.length > MAX_STORE) throw new Problem("limitReached", "The demo upload store is full.");
    const id = randomUUID();
    this.entries.set(id, { owner, bytes, expires: Date.now() + UPLOAD_TTL });
    this.size += bytes.length;
    this.usage.set(owner, { count: usage.count + 1, bytes: usage.bytes + bytes.length });
    return { name: input.name, url: `${this.origin()}${BASE}/uploads/${id}` };
  }

  requireAttachment(url: string, reader: string, workspaceOwner: boolean): void {
    if (url.startsWith("https://")) return;
    const prefix = `${this.origin()}${BASE}/uploads/`;
    if (!url.startsWith(prefix)) throw new Problem("badRequest", "Use an attachment uploaded to this cockpit.");
    this.get(url.slice(prefix.length), reader, workspaceOwner);
  }

  get(id: string, reader: string, workspaceOwner: boolean) {
    const entry = this.entries.get(id);
    if (!entry || entry.expires <= Date.now() || (entry.owner !== reader && !workspaceOwner)) throw missing("file");
    return entry;
  }

  sweep(): void {
    const now = Date.now();
    for (const [id, item] of this.entries) {
      if (item.expires <= now) {
        this.entries.delete(id);
        this.size -= item.bytes.length;
        const usage = this.usage.get(item.owner);
        if (!usage) continue;
        if (usage.count <= 1) this.usage.delete(item.owner);
        else this.usage.set(item.owner, { count: usage.count - 1, bytes: usage.bytes - item.bytes.length });
      }
    }
  }
}
