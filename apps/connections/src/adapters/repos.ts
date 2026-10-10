import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { RepoInspector } from "../application/ports.ts";

export class GitRepos implements RepoInspector {
  inspect(path: string): { path: string; remotes: readonly string[] } {
    const real = realpathSync(path);
    let remotes: string[] = [];
    try {
      const out = execFileSync("git", ["-C", real, "remote", "-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      remotes = [...new Set(out.split("\n").flatMap(line => {
        const remote = line.split(/\s+/)[1];
        return remote ? [remote] : [];
      }))];
    } catch { remotes = []; }
    return { path: real, remotes };
  }
}
