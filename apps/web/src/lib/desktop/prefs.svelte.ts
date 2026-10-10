// Per-conversation settings (show mode, tool activity, star), kept on this device, keyed by the agent's name. Mute
// lives on the hub since phase D. A change rewrites only its own entry over what storage holds now: the move of mute to
// the hub takes it out of storage, and a stale copy here must not write it back (review M2), nor erase another tab's.
import { DEFAULT_PREFS, type ConversationPrefs } from "./present.ts";

const KEY = "morndo.conversations";
type All = Record<string, Partial<ConversationPrefs>>;

const read = (): All | null => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v as All : {};
  } catch { return null; }
};

export class ConversationSettings {
  #all = $state<All>({});

  constructor() { this.#all = read() ?? {}; }

  get(name: string): ConversationPrefs { return { ...DEFAULT_PREFS, ...this.#all[name] }; }

  set(name: string, patch: Partial<ConversationPrefs>) {
    const all = read() ?? this.#all;
    all[name] = { ...all[name], ...patch };
    this.#all = all;
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage blocked: this page only */ }
  }
}
