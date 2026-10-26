// The HoldWriter adapter (design §5 hold.json, §6.2 steps 3 and 7): the hold lands at the path the services
// themselves read (service-kit's holdFile), in the wire's own shape — validated here against the protocol's
// schema, so a hold every service would call malformed is refused at the writer, not discovered a second a
// piece at a time on the machine. Atomic as the rest of the updater's writes are: a temp file beside, fsynced,
// renamed over, so a service re-reading hold.json every second never sees half of it, and a write that cannot
// land leaves the hold that is already there.
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HoldFile, parseBody } from "@morndo/protocol";
import { holdFile } from "@morndo/service-kit";
import type { UpdateService } from "@morndo/domain";
import type { HoldWriter } from "../application/ports.ts";

// The wire's own instant (packages/protocol releases.ts): UTC, a Z, no fraction.
const isoUtc = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export class HoldFileWriter implements HoldWriter {
  readonly #path: string;

  constructor(o: { home: string; env?: NodeJS.ProcessEnv }) {
    this.#path = holdFile(o.home, o.env);
  }

  write(h: { services: UpdateService[]; reason: "drain" | "probation"; version: string; since: number }): void {
    const doc = { services: h.services, reason: h.reason, version: h.version, since: isoUtc(h.since) };
    if (parseBody(HoldFile, doc) === null) {
      throw new Error(`hold.json: not the shape the services read (${JSON.stringify(doc)})`);
    }
    const temp = `${this.#path}.tmp`;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    rmSync(temp, { force: true });                    // a leftover temp must not keep its old mode through create
    writeFileSync(temp, `${JSON.stringify(doc)}\n`, { mode: 0o600 });
    const fd = openSync(temp, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.#path);
    const dirFd = openSync(dirname(this.#path), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  }

  clear(): void {
    rmSync(this.#path, { force: true });
  }
}
