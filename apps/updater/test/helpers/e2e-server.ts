// The e2e feed's host, as a directory (design §13): documents, signatures and archives are plain files under one
// root, a cut list names the transfers that promise more than they send, and a request log records every path asked
// for. The same directory serves the test whichever process hosts it — the test worker's own HTTPS server on
// ordinary machines, or the one-process driver where a spawned process cannot reach another process's server — so
// both transports see exactly the same world, bends included: a bend is a file rewritten before the next request.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export type DiskFeed = {
  /** The directory that is the host. */
  root: string;
  put(path: string, body: Buffer, cutAt?: number): void;
  unput(path: string): void;
  /** Every path asked of the host, in order, since the directory was made. */
  requests(): string[];
  handler(req: IncomingMessage, res: ServerResponse): void;
};

export function diskFeed(root: string): DiskFeed {
  mkdirSync(root, { recursive: true });
  const cutPath = join(root, ".cut.json");       // control files, dot-named so no document path can reach them
  const logPath = join(root, ".requests.log");
  // Made when absent, never remade: the host process (the driver) constructs this per run, and the test's world —
  // the cut list included, the request log especially — must survive that construction untouched.
  if (!existsSync(cutPath)) writeFileSync(cutPath, "{}\n");
  if (!existsSync(logPath)) writeFileSync(logPath, "");

  const cutOf = (): Record<string, number> =>
    existsSync(cutPath) ? JSON.parse(readFileSync(cutPath, "utf8")) as Record<string, number> : {};

  return {
    root,
    put: (path, body, cutAt) => {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
      const cut = cutOf();
      if (cutAt === undefined) delete cut[path];
      else cut[path] = cutAt;
      writeFileSync(cutPath, `${JSON.stringify(cut)}\n`);
    },
    unput: path => {
      rmSync(join(root, path), { force: true });
      const cut = cutOf();
      delete cut[path];
      writeFileSync(cutPath, `${JSON.stringify(cut)}\n`);
    },
    requests: () => (existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(line => line !== "") : []),
    handler: (req, res) => {
      const path = new URL(req.url ?? "/", "https://127.0.0.1").pathname;
      appendFileSync(logPath, `${path}\n`);
      const full = join(root, path);
      if (!existsSync(full)) { res.writeHead(404); res.end(); return; }
      const body = readFileSync(full);
      res.writeHead(200, { "content-length": String(body.length) });   // the size is a claim, never a fact
      const cut = cutOf()[path];
      if (cut !== undefined) {
        // the whole body promised, then the connection ends: the deterministic cut, as a FIN delivers what was sent
        res.write(body.subarray(0, cut));
        res.socket?.end();
        return;
      }
      res.end(body);
    },
  };
}
