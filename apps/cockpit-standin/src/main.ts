import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commandErrors, contractVersion, validate, type Command, type CommandResult } from "@morndo/cockpit-api";
import { WebSocketServer } from "ws";
import { image } from "./artwork.ts";
import { Feed } from "./feed.ts";
import { definitionFor, matchRoute, missing, Problem } from "./protocol.ts";
import { DEMO_AT, World, type Module } from "./world.ts";

const MAX_BODY = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.once("error", reject);
  });
}

async function readCommand(req: IncomingMessage): Promise<Command> {
  const type = header(req.headers["content-type"])?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    req.resume();
    throw new Problem("unsupportedMediaType", "Content-Type must be application/json.");
  }
  if (Number(req.headers["content-length"]) > MAX_BODY) {
    req.resume();
    throw new Problem("payloadTooLarge", "The body is larger than 1 MiB.");
  }
  const body = await readBody(req);
  if (body === null) throw new Problem("payloadTooLarge", "The body is larger than 1 MiB.");
  let data: unknown;
  try {
    data = JSON.parse(body) as unknown;
  } catch {
    throw new Problem("badRequest", "The body is not JSON.");
  }
  const result = validate<Command>("Command", data);
  if (!result.ok) {
    const errors = commandErrors(data).map(message => {
      const match = /^(\/[^ ]+) (.*)$/.exec(message);
      return { path: match?.[1] ?? "", message: match?.[2] ?? message };
    });
    throw new Problem("badRequest", errors.map(item => item.message).join(", ") || "The command was refused.", errors);
  }
  return result.value;
}

function respond(res: ServerResponse, status: number, definition: string, body: unknown): void {
  const result = validate(definition, body);
  if (!result.ok) throw new Error(`Invalid ${definition}: ${result.errors.join(", ")}`);
  res.writeHead(status, {
    "content-type": status < 400 ? "application/json; charset=utf-8" : "application/problem+json; charset=utf-8",
    "cockpit-contract": contractVersion,
  });
  res.end(JSON.stringify(body));
}

function refused(error: unknown): Problem {
  if (error instanceof Problem) return error;
  if (error instanceof URIError) return missing("route");
  console.error(error instanceof Error ? error.message : "The stand-in failed.");
  return new Problem("internal", "The cockpit could not finish the request.");
}

function afterParam(query: URLSearchParams): number | null {
  const raw = query.get("after");
  if (raw === null) return null;
  const after = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(after)) throw new Problem("badRequest", "after must be a nonnegative sequence number.");
  return after;
}

export async function start(module: Module, port: number, clock?: () => string): Promise<{ port: number; close: () => Promise<void> }> {
  const started = Date.now();
  const now = clock ?? (() => new Date(Date.parse(DEMO_AT) + Date.now() - started).toISOString());
  const worlds = new Map<Module, World>();
  const origin = () => {
    const address = server.address();
    return `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`;
  };
  let active = module;
  const worldOf = (): World => {
    const world = worlds.get(active) ?? new World(active, origin);
    worlds.set(active, world);
    return world;
  };
  const feed = new Feed();
  const idempotency = new Map<string, { expires: number; result: CommandResult }>();
  const tick = (world: World) => {
    const at = now();
    const events = world.advance(at);
    if (events.length) feed.publish(world, events, at);
  };
  const ws = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  ws.on("headers", headers => headers.push(`cockpit-contract: ${contractVersion}`));
  const server = createServer((req, res) => {
    void (async () => {
      const url = parseUrl(req);
      const route = matchRoute(url.pathname);
      if (!route) throw missing("route");
      const method = req.method?.toLowerCase() ?? "";
      const operation = route.operations[method];
      if (!operation) {
        res.setHeader("allow", Object.keys(route.operations).map(value => value.toUpperCase()).join(", "));
        throw new Problem("methodNotAllowed", "That method is not available on this route.");
      }
      if (operation["x-websocket-message"]) throw new Problem("badRequest", "Use a WebSocket to read the feed.");
      const world = worldOf();
      const reader = url.searchParams.get("as");
      const viewer = world.viewer(reader);
      tick(world);
      const definition = definitionFor(operation);
      if (method === "post" && definition === "CommandResult") {
        const command = await readCommand(req);
        const key = header(req.headers["idempotency-key"]);
        if (key !== undefined && (key.length === 0 || key.length > 200)) throw new Problem("badRequest", "Invalid Idempotency-Key.");
        const cacheKey = key === undefined ? undefined : JSON.stringify([reader ?? "default", key]);
        const wall = Date.now();
        if (cacheKey !== undefined) {
          const saved = idempotency.get(cacheKey);
          if (saved && saved.expires > wall) {
            respond(res, 200, definition, saved.result);
            return;
          }
        }
        const effect = world.act(command, viewer);
        const privateTo = command.type.startsWith("pin.") || command.type === "prefs.set" || command.type === "topic.seen" || command.type === "since.edit" ? viewer.id : undefined;
        const events = feed.publish(world, effect.events, now(), privateTo, frames => {
          const check = validate(definition, { ...effect, events: frames });
          if (!check.ok) throw new Error(`Invalid ${definition}: ${check.errors.join(", ")}`);
        });
        const result: CommandResult = { ...effect, events };
        if (command.type === "module.switch") active = command.moduleId;
        if (cacheKey !== undefined) {
          for (const [id, entry] of idempotency) if (entry.expires <= wall) idempotency.delete(id);
          idempotency.set(cacheKey, { expires: wall + DAY_MS, result: structuredClone(result) });
        }
        respond(res, 200, definition, result);
      } else if (definition) {
        respond(res, 200, definition, world.read(definition, route.parameters[0], url.searchParams, viewer));
      } else {
        const [index, variant] = route.parameters;
        const bytes = image(Number(index), variant ?? "");
        res.writeHead(200, { "content-type": "image/webp", "cockpit-contract": contractVersion });
        res.end(bytes);
      }
    })().catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const problem = refused(error).body;
      respond(res, problem.status, "ApiError", problem);
    });
  });
  server.on("upgrade", (req, socket, head) => {
    try {
      const url = parseUrl(req);
      if (!matchRoute(url.pathname)?.operations.get?.["x-websocket-message"]) throw missing("route");
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${bound}` && origin !== `http://localhost:${bound}`) {
        throw new Problem("forbidden", "The feed is restricted to the local cockpit.");
      }
      const world = worldOf();
      const id = url.searchParams.get("as");
      const viewer = world.viewer(id);
      const after = afterParam(url.searchParams);
      tick(world);
      ws.handleUpgrade(req, socket, head, client => {
        feed.subscribe(client, { world: id ? () => world : worldOf, viewer: id ? () => viewer.id : () => worldOf().owner.id }, after, now());
      });
    } catch (error) {
      const problem = refused(error).body;
      if (!validate("ApiError", problem).ok) {
        socket.destroy();
        return;
      }
      const body = JSON.stringify(problem);
      socket.end(`HTTP/1.1 ${problem.status} ${problem.title}\r\ncontent-type: application/problem+json\r\ncockpit-contract: ${contractVersion}\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  worldOf();
  const ping = setInterval(() => feed.ping(), 25000);
  const updates = setInterval(() => {
    for (const world of worlds.values()) tick(world);
  }, 1000);
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : port;
  console.log(`cockpit-standin listening on http://127.0.0.1:${bound}`);
  return {
    port: bound,
    close: () => new Promise((resolve, reject) => {
      clearInterval(ping);
      clearInterval(updates);
      feed.close();
      ws.close();
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const module = argument("--module", "gtm");
  const port = Number(argument("--port", "0"));
  if ((module !== "gtm" && module !== "dev") || !Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("Use --module gtm|dev and --port 0..65535.");
    process.exitCode = 1;
  } else {
    start(module, port).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  }
}
