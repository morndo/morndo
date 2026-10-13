// The plugin is not a workspace. The root lockfile and the apps and packages trees do not name it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");

export function pluginPackageKeys(lock: { packages?: Record<string, { name?: string } | undefined> }): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    if (key === "plugins" || key.startsWith("plugins/") || key.includes("/plugins/")) found.push(key);
    const name = value?.name;
    if (typeof name === "string" && name.startsWith("morndo-transcribe")) found.push(name);
  }
  return found;
}

export function workspaceIncludesPlugins(workspaces: readonly string[]): boolean {
  return workspaces.some(pattern => pattern === "plugins" || pattern.startsWith("plugins/") || pattern.startsWith("plugins*"));
}

const IMPORTS = /(?:import|export)\s[^'"\n]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

export function pluginSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORTS)].map(match => match[1] ?? match[2] ?? "").filter(spec => spec.includes("plugins/"));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "build" || entry.name === ".svelte-kit") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|mts|mjs|js|svelte)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("the plugin stays out of the default install", () => {
  it("the root lockfile names no plugin package, and a fixture lockfile that does is caught", () => {
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as { packages?: Record<string, { name?: string }> };
    expect(pluginPackageKeys(lock)).toEqual([]);
    expect(pluginPackageKeys({
      packages: { "plugins/transcribe-whisper-cpp": { name: "morndo-transcribe-whisper-cpp" } },
    })).toEqual(["plugins/transcribe-whisper-cpp", "morndo-transcribe-whisper-cpp"]);
  });

  it("workspaces are packages and apps, and a plugins workspace would be caught", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { workspaces: string[] };
    expect(workspaceIncludesPlugins(pkg.workspaces)).toBe(false);
    expect(workspaceIncludesPlugins(["plugins/*"])).toBe(true);
  });

  it("nothing under apps or packages imports the plugin, and an import of it is caught", () => {
    const hits = ["apps", "packages"].flatMap(dir =>
      sourceFiles(join(ROOT, dir)).flatMap(file => pluginSpecifiers(readFileSync(file, "utf8")).map(spec => `${file} -> ${spec}`)));
    expect(hits).toEqual([]);
    expect(pluginSpecifiers(`import { main } from "plugins/transcribe-whisper-cpp/src/morndo-transcribe.mts";`)).toEqual([
      "plugins/transcribe-whisper-cpp/src/morndo-transcribe.mts",
    ]);
    expect(pluginSpecifiers(`// plugins/transcribe-whisper-cpp is not an import\nconst n = 1;\n`)).toEqual([]);
  });
});
