// Where a service's SQLite database may live: on this machine's own disk, never a network file system. The hub, the fleet
// service and the node agent all run SQLite in WAL mode, and "All processes using a database must be on the same host
// computer; WAL does not work over a network filesystem" (https://www.sqlite.org/wal.html, read 2026-10-08). The node
// agent's durability rests on it too: its database shares its machine's fate with the tmux server it guards (fleet core
// §16.4), which a database on another machine would not.
// Linux names a file system by the magic number statfs(2) reports (f_type; https://man7.org/linux/man-pages/man2/statfs.2.html,
// read 2026-10-08), which Node gives as StatFs.type (fs.statfsSync). The network ones listed here are refused, WSL's 9P
// mounts of Windows drives (/mnt/c) included. Not seen: a network file system mounted through FUSE (sshfs, s3fs; FUSE is
// often local, so it passes), CephFS, Lustre and GPFS. Elsewhere (macOS) the numbers mean other things, so nothing is
// refused there.
import { existsSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export class NotLocalDisk extends Error {
  constructor(message: string) { super(message); this.name = "NotLocalDisk"; }
}

const NETWORK: ReadonlyMap<number, string> = new Map([
  [0x6969, "NFS"], [0x517b, "SMB"], [0xfe534d42, "SMB2"], [0xff534d42, "CIFS"], [0x01021997, "9P"],
  [0x5346414f, "AFS"], [0x73757245, "Coda"],
]);

// Throws NotLocalDisk when `dir` (the database's directory) is on one of those network file systems. A directory not made
// yet is judged by the nearest one that exists, which it would be made on, so a service can ask before creating anything.
export function assertLocalDisk(dir: string, o: { platform?: NodeJS.Platform; fsType?: (dir: string) => number } = {}): void {
  if ((o.platform ?? process.platform) !== "linux") return;
  let at = resolve(dir);
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  const type = (o.fsType ?? (d => statfsSync(d).type))(at);
  const name = NETWORK.get(type);
  if (name !== undefined) {
    throw new NotLocalDisk(`${dir} is on a network file system (${name}). SQLite's WAL mode needs this machine's own disk (https://www.sqlite.org/wal.html): set HOME or the database path to a local directory.`);
  }
}
