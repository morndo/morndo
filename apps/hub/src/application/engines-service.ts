// Engines (ADR-0013): the page where the principal picks, per role, which provider and model does the work and what
// falls back. Reads and writes go through the engine layer's CLI (adapters/engines-cli.ts), never a copy of its file.
// A save is a Command (AC7: a fresh enough passkey check), checked whole before the first write (R5), refused when the
// settings changed elsewhere since the page loaded, and each write recorded in the audit log as it lands (R6). Saves
// run one at a time, so two devices saving against the same version can't both pass the check (review finding 2). A
// write from outside the hub (the terminal, the manager) between the check and the write isn't caught: that needs a
// compare-and-set in the engine CLI.
import { checkChanges, enginesChanged, knownModel, mayCommand, parseEngine, type AccessPolicy, type ChangeProblem, type RoleChange } from "@morndo/domain";
import type { EnginesSaveBody, EnginesView } from "@morndo/protocol";
import type { Authenticated } from "./access-service.ts";
import { EnginesError, type EnginesCli, type EnginesSettings } from "../adapters/engines-cli.ts";
import type { Store } from "../adapters/store.ts";

export type EnginesRead = { ok: true; view: EnginesView } | { ok: false; problem: "unavailable" | "unsupported"; message: string };
export type EnginesSaved =
  | { ok: true; view: EnginesView }
  | { ok: false; problem: "step_up" | "changed" }
  | { ok: false; problem: "unsupported"; message: string }
  | { ok: false; problem: "unavailable"; message: string; saved?: string[] }
  | { ok: false; problem: ChangeProblem; role: string; engine?: string }
  // The CLI refused a write after the check passed (its file changed under it, say): what was written before stays.
  | { ok: false; problem: "refused"; message: string; role: string; saved: string[] };

// How long an "update the CLI" answer is kept. A newer engine-layer is then picked up on the next look, and a save
// asks again at once, so the hub does not have to be restarted.
export const ENGINES_PROBE_TTL_MS = 30_000;

export class EnginesService {
  #cli: EnginesCli;
  #store: Store;
  #policy: () => AccessPolicy;
  #now: () => number;
  #saving: Promise<unknown> = Promise.resolve();
  #probed: { at: number; why: string | null } | null = null;
  #flight: Promise<string | null> | null = null;
  // Bumped when a probe starts, and when a save arrives while one is still running, so that probe's answer is stale.
  #seq = 0;
  constructor(p: { cli: EnginesCli; store: Store; policy: () => AccessPolicy; now?: () => number }) {
    this.#cli = p.cli; this.#store = p.store; this.#policy = p.policy; this.#now = p.now ?? Date.now;
  }

  // Whether the CLI is one this page works with (EnginesCli.probe). A CLI that is new enough is remembered. An
  // "unsupported" answer is remembered only for ENGINES_PROBE_TTL_MS, and a save asks again at once, so installing
  // a newer engine-layer is picked up without restarting the hub. A CLI that couldn't run is asked again next time.
  // One probe runs at a time. A save that arrives while one is running waits, and that probe's answer is not stored:
  // a slower older answer must not replace a newer one, or clear it by failing.
  ready(p?: { onSave?: boolean }): Promise<string | null> {
    const cached = this.#probed;
    const unsupported = !!cached?.why;
    const stale = unsupported && (!!p?.onSave || this.#now() - cached.at >= ENGINES_PROBE_TTL_MS);
    if (cached && !stale) return Promise.resolve(cached.why);
    if (this.#flight) {
      const flight = this.#flight;
      if (!p?.onSave) return flight;
      this.#seq += 1;
      return flight.then(() => this.ready(p), () => this.ready(p));
    }
    const seq = ++this.#seq;
    const flight = this.#cli.probe().then(why => {
      if (seq === this.#seq) this.#probed = { at: this.#now(), why };
      return why;
    }, e => {
      if (seq === this.#seq) this.#probed = null;
      throw e;
    }).finally(() => { if (this.#flight === flight) this.#flight = null; });
    this.#flight = flight;
    return flight;
  }

  async view(): Promise<EnginesRead> {
    try {
      const why = await this.ready();
      if (why) return { ok: false, problem: "unsupported", message: why };
      return { ok: true, view: await this.#cli.read() };
    } catch (e) { return unavailable(e); }
  }

  save(a: Authenticated, body: EnginesSaveBody): Promise<EnginesSaved> {
    const run = this.#saving.then(() => this.#save(a, body));
    this.#saving = run.catch(() => {});
    return run;
  }

  async #save(a: Authenticated, body: EnginesSaveBody): Promise<EnginesSaved> {
    try {
      const why = await this.ready({ onSave: true });
      if (why) return { ok: false, problem: "unsupported", message: why };
    } catch (e) { return unavailable(e); }
    if (!mayCommand(a.session, this.#now(), this.#policy())) return { ok: false, problem: "step_up" };
    // The check needs the settings and the providers only, not what runs now (review of PR #13, finding 6).
    let current: EnginesSettings;
    try { current = await this.#cli.settings(); }
    catch (e) { return unavailable(e); }
    if (current.version !== body.version) return { ok: false, problem: "changed" };
    const checked = checkChanges(current.roles, current.providers, body.changes as RoleChange[]);
    if (!checked.ok) return { ok: false, ...checked.error };
    const saved: string[] = [];
    // Each write is recorded as soon as the CLI took it, so a failure part way leaves the log and the answer true.
    const wrote = (c: RoleChange) => {
      // The CLI has already taken the write. Name the role before the audit insert, and try that insert once more
      // when the database is busy. A second failure is a hub fault, not an "unavailable" answer.
      if (!saved.includes(c.role)) saved.push(c.role);
      const event = enginesChanged(a.endpoint.id, c, this.#now());
      try { this.#store.record([event]); }
      catch { this.#store.record([event]); }
    };
    for (const c of checked.value) {
      try {
        if (c.chain) {
          // --force only for a model the role already had outside the known list (R5 let nothing else through).
          const known = (text: string) => { const e = parseEngine(text); return !!e && knownModel(e, current.providers); };
          await this.#cli.setChain(c.role, c.chain, !c.chain.every(known));
          wrote({ role: c.role, chain: c.chain });
        }
        if (c.otherProvider !== undefined) {
          await this.#cli.setOtherProvider(c.role, c.otherProvider);
          wrote({ role: c.role, otherProvider: c.otherProvider });
        }
      } catch (e) {
        if (e instanceof EnginesError && e.kind === "refused") return { ok: false, problem: "refused", message: e.message, role: c.role, saved };
        // Only the CLI's own failure is "unavailable", with its words. Anything else (a database error, a bug) is a
        // 500: the HTTP layer logs it and answers "internal error", never e.message.
        if (e instanceof EnginesError) return { ok: false, problem: "unavailable", message: e.message, saved };
        throw e;
      }
    }
    try { return { ok: true, view: await this.#cli.read({ providers: current.providers }) }; }
    catch (e) { return { ...unavailable(e), saved }; }
  }
}

function unavailable(e: unknown): { ok: false; problem: "unavailable"; message: string } {
  if (e instanceof EnginesError) return { ok: false, problem: "unavailable", message: e.message };
  throw e;
}
