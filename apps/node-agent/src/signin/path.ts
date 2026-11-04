// Where a program is on PATH, read from the file system: no shell (`command -v` is a shell built-in, not a program).
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch { /* not here */ }
  }
  return null;
}
