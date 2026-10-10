// When he comes back, on this device (ADR-0011, H4): at the app's start, and when the page shows again after being
// hidden a minute or more, his last activity here is read before anything moves it, the hub is asked when he was last
// active elsewhere, and the domain's isAway decides on its answer. Away long enough: a digest since then is asked for
// and shown until he closes it. His input keeps "last active here" current (at most every 30 s), and so does leaving.
import { isAway, type AwaySetting } from "@morndo/domain";
import type { LiveFeed } from "../../feed.svelte.ts";
import { DIGEST_KEY, holdActivity, nightBetween, noteActivity, readAway, readLastActive, writeAway } from "./away.ts";

const RETURN_AFTER_HIDDEN_MS = 60_000;
const KEEP_DIGEST_MS = 12 * 3_600_000;                     // a digest he never closed stays offered this long
const storage = () => { try { return localStorage; } catch { return null; } };

export class Away {
  setting = $state<AwaySetting>("4h");
  // The digest to offer: since when (his last activity before he left) and until when (his return). `open`: on screen.
  pending = $state<{ since: number; until: number } | null>(null);
  open = $state(false);
  #feed: LiveFeed;
  #now: () => number;
  #returnAt: number | null = null;
  #here: number | null = null;
  #heardBefore = 0;                                        // the hub's presence words before this return
  #hiddenAt: number | null = null;

  constructor(feed: LiveFeed, now: () => number = Date.now) {
    this.#feed = feed;
    this.#now = now;
    const s = storage();
    if (s) {
      this.setting = readAway(s);
      try {
        const kept = JSON.parse(s.getItem(DIGEST_KEY) ?? "null") as { since?: unknown; until?: unknown } | null;
        if (kept && typeof kept.since === "number" && typeof kept.until === "number" && now() - kept.until < KEEP_DIGEST_MS) this.pending = { since: kept.since, until: kept.until };
      } catch { /* unreadable: none */ }
    }
  }

  #onInput = () => this.#touch();
  #onVisibility = () => {
    if (document.visibilityState === "hidden") { this.#hiddenAt = this.#now(); this.#touch(true); return; }
    const hidden = this.#hiddenAt;
    this.#hiddenAt = null;
    if (hidden !== null && this.#now() - hidden >= RETURN_AFTER_HIDDEN_MS) this.#returned();
  };

  start() {
    this.#returned();
    for (const t of ["pointerdown", "keydown", "touchstart"] as const) addEventListener(t, this.#onInput, { passive: true, capture: true });
    document.addEventListener("visibilitychange", this.#onVisibility);
  }
  stop() {
    for (const t of ["pointerdown", "keydown", "touchstart"] as const) removeEventListener(t, this.#onInput, { capture: true });
    document.removeEventListener("visibilitychange", this.#onVisibility);
  }

  choose(v: AwaySetting) {
    this.setting = v;
    const s = storage();
    if (s) writeAway(s, v);
  }

  // He came back: what he did here last is read now, before his input moves it; the hub is asked for the rest.
  #returned() {
    const s = storage();
    const at = this.#now();
    const here = s ? readLastActive(s) : null;
    // This device alone already shows he wasn't away: the hub's word can only make the absence shorter, so it is
    // decided now and his input here counts again at once, even through a visit the hub never answers (validated review
    // finding #5). Only when this device alone says away (or knows nothing) does the hub's word decide.
    if (here !== null && !isAway({ here, elsewhere: null, now: at, setting: this.setting, night: nightBetween }).away) {
      this.#returnAt = null;
      holdActivity(false);
      this.#touch(true);
      return;
    }
    this.#returnAt = at;
    holdActivity(true);
    this.#here = here;
    this.#heardBefore = this.#feed.presence.n;
    this.#feed.requestPresence();                          // not on the socket: the next hello says it
  }

  // Called when the hub's presence word or the feed's state changes: decides once per return, on a word newer than it.
  check() {
    if (this.#returnAt === null || !this.#feed.primed || this.#feed.presence.n <= this.#heardBefore) return;
    const at = this.#returnAt;
    this.#returnAt = null;
    holdActivity(false);
    const r = isAway({ here: this.#here, elsewhere: this.#feed.presence.elsewhere, now: at, setting: this.setting, night: nightBetween });
    this.#touch(true);
    if (!r.away) return;
    this.pending = { since: r.since, until: at };
    this.open = true;
    const s = storage();
    try { s?.setItem(DIGEST_KEY, JSON.stringify(this.pending)); } catch { /* this page only */ }
    this.#feed.requestDigest(r.since);
  }

  // Asks for the pending digest again (it was kept from an earlier visit, or the socket came back).
  refresh() { if (this.pending && this.#feed.digest?.since !== this.pending.since) this.#feed.requestDigest(this.pending.since); }

  close() {
    this.open = false;
    this.pending = null;
    try { storage()?.removeItem(DIGEST_KEY); } catch { /* nothing kept */ }
  }

  #touch(force = false) {
    if (this.#returnAt !== null) { holdActivity(true); return; }   // not before the return is decided: it reads the old time
    holdActivity(false);
    const s = storage();
    if (s) noteActivity(s, this.#now(), force);
  }
}
