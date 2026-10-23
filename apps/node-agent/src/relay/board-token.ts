// The token the reply style ask (digest-check.ts) reads the hub's board with. A token in the node's environment would be in
// the environment of the tmux server it hosts and of every lane started in it, so it is read from a file, when it is used,
// and never copied anywhere (a MORNDO_AGENT_TOKEN a unit still sets is removed from the environment at start, below): the file must be a plain file (not a link) that only its owner can read, one token without
// white space. Anything else gives null, and the not-live rule is skipped.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const TOKEN_MAX = 4096;

export function readBoardToken(file: string): string | null {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) !== 0 || st.size === 0 || st.size > TOKEN_MAX) return null;
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, st.size, 0);
    const token = buf.subarray(0, n).toString("utf8").trim();
    return /^[\x21-\x7e]+$/.test(token) ? token : null;
  } catch { return null; } finally { closeSync(fd); }
}

// The variable lanes use for their own tokens (docs/agents/board.md). If the node's environment holds one, the tmux server
// and every lane started from it would inherit the node's, so `run` removes it before it hosts tmux, and the agent again
// for anything that starts it otherwise. True when a token was there, so the caller can say so.
export const AGENT_TOKEN_ENV = "MORNDO_AGENT_TOKEN";
export function dropAgentTokenEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const had = (env[AGENT_TOKEN_ENV] ?? "") !== "";
  delete env[AGENT_TOKEN_ENV];
  return had;
}
