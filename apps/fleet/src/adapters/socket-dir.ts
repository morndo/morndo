// The client API's Unix socket (spec 5.6, 8): its directory must be a real directory (not a symlink) owned by this
// user with mode 0700, or the service refuses to start, since anyone who can reach the socket can steer every node.
// A socket file left by a service that died is removed; one that answers belongs to a running service and is never
// taken over; anything else at that path is left alone and refused.
import { lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";

export class SocketDirUnsafe extends Error {
  constructor(message: string) { super(message); this.name = "SocketDirUnsafe"; }
}

export class SocketInUse extends Error {
  constructor(message: string) { super(message); this.name = "SocketInUse"; }
}

export function prepareSocketDir(socketPath: string, uid: number = process.getuid?.() ?? -1): void {
  const dir = dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new SocketDirUnsafe(`${dir} must be a directory, not a link or a file`);
  if (st.uid !== uid) throw new SocketDirUnsafe(`${dir} must belong to this user (uid ${uid}); it belongs to uid ${st.uid}`);
  const mode = st.mode & 0o777;
  if (mode !== 0o700) throw new SocketDirUnsafe(`${dir} must have mode 700, not ${mode.toString(8)} (chmod 700 ${dir})`);
}

export async function clearStaleSocket(socketPath: string): Promise<void> {
  let st;
  try { st = lstatSync(socketPath); } catch { return; }
  if (!st.isSocket()) throw new SocketDirUnsafe(`${socketPath} exists and is not a socket; move it away`);
  const answers = await new Promise<boolean>(resolve => {
    const s = connect(socketPath);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
  if (answers) throw new SocketInUse(`another fleet service is listening on ${socketPath}`);
  unlinkSync(socketPath);
}
