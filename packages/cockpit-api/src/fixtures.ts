import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export interface FixtureFile {
  /** Path relative to `fixtures/<module>/`, with forward slashes. */
  path: string;
  definition: string;
  value: unknown;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

/** The view definition a fixture path deserializes into. */
export function definitionFor(rel: string): string | undefined {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const slash = rel.lastIndexOf("/");
  const parent = slash === -1 ? undefined : rel.slice(rel.lastIndexOf("/", slash - 1) + 1, slash);
  if (name.endsWith(".access.json")) return "AccessView";
  switch (name) {
    case "workspace.json":
      return "WorkspaceView";
    case "sidebar.json":
      return "SidebarView";
    case "models.json":
      return "ModelsView";
    case "usage.json":
      return "UsageView";
    case "brief.json":
      return "BriefView";
    case "decisions.json":
      return "DecisionQueueView";
    case "drafts.json":
      return "DraftsView";
    case "skills.json":
      return "SkillsView";
    case "settings.json":
      return "SettingsView";
    case "pulls.json":
      return "PullsView";
    case "manager.json":
      return parent === "threads" ? "ThreadView" : "ManagerView";
    default:
      if (parent === "decisions") return "DecisionView";
      if (parent === "topics") return "TopicView";
      if (parent === "lanes") return "LaneView";
      if (parent === "threads") return "ThreadView";
      return undefined;
  }
}

/** Restore a thread id from its fixture file name (`topic_paid.json` → `topic:paid`). */
export function threadIdFromFile(fileName: string): string {
  const base = fileName.replace(/\.json$/, "");
  if (base.startsWith("topic_")) return `topic:${base.slice("topic_".length)}`;
  if (base.startsWith("lane_")) return `lane:${base.slice("lane_".length)}`;
  if (base.startsWith("decision_")) return `decision:${base.slice("decision_".length)}`;
  return base;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".json")) out.push(path);
  }
}

/** Read every fixture for `gtm` or `dev`. */
export function loadFixtures(module: string): FixtureFile[] {
  const dir = join(root, module);
  const paths: string[] = [];
  walk(dir, paths);
  const files: FixtureFile[] = [];
  for (const path of paths) {
    const rel = relative(dir, path).split("\\").join("/");
    const definition = definitionFor(rel);
    if (!definition) throw new Error(`no view for fixture ${module}/${rel}`);
    files.push({ path: rel, definition, value: JSON.parse(readFileSync(path, "utf8")) as unknown });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}
