// The tmux server's stamp (docs/design/fleet-core/README.md §4): pane IDs (%N) are reused after a tmux server restarts,
// so worker IDs carry the first 8 hex digits of a UUID the agent stores in the server's global user option
// @morndo-server. A restarted server has no stamp until it gets a new one. `set-option -o` refuses to overwrite a value
// that is already set (tmux(1), read 2026-10-06; seen on tmux 3.6a: "already set: @morndo-server"), so two callers that
// race on a fresh server both read back the one stamp that won.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { tmuxArgv } from "./tmux-cli.ts";

const run = promisify(execFile);
const STAMP = /^([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The server's stamp (8 hex digits), set first if it has none; null when no tmux server runs on that socket.
export async function stampServer(socket: string | null): Promise<string | null> {
  const tmux = async (args: string[]) => (await run("tmux", tmuxArgv(socket, args), { timeout: 5000 })).stdout;
  const read = async () => STAMP.exec((await tmux(["show-options", "-gqv", "@morndo-server"])).trim())?.[1] ?? null;
  try {
    const known = await read();
    if (known) return known;
    try { await tmux(["set-option", "-g", "-o", "@morndo-server", randomUUID()]); }
    catch { /* stamped meanwhile by another caller: read back what won */ }
    return await read();
  } catch {
    return null;                                            // no server on this socket
  }
}
