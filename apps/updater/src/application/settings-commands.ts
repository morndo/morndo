// One settings command, as a change and the sentence that answers it (design §8.1, §8.3). Pure: the sentence
// names what changed, from what to what, and what that means. The file is the adapter's. A switch that stops
// updates does not stop the edit; the sentence says the switch still holds.
import { compareVersions, formatVersion, type Version, type Window } from "@morndo/domain";
import type { MachineSettings, SettingsChange } from "./ports.ts";

const hhmm = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const windowText = (w: Window): string => `${hhmm(w.start)}-${hhmm(w.end)}`;

const fromTo = (before: MachineSettings, change: SettingsChange): string => {
  switch (change.kind) {
    case "channel": return `Channel set from ${before.channel} to ${change.channel}`;
    case "mode": return `Mode set from ${before.mode} to ${change.mode}`;
    case "pin": return `Pin set from ${before.pin === null ? "none" : formatVersion(before.pin)} to ${formatVersion(change.version)}`;
    case "unpin": return `Pin removed (it was ${before.pin === null ? "none" : formatVersion(before.pin)})`;
    case "window":
      return `Window set from ${before.window === null ? "any hour" : windowText(before.window)} to ${windowText(change.window)}`;
    case "windowAny":
      return `Window removed (it was ${before.window === null ? "any hour" : windowText(before.window)})`;
  }
};

// What a pin does here, from the check's own offer and admit (RL2, RL14): the pin's entry when the feed lists it,
// and never a move down. `running` null is an install this updater does not manage (no current link).
const pinMeans = (version: Version, running: Version | null): string => {
  const v = formatVersion(version);
  if (running === null) return "this install is not managed by the updater, so the pin has no effect here";
  if (compareVersions(version, running) === 0) return `this machine is held at ${v}: it takes no other Version`;
  if (compareVersions(version, running) > 0) {
    return `the next check moves this machine up to ${v} if the feed lists it (skipping the Versions in between), then holds it there; a pin the feed does not list leaves the machine where it is`;
  }
  const r = formatVersion(running);
  return `${v} is below the running ${r}: a pin never moves a machine down (RL2), so ${r} stays and no other Version is taken; morndo update --rollback goes back one Version`;
};

const means = (change: SettingsChange, running: Version | null): string => {
  switch (change.kind) {
    case "channel": return `checks follow ${change.channel}`;
    case "mode":
      if (change.mode === "off") return "the background checks nothing, and morndo update still works";
      if (change.mode === "stage") return "the background stages, and morndo update or the next boot applies";
      return "the background stages and applies at a safe point";
    case "pin": return pinMeans(change.version, running);
    case "unpin": return "this machine follows its channel again";
    case "window": return "automatic applies wait for those local hours";
    case "windowAny": return "automatic applies run at any hour";
  }
};

// The switches stop updates, not edits of the settings file (§8.3). Said in the same sentence.
const heldBy = (switches: { disableUpdates: boolean; disableAutoUpdate: boolean }): string => {
  const parts: string[] = [];
  if (switches.disableUpdates) parts.push("MORNDO_DISABLE_UPDATES=1 still holds every update path until it is unset");
  if (switches.disableAutoUpdate) parts.push("MORNDO_DISABLE_AUTOUPDATE=1 still holds the background until it is unset");
  return parts.length === 0 ? "" : `; ${parts.join("; ")}`;
};

export function planSettings(
  before: MachineSettings,
  change: SettingsChange,
  switches: { disableUpdates: boolean; disableAutoUpdate: boolean },
  running: Version | null,
): { change: SettingsChange; sentence: string } {
  return { change, sentence: `${fromTo(before, change)}; ${means(change, running)}${heldBy(switches)}.` };
}
