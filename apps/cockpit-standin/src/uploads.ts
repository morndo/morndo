import { randomUUID } from "node:crypto";
import type { Attachment, UploadInput } from "@morndo/cockpit-api";
import { BASE, missing, Problem } from "./protocol.ts";

const MAX_FILE = 512 * 1024;
const MAX_STORE = 16 * 1024 * 1024;
const UPLOAD_TTL = 24 * 60 * 60 * 1000;

export class Uploads {
  private readonly entries = new Map<string, { owner: string; bytes: Buffer; expires: number }>();
  private size = 0;

  add(input: UploadInput, owner: string): Attachment {
    const bytes = Buffer.from(input.data, "base64");
    if (bytes.length > MAX_FILE) throw new Problem("payloadTooLarge", "Files are limited to 512 KiB.");
    if (bytes.toString("base64") !== input.data) throw new Problem("badRequest", "The file data must be canonical base64.");
    if (this.size + bytes.length > MAX_STORE) throw new Problem("limitReached", "The demo upload store is full.");
    const id = randomUUID();
    this.entries.set(id, { owner, bytes, expires: Date.now() + UPLOAD_TTL });
    this.size += bytes.length;
    return { name: input.name, url: `https://files.example.test${BASE}/uploads/${id}` };
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
      }
    }
  }
}
