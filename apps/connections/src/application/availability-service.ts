// Whether a connection can run now. A subscription's sign-in is read from the runtime port, not stored.
import { availability, findConnection, isKey } from "@morndo/domain";
import { findPreset } from "./catalog.ts";
import type { Deps } from "./ports.ts";

export type AvailabilityReport = { state: string; until: number | null };

const OURS = "morndo:";
// Stays until a later report finds the connection ready. A short hold would lapse with nobody polling.
const UNTIL_READY = Number.MAX_SAFE_INTEGER;

export class AvailabilityService {
  readonly #deps: Deps;
  constructor(deps: Deps) { this.#deps = deps; }

  async report(name: string): Promise<AvailabilityReport | null> {
    const { directory } = this.#deps.store.load();
    const current = findConnection(directory, name);
    if (!current) return null;
    const preset = findPreset(this.#deps.catalog, current.vendor);
    if (!preset) return null;
    const now = this.#deps.clock.now();
    let state: string = availability(current, now, preset.terms.revision);
    if (state === "ready" && current.kind === "subscription" && current.custody === "morndo") {
      const signed = await this.#deps.runtime.loginStatus(current.configDir);
      if (signed === "missing") state = "signed_out";
    }
    const until = isKey(current) ? current.expiry : null;
    const ours = this.#deps.engines.marks().some(mark => mark.name === name && mark.reason.startsWith(OURS));
    if (state === "ready") {
      if (ours) this.#deps.engines.unmark(name);
    } else this.#deps.engines.mark(name, `${OURS}${state}`, UNTIL_READY);
    return { state, until };
  }
}
