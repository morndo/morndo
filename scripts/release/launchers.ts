// bin/<name> resolves its own directory once and runs that Version's Node on that Version's
// program (design §5). realpath follows the link in ~/.local/bin back into the Version.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";

// One launcher per package bin, read from the tree being staged, so a new CLI cannot be missed.
// A bin's file is under its package; two packages must not claim one name.
export function launchersFrom(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const top of ["apps", "packages"]) {
    const base = join(repo, top);
    if (!existsSync(base)) continue;
    for (const dir of readdirSync(base).sort()) {
      const file = join(base, dir, "package.json");
      if (!existsSync(file)) continue;
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      const bin = typeof parsed === "object" && parsed !== null && "bin" in parsed ? parsed.bin : undefined;
      if (typeof bin !== "object" || bin === null) continue;
      for (const [name, path] of Object.entries(bin)) {
        if (typeof path !== "string") throw new Error(`bin ${name} in ${top}/${dir} is not a path`);
        const inside = normalize(path).replace(/^\.\//, "");
        if (inside.startsWith("..") || inside.startsWith("/")) throw new Error(`bin ${name} leaves its package: ${path}`);
        if (Object.hasOwn(out, name)) throw new Error(`two packages claim the bin ${name}`);
        out[name] = `app/${top}/${dir}/${inside}`;
      }
    }
  }
  return out;
}

export function launcherSource(entry: string): string {
  return [
    "#!/bin/sh",
    "# This file's real directory, once (ADR-0019 section 5): a link still runs this Version's Node.",
    "set -eu",
    "here=$(CDPATH= cd -- \"$(dirname -- \"$(realpath \"$0\")\")\" && pwd)",
    `exec "$here/../node/bin/node" "$here/../${entry}" "$@"`,
    "",
  ].join("\n");
}
