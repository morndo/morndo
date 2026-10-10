// A hook-bus subscriber for tests: a real HTTP server on a random port that records every POST and deduplicates on
// the Idempotency-Key, as a real subscriber must (spec 5.6: at least once; subscribers deduplicate). `respond` picks
// each answer's status (and may hold it back).
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

export type Received = { key: string; body: { node: string; streamId: string; seq: number; path: string; body: unknown; late?: true }; contentType: string };
export type TestSubscriber = {
  url: string;
  received: Received[];                                  // every POST, duplicates included
  handled: Map<string, Received>;                         // the first of each key: what the subscriber acts on
  respond: (r: Received, attempt: number) => number | Promise<number>;
  close(): Promise<void>;
};

const open = new Set<TestSubscriber>();
afterEach(async () => { for (const s of open) await s.close(); open.clear(); });

const readAll = async (req: IncomingMessage) => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return Buffer.concat(c).toString("utf8"); };

export async function startSubscriber(respond: TestSubscriber["respond"] = () => 200): Promise<TestSubscriber> {
  const attempts = new Map<string, number>();
  const server = createServer((req, res) => {
    void (async () => {
      const r: Received = {
        key: String(req.headers["idempotency-key"] ?? ""), body: JSON.parse(await readAll(req)) as Received["body"],
        contentType: String(req.headers["content-type"] ?? ""),
      };
      s.received.push(r);
      if (!s.handled.has(r.key)) s.handled.set(r.key, r);
      const n = (attempts.get(r.key) ?? 0) + 1;
      attempts.set(r.key, n);
      const status = await s.respond(r, n);
      res.writeHead(status).end();
    })().catch(() => res.destroy());
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const s: TestSubscriber = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`,
    received: [], handled: new Map(), respond,
    close: () => new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); }),
  };
  open.add(s);
  return s;
}
