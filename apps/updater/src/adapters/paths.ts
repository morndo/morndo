// The updater's own paths (design §5): everything derives from HOME and follows the XDG base directories — data
// under ~/.local/share, state under ~/.local/state, configuration under ~/.config (XDG Base Directory
// Specification 0.8, https://specifications.freedesktop.org/basedir/latest, read 2026-10-21). No root anywhere.
import { isAbsolute, join } from "node:path";
import type { DatabaseName } from "@morndo/domain";

export type UpdaterPaths = {
  /** ~/.local/share/morndo-releases: one directory per Version, plus the current/previous/good links. */
  releases: string;
  /** ~/.local/state/morndo-update: the update state, everything below it inside this directory. */
  state: string;
  /** The Installation and each Update's step record. */
  db: string;
  /** The lock an apply holds for its whole life (RL4). */
  lock: string;
  /** Artifacts being fetched; removed after staging or on failure. */
  downloads: string;
  /** The update settings (§8.3). */
  config: string;
};

export function updaterPaths(home: string): UpdaterPaths {
  // Everything below hangs off HOME, so a relative one — a misread variable, an unset environment — is refused
  // before it can scatter the updater's files through whatever the working directory happens to be.
  if (!isAbsolute(home)) throw new Error(`${JSON.stringify(home)}: the updater's paths need an absolute home`);
  const state = join(home, ".local/state/morndo-update");
  return {
    releases: join(home, ".local/share/morndo-releases"),
    state,
    db: join(state, "update.db"),
    lock: join(state, "apply.lock"),
    downloads: join(state, "downloads"),
    config: join(home, ".config/morndo-update/config.json"),
  };
}

// The four databases an Update may migrate (§5, §6.2 step 1): each at its own service's path, the same path that
// service itself opens — hub apps/hub/src/config.ts, fleet, node, and the connections store (its compose.ts).
// A role's database exists only where that role runs; reading one that is not there is the caller's null.
export type DatabasePaths = Record<DatabaseName, string>;

// An environment entry set but empty is not an override (the hold path's rule, service-kit/src/hold.ts).
const or = (value: string | undefined, fallback: string): string =>
  typeof value === "string" && value.length > 0 ? value : fallback;

export function databasePaths(home: string, env: NodeJS.ProcessEnv): DatabasePaths {
  if (!isAbsolute(home)) throw new Error(`${JSON.stringify(home)}: the updater's paths need an absolute home`);
  return {
    hub: join(or(env.MORNDO_HOME, join(home, ".local/share/morndo")), "morndo.db"),
    fleet: join(home, ".local/share/morndo-fleet/fleet.db"),
    node: join(home, ".local/state/morndo-node/agent.db"),
    connections: join(or(env.MORNDO_CONNECTIONS_HOME, join(home, ".config/morndo-connections")), "connections.db"),
  };
}
