// The update settings file (design §8.3), as a SettingsSource and a SettingsSink: ~/.config/morndo-update/config.json,
// every field optional, read through the wire's schema so an unknown field or a wrong shape is a refusal naming the
// file — never a guess, and never a rewrite. No file is the ordinary first install: the domain's defaults apply, and
// nothing is written until a settings command runs. A command re-reads, applies its one change, and writes the file
// back atomically (a temp file beside it, mode 0600, then rename; the directory 0700).
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_CHANNEL, DEFAULT_MODE, formatVersion, parseVersion, type Channel, type UpdateMode, type Window } from "@morndo/domain";
import { UpdateConfigSchema } from "@morndo/protocol";
import type { MachineSettings, SettingsChange, SettingsSink, SettingsSource } from "../application/ports.ts";

export class ConfigInvalid extends Error {
  constructor(message: string) { super(message); this.name = "ConfigInvalid"; }
}

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

  // Re-reads through the same schema. A file that is not the settings shape throws ConfigInvalid and is not
  // touched: a settings command never repairs a file it cannot read as written.
  change(c: SettingsChange): MachineSettings {
    const data: Stored = { ...(this.#stored() ?? {}) };
    if (c.kind === "channel") data.channel = c.channel;
    else if (c.kind === "mode") data.mode = c.mode;
    else if (c.kind === "pin") data.pin = formatVersion(c.version);
    else if (c.kind === "unpin") delete data.pin;
    else if (c.kind === "window") data.window = windowText(c.window);
    else delete data.window;
    this.#write(data);
    return this.read();
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

  // Atomic, as the install writes the same file: temp beside it, 0600, rename over; the directory 0700. Two-space
  // indent and a trailing newline. A value already stored is written again — the answer still says what it is.
  #write(data: Stored): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const temp = `${this.path}.tmp`;
    rmSync(temp, { force: true });                    // a leftover temp must not keep its old mode through create
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    const fd = openSync(temp, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.path);
    const dirFd = openSync(dir, "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  }
}
