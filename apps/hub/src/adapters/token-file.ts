// The forge credential's file (ADR-0035 step 3, private repositories). The settings name a path (MORNDO_GITHUB_TOKEN_FILE);
// the token is read from it once, at start, and is never a setting, an environment value or a word in any log. A file
// that others can read, or that is missing or empty, is no token: the hub then runs without one and a private
// repository's references read "not checked". The warning names the path and the reason, never the file's content.
import { readFileSync, statSync } from "node:fs";

export function readTokenFile(path: string | null, warn: (message: string) => void): string | null {
  if (path === null) return null;
  try {
    if ((statSync(path).mode & 0o077) !== 0) {
      warn(`github token file ${path}: readable by others, not used (chmod 600)`);
      return null;
    }
    const token = readFileSync(path, "utf8").trim();
    if (token === "") {
      warn(`github token file ${path}: empty, not used`);
      return null;
    }
    return token;
  } catch {
    warn(`github token file ${path}: cannot be read, not used`);
    return null;
  }
}
