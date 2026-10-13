// bin/<name> resolves its own directory once and runs that Version's Node on that Version's
// program (design §5). realpath follows the link in ~/.local/bin back into the Version.
export const LAUNCHERS = {
  morndo: "app/apps/hub/src/main.ts",
  "morndo-fleet": "app/apps/fleet/src/main.ts",
  "morndo-node": "app/apps/node-agent/src/main.ts",
  "morndo-job": "app/apps/node-agent/src/job-main.ts",
  "morndo-board": "app/apps/board-cli/src/main.ts",
  "morndo-keys": "app/apps/connections/src/main.ts",
} as const;

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
