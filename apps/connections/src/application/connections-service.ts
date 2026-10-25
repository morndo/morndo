// Registering a connection and the changes a person may make to one (ADR-0018, CN1–CN15).
import {
  acknowledge, addKey, addLayer, addSubscription, err, findConnection, grantDefaults, ok, parseEngine, placeNew,
  revoke, revokeName, rotate as domainRotate, setBudget, setExpiry, setIsolation, setRepo, turnOff, turnOn,
  type Actor, type Billing, type Budget, type Directory, type Isolation, type Kind, type Policy, type RepoRule, type Result,
} from "@morndo/domain";
import { findPreset, floorOf } from "./catalog.ts";
import { loginKeyRefused } from "./login-key.ts";
import { blockedRemoval, syncRevoked } from "./providers.ts";
import type { ConnectionLifecycle, Deps, Failure } from "./ports.ts";
import { raiseThresholds } from "./thresholds.ts";

type Out = Result<void, Failure>;

function fail(problem: string): Result<never, Failure> { return err({ problem }); }

function offered(preset: { kinds: readonly string[]; custody: string; runtimes: readonly { runtime: string }[] }, kind: string, custody: string, runtime: string): string | null {
  if (!preset.kinds.includes(kind)) return "kind";
  if (preset.custody !== custody) return "custody";
  if (!preset.runtimes.some(row => row.runtime === runtime)) return "runtime";
  return null;
}

export class ConnectionsService {
  readonly #deps: Deps;
  readonly #life: ConnectionLifecycle | undefined;
  constructor(deps: Deps, lifecycle?: ConnectionLifecycle) {
    this.#deps = deps;
    this.#life = lifecycle;
  }

  addSubscription(input: { name: string; vendor: string; runtime: string; configDir: string | null }, actor: Actor): Out {
    if (this.#life?.reserved(input.name)) return fail("taken");
    const preset = findPreset(this.#deps.catalog, input.vendor);
    if (!preset) return fail("missing");
    const offer = offered(preset, "subscription", "morndo", input.runtime);
    if (offer) return fail(offer);
    const floor = floorOf(preset);
    const { directory, policy, version } = this.#deps.store.load();
    const added = addSubscription(directory, {
      name: input.name, vendor: input.vendor, runtime: input.runtime, isolation: floor, floor, configDir: input.configDir,
    }, actor, this.#deps.clock.now());
    if (!added.ok) return fail(added.error.problem);
    if (!this.#save(added.value, placeNew(policy, input.name, this.#deps.clock.now()), version)) return fail("conflict");
    return ok(undefined);
  }

  async addKey(input: { name: string; vendor: string; runtime: string; ref: string; billing: Billing; budget: Budget; expiry: number | null }, actor: Actor): Promise<Out> {
    if (this.#life?.reserved(input.name)) return fail("taken");
    const preset = findPreset(this.#deps.catalog, input.vendor);
    if (!preset) return fail("missing");
    if (!this.#deps.vault.has(input.ref)) return fail("bad_ref");
    const fingerprint = await this.#deps.vault.fingerprint(input.ref);
    if (!fingerprint) return fail("bad_fingerprint");
    const offer = offered(preset, "api-key", "morndo", input.runtime);
    if (offer) return fail(offer);
    if (loginKeyRefused(this.#deps.catalog.presets(), input.runtime, "api-key", "morndo")) return fail("kind");
    const floor = floorOf(preset);
    const { directory, policy, version } = this.#deps.store.load();
    const added = addKey(directory, {
      name: input.name, vendor: input.vendor, runtime: input.runtime, isolation: floor, floor,
      ref: input.ref, fingerprint, billing: input.billing, budget: input.budget, expiry: input.expiry,
    }, actor, this.#deps.clock.now());
    if (!added.ok) return fail(added.error.problem);
    if (!this.#save(added.value, placeNew(policy, input.name, this.#deps.clock.now()), version)) return fail("conflict");
    return ok(undefined);
  }

  addLayer(input: { name: string; vendor: string; runtime: string; kind: Kind }, actor: Actor): Out {
    if (this.#life?.reserved(input.name)) return fail("taken");
    const preset = findPreset(this.#deps.catalog, input.vendor);
    if (!preset) return fail("missing");
    const offer = offered(preset, input.kind, "engine-layer", input.runtime);
    if (offer) return fail(offer);
    if (loginKeyRefused(this.#deps.catalog.presets(), input.runtime, input.kind, "engine-layer")) return fail("kind");
    const floor = floorOf(preset);
    const { directory, policy, version } = this.#deps.store.load();
    const added = addLayer(directory, {
      name: input.name, vendor: input.vendor, runtime: input.runtime, isolation: floor, floor, kind: input.kind,
    }, actor, this.#deps.clock.now());
    if (!added.ok) return fail(added.error.problem);
    if (!this.#save(added.value, placeNew(policy, input.name, this.#deps.clock.now()), version)) return fail("conflict");
    this.#deps.engines.putProvider({ name: input.name, enabled: false });
    return ok(undefined);
  }

  async rotate(name: string, ref: string, actor: Actor): Promise<Out> {
    if (!this.#deps.vault.has(ref)) return fail("bad_ref");
    const fingerprint = await this.#deps.vault.fingerprint(ref);
    if (!fingerprint) return fail("bad_fingerprint");
    const turned = this.#dir(directory => domainRotate(directory, name, ref, fingerprint, actor, this.#deps.clock.now()));
    if (turned.ok) this.#life?.rotated(name);
    return turned;
  }

  acknowledge(name: string, by: string, actor: Actor): Out {
    const { directory, policy, version } = this.#deps.store.load();
    const current = findConnection(directory, name);
    if (!current) return fail("missing");
    const preset = findPreset(this.#deps.catalog, current.vendor);
    if (!preset) return fail("missing");
    const first = current.terms === null;
    let skipped: readonly string[] = [];
    const acked = acknowledge(directory, name, preset.terms.revision, by, actor, this.#deps.clock.now());
    if (!acked.ok) return fail(acked.error.problem);
    let next = policy;
    if (first) {
      const rows = this.#deps.models.models({ name, vendor: current.vendor });
      const none: string[] = [];
      const listed = acked.value.connections.map(c => c.name === name
        ? { name, kind: c.kind, models: rows.map(r => r.id), efforts: rows[0]?.efforts ?? null }
        : { name: c.name, kind: c.kind, models: none, efforts: null });
      const defaults = Object.entries(preset.defaultPicks).flatMap(([role, pick]) => {
        if (role === "*") return [];
        const engine = parseEngine(pick.includes(":") ? pick : `${name}:${pick}`);
        return engine ? [{ role, pick: engine }] : [];
      });
      const star = preset.defaultPicks["*"];
      const starEngine = star ? parseEngine(star.includes(":") ? star : `${name}:${star}`) : null;
      const roles = next.roles.filter(r => r.override !== "hand" && !defaults.some(d => d.role === r.role));
      const withStar = starEngine ? roles.map(r => ({ role: r.role, pick: { ...starEngine, provider: name } })) : [];
      const granted = grantDefaults(next, name, [...defaults, ...withStar], listed, this.#deps.clock.now());
      next = granted.policy;
      skipped = granted.skipped;
    }
    if (!this.#save(acked.value, next, version)) return fail("conflict");
    if (first) {
      for (const role of skipped) this.#deps.alerts.raise({ kind: "defaults", name, detail: role });
      this.#deps.engines.putProvider({ name, enabled: true });
    }
    return ok(undefined);
  }

  setRepo(name: string, repo: RepoRule | null, actor: Actor): Out {
    const current = findConnection(this.#deps.store.load().directory, name);
    const preset = current ? findPreset(this.#deps.catalog, current.vendor) : null;
    if (!preset) return fail("missing");
    return this.#dir(directory => setRepo(directory, name, repo, floorOf(preset), actor, this.#deps.clock.now()));
  }

  setIsolation(name: string, isolation: Isolation, actor: Actor): Out {
    const current = findConnection(this.#deps.store.load().directory, name);
    const preset = current ? findPreset(this.#deps.catalog, current.vendor) : null;
    if (!preset) return fail("missing");
    return this.#dir(directory => setIsolation(directory, name, isolation, floorOf(preset), actor, this.#deps.clock.now()));
  }

  setBudget(name: string, budget: Budget, actor: Actor): Out {
    return this.#dir(directory => setBudget(directory, name, budget, actor, this.#deps.clock.now()));
  }

  setExpiry(name: string, expiry: number | null, actor: Actor): Out {
    return this.#dir(directory => setExpiry(directory, name, expiry, actor, this.#deps.clock.now()));
  }

  turnOff(name: string): Out {
    const result = this.#dir(directory => turnOff(directory, name, this.#deps.clock.now()));
    if (!result.ok) return result;
    return this.#layer(name, `off ${name}`);
  }

  turnOn(name: string, actor: Actor): Out {
    const result = this.#dir(directory => turnOn(directory, name, actor, this.#deps.clock.now()));
    if (!result.ok) return result;
    return this.#layer(name, `on ${name}`);
  }

  revoke(name: string, actor: Actor): Out {
    const { directory, policy, version } = this.#deps.store.load();
    const revoked = revoke(directory, name, actor, this.#deps.clock.now());
    if (!revoked.ok) {
      if (revoked.error.problem !== "revoked") return fail(revoked.error.problem);
      const done = this.#layer(name, `revoke ${name}`, () => {
        syncRevoked(directory, policy, this.#deps.engines);
        this.#availability(name);
      });
      if (done.ok) this.#life?.revoked(name);
      return done;
    }
    const known = revoked.value.connections.map(c => ({ name: c.name, kind: c.kind }));
    const gone = revokeName(policy, name, known, this.#deps.clock.now());
    const blocked = blockedRemoval(revoked.value, gone.policy, this.#deps.engines);
    if (blocked) return fail(`${blocked.name} is still in ${blocked.roles.join(", ")}'s chain`);
    if (!this.#save(revoked.value, gone.policy, version)) return fail("conflict");
    for (const role of gone.kept) this.#deps.alerts.raise({ kind: "kept", name: role, detail: name });
    const done = this.#layer(name, `revoke ${name}`, () => {
      syncRevoked(revoked.value, gone.policy, this.#deps.engines);
      this.#availability(name);
    });
    if (done.ok) this.#life?.revoked(name);
    return done;
  }

  // Persist already happened. A failed engines update is reported, and the next save writes it again.
  #layer(name: string, command: string, update: () => void = () => this.#availability(name)): Out {
    try {
      update();
    } catch {
      return fail(`saved, engine layer not updated (retry: ${command})`);
    }
    return ok(undefined);
  }

  // A Morndo-custody connection that is off or revoked must not stay enabled in the engine layer.
  #availability(name: string): void {
    const connection = findConnection(this.#deps.store.load().directory, name);
    if (!connection || connection.custody !== "morndo") return;
    this.#deps.engines.putProvider({ name, enabled: connection.status === "on" && connection.terms !== null });
  }

  #dir(step: (directory: Directory) => Result<Directory, { problem: string }>): Out {
    const { directory, policy, version } = this.#deps.store.load();
    const next = step(directory);
    if (!next.ok) return fail(next.error.problem);
    if (!this.#save(next.value, policy, version)) return fail("conflict");
    raiseThresholds(directory.events, next.value.events, this.#deps.alerts);
    return ok(undefined);
  }

  #save(directory: Directory, policy: Policy, version: number): boolean {
    return this.#deps.store.save(directory, policy, version);
  }
}
