// The update settings file (design §8.3), as a SettingsSource and a SettingsSink: ~/.config/morndo-update/config.json,
// every field optional, read through the wire's schema so an unknown field or a wrong shape is a refusal naming the
// file — never a guess, and never a rewrite. No file is the ordinary first install: the domain's defaults apply, and
// nothing is written until a settings command runs. A command re-reads under an exclusive lock, applies its one
// change, and writes the file back atomically (a unique temp beside it, mode 0600, then rename; the directory
// 0700). A read takes no lock: the rename is atomic.
import { accessSync, chmodSync, closeSync, constants, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_CHANNEL, DEFAULT_MODE, formatVersion, parseVersion, type Channel, type UpdateMode, type Window } from "@morndo/domain";
import { UpdateConfigSchema } from "@morndo/protocol";
import type { MachineSettings, SettingsChange, SettingsSink, SettingsSource } from "../application/ports.ts";

export class ConfigInvalid extends Error {
  constructor(message: string) { super(message); this.name = "ConfigInvalid"; }
}

// How long change() waits for `<config>.lock`. A test lowers `ms`; five seconds is the command's own wait.
export const configLockWaitMs = { ms: 5_000 };

// A test steps in after a lock is seen stale and before it is claimed. Production leaves this empty.
export const configLockHooks: { afterStaleSeen?: () => void } = {};
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;

// A write that did not land. `code` is the filesystem error's own (EACCES, ENOSPC, …).
export class ConfigWriteFailed extends Error {
  readonly code: string;
  constructor(path: string, code: string, detail: string) {
    super(`could not write ${path}: ${code} ${detail}; nothing was changed`);
    this.name = "ConfigWriteFailed";
    this.code = code;
  }
}

// Another command still holds `<config>.lock` and it is not stale.
export class ConfigBusy extends Error {
  constructor(lockPath: string) {
    super(`another settings command holds ${lockPath}; try again`);
    this.name = "ConfigBusy";
  }
}

const errnoOf = (error: unknown): { code: string; message: string } => {
  const e = error as NodeJS.ErrnoException;
  const text = e instanceof Error ? e.message : String(error);
  // Node's own message starts with the code ("EACCES: permission denied, ..."); the sentence already says the code.
  return { code: typeof e.code === "string" ? e.code : "ERR", message: text.replace(/^[A-Z][A-Z0-9]+: /, "") };
};

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// Sixteen hex characters, so two temps in one process never share a name.
const randomHex = (): string => {
  let hex = "";
  for (let i = 0; i < 16; i++) hex += Math.floor(Math.random() * 16).toString(16);
  return hex;
};

// "HH:MM-HH:MM" to minutes of the local day: the schema has already checked the shape, so the arithmetic is all
// that is left. A window past midnight keeps its end below its start (22:00-06:00 is 1320 to 360), which is the
// domain's own signal to wrap (§8.3, windowContains).
const windowMinutes = (window: string): Window => {
  const [start, end] = window.split("-");
  const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  return { start: minutes(start!), end: minutes(end!) };
};

// The inverse of windowMinutes: minutes of the local day back to the file's "HH:MM-HH:MM".
const hhmm = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const windowText = (w: Window): string => `${hhmm(w.start)}-${hhmm(w.end)}`;

// The fields the file may hold. Absent is the domain's default, so a write keeps only what was stored.
type Stored = {
  channel?: Channel;
  mode?: UpdateMode;
  window?: string;
  pin?: string;
  soakMinutes?: number;
};

export class ConfigFile implements SettingsSource, SettingsSink {
  private readonly path: string;

  constructor(path: string) { this.path = path; }

  read(): MachineSettings {
    const data = this.#stored();
    if (data === null)
      return { channel: DEFAULT_CHANNEL, mode: DEFAULT_MODE, pin: null, window: null, soakMinutes: null };
    return {
      channel: data.channel ?? DEFAULT_CHANNEL,
      mode: data.mode ?? DEFAULT_MODE,
      pin: data.pin === undefined ? null : parseVersion(data.pin),
      window: data.window === undefined ? null : windowMinutes(data.window),
      // §4.5's soak, when the machine names one; null is the domain's own default, applied where it is used.
      soakMinutes: data.soakMinutes ?? null,
    };
  }

  // Re-reads through the same schema, under the lock, and writes that one change. A file that is not the settings
  // shape throws ConfigInvalid and is not touched: a settings command never repairs a file it cannot read as written.
  change(c: SettingsChange): MachineSettings {
    let held = false;
    try {
      this.#prepareDir();
      this.#acquireLock();
      held = true;
      const data: Stored = { ...(this.#stored() ?? {}) };
      if (c.kind === "channel") data.channel = c.channel;
      else if (c.kind === "mode") data.mode = c.mode;
      else if (c.kind === "pin") data.pin = formatVersion(c.version);
      else if (c.kind === "unpin") delete data.pin;
      else if (c.kind === "window") data.window = windowText(c.window);
      else delete data.window;
      this.#write(data);
      return this.read();
    } finally {
      if (held) rmSync(this.#lockPath(), { force: true });
    }
  }

  #lockPath(): string { return `${this.path}.lock`; }

  #failed(error: unknown): ConfigWriteFailed {
    const { code, message } = errnoOf(error);
    return new ConfigWriteFailed(this.path, code, message);
  }

  // The directory is 0700 before anything is written into it. One this process cannot write is left as it is:
  // widening it would hide the permission the caller has to fix.
  #prepareDir(): void {
    const dir = dirname(this.path);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      accessSync(dir, constants.W_OK);
      chmodSync(dir, 0o700);
    } catch (error) {
      throw this.#failed(error);
    }
  }

  // Exclusive create of `<config>.lock`, retried every 25 ms up to the wait. A lock older than 30 s is stale.
  // It is claimed by renaming it to `<lock>.stale.<pid>.<hex>` before it is judged, so a lock another command
  // already replaced is given back and waited on, and one that is still stale is removed. The claimed name is
  // always removed. A lock this call did not take is never removed.
  #acquireLock(): void {
    const lock = this.#lockPath();
    const deadline = Date.now() + configLockWaitMs.ms;
    for (;;) {
      try {
        const fd = openSync(lock, "wx", 0o600);
        closeSync(fd);
        return;
      } catch (error) {
        if (errnoOf(error).code !== "EEXIST") throw this.#failed(error);
        let stale = false;
        try {
          stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
        } catch (statError) {
          if (errnoOf(statError).code === "ENOENT") continue;
          throw this.#failed(statError);
        }
        if (stale) {
          configLockHooks.afterStaleSeen?.();
          const claimed = `${lock}.stale.${process.pid}.${randomHex()}`;
          try {
            renameSync(lock, claimed);
          } catch (renameError) {
            if (errnoOf(renameError).code === "ENOENT") continue;
            throw this.#failed(renameError);
          }
          let stillStale = false;
          try {
            stillStale = Date.now() - statSync(claimed).mtimeMs > LOCK_STALE_MS;
            if (!stillStale) {
              try {
                linkSync(claimed, lock);
              } catch (linkError) {
                if (errnoOf(linkError).code !== "EEXIST") throw linkError;
              }
            }
          } catch (judgeError) {
            throw this.#failed(judgeError);
          } finally {
            rmSync(claimed, { force: true });
          }
          if (stillStale) continue;
        }
        if (Date.now() >= deadline) throw new ConfigBusy(lock);
        pause(Math.min(LOCK_RETRY_MS, Math.max(1, deadline - Date.now())));
      }
    }
  }

  // null: no file, the defaults. A file that cannot be read as the settings shape throws, having written nothing.
  #stored(): Stored | null {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      // no file is a default everywhere (§8.3); a file this process cannot read is a real failure
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let doc: unknown;
    try { doc = JSON.parse(text); }
    catch { throw new ConfigInvalid(`${this.path}: not JSON, so not the update settings`); }
    const parsed = UpdateConfigSchema.safeParse(doc);
    if (!parsed.success) throw new ConfigInvalid(`${this.path}: not the update settings shape (${parsed.error?.issues[0]?.path.join(".") ?? "?"} ${parsed.error?.issues[0]?.message ?? ""})`);
    return parsed.data;
  }

  // Atomic: a temp named for this process beside the file, 0600, rename over. A failure after the temp exists
  // removes it. An older `<config>.tmp` is neither used nor removed. Two-space indent and a trailing newline.
  #write(data: Stored): void {
    const dir = dirname(this.path);
    const temp = `${this.path}.${process.pid}.${randomHex()}.tmp`;
    let created = false;
    try {
      created = true;                                 // so a write that dies mid-create is still removed
      writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      chmodSync(temp, 0o600);
      const fd = openSync(temp, "r+");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.path);
      created = false;
      const dirFd = openSync(dir, "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch (error) {
      throw this.#failed(error);
    } finally {
      if (created) rmSync(temp, { force: true });
    }
  }
}
