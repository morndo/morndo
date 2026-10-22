// The updater's own paths (design §5): everything derives from HOME and follows the XDG base directories — data
// under ~/.local/share, state under ~/.local/state, configuration under ~/.config (XDG Base Directory
// Specification 0.8, https://specifications.freedesktop.org/basedir/latest, read 2026-10-21). No root anywhere.
import { isAbsolute, join } from "node:path";

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
