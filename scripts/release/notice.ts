// Production dependencies named in the lockfile, one line each. Dev packages are not shipped.
export function thirdPartyNotice(lock: { packages: Record<string, { version?: string; dev?: boolean }> }): string {
  const lines: string[] = [];
  for (const [path, meta] of Object.entries(lock.packages)) {
    if (path === "" || meta.dev || meta.version === undefined) continue;
    const name = path.split("node_modules/").pop();
    if (!name) continue;
    lines.push(`${name} ${meta.version}`);
  }
  lines.sort();
  return ["Third-party packages in this build:", ...lines, ""].join("\n");
}
