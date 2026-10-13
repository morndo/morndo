// Where the plugin lives (design §6). One known path. Never PATH. A file this user does not own, or one the group
// or the world can write, is not run.
import { lstatSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type LocatedTranscriber =
  | { path: string }
  | { path: null; reason: "missing" | "not_ready"; detail: string };

const MISSING: LocatedTranscriber = { path: null, reason: "missing", detail: "missing" };
const UNSAFE: LocatedTranscriber = { path: null, reason: "not_ready", detail: "unsafe_permissions" };

function ownedFile(path: string): LocatedTranscriber {
  let link;
  try { link = lstatSync(path); }
  catch { return MISSING; }
  let file = link;
  if (link.isSymbolicLink()) {
    try { file = statSync(path); }
    catch { return MISSING; }
  }
  if (!file.isFile()) return MISSING;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined || file.uid !== uid) return UNSAFE;
  if ((file.mode & 0o022) !== 0) return UNSAFE;
  if ((file.mode & 0o111) === 0) return UNSAFE;
  return { path };
}

export function locateTranscriber(env: NodeJS.ProcessEnv, home: string): LocatedTranscriber {
  const named = env.MORNDO_TRANSCRIBER;
  if (typeof named === "string" && named !== "") {
    if (!isAbsolute(named)) return MISSING;
    return ownedFile(named);
  }
  return ownedFile(join(home, "plugins", "transcribe", "bin", "morndo-transcribe"));
}
