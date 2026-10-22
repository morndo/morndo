// The update settings file (design §8.3), as a SettingsSource: ~/.config/morndo-update/config.json, every field
// optional, read through the wire's schema so an unknown field or a wrong shape is a refusal naming the file —
// never a guess. No file is the ordinary first install: the domain's defaults apply, and nothing is written until
// a settings command runs.
import { readFileSync } from "node:fs";
import { DEFAULT_CHANNEL, DEFAULT_MODE, parseVersion, type Window } from "@morndo/domain";
import { UpdateConfigSchema } from "@morndo/protocol";
import type { MachineSettings, SettingsSource } from "../application/ports.ts";

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

export class ConfigFile implements SettingsSource {
  private readonly path: string;

  constructor(path: string) { this.path = path; }

  read(): MachineSettings {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      // no file is a default everywhere (§8.3); a file this process cannot read is a real failure
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { channel: DEFAULT_CHANNEL, mode: DEFAULT_MODE, pin: null, window: null, soakMinutes: null };
      throw error;
    }
    let doc: unknown;
    try { doc = JSON.parse(text); }
    catch { throw new ConfigInvalid(`${this.path}: not JSON, so not the update settings`); }
    const parsed = UpdateConfigSchema.safeParse(doc);
    if (!parsed.success) throw new ConfigInvalid(`${this.path}: not the update settings shape (${parsed.error?.issues[0]?.path.join(".") ?? "?"} ${parsed.error?.issues[0]?.message ?? ""})`);
    return {
      channel: parsed.data.channel ?? DEFAULT_CHANNEL,
      mode: parsed.data.mode ?? DEFAULT_MODE,
      pin: parsed.data.pin === undefined ? null : parseVersion(parsed.data.pin),
      window: parsed.data.window === undefined ? null : windowMinutes(parsed.data.window),
      // §4.5's soak, when the machine names one; null is the domain's own default, applied where it is used.
      soakMinutes: parsed.data.soakMinutes ?? null,
    };
  }
}
