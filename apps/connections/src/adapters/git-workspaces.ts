// The repository a path belongs to (design §6).
import type { WorkspaceRoots } from "../application/ports.ts";

export class GitWorkspaceRoots implements WorkspaceRoots {
  commonDir(path: string): string | null {
    void path;
    return null;
  }
}
