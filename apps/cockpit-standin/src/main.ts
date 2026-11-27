import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commandErrors, contractVersion, validate, type Command, type UploadInput } from "@morndo/cockpit-api";
import { WebSocketServer } from "ws";
import { image } from "./artwork.ts";
import { Feed } from "./feed.ts";
import { Idempotency } from "./idempotency.ts";
import { Uploads } from "./uploads.ts";
import { BASE, definitionFor, matchRoute, missing, Problem } from "./protocol.ts";
import { DEMO_AT, World, type Module } from "./world.ts";

const MAX_BODY = 1024 * 1024;


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

async function readJson(req: IncomingMessage): Promise<unknown> {
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
  return data;
}

async function readCommand(req: IncomingMessage): Promise<Command> {
  const data = await readJson(req);
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
  const idempotency = new Idempotency();
  const uploads = new Uploads(origin);
  const tick = (world: World) => {
    const at = now();
    const audience = world.hasTimedWorkChange(at) ? world.notificationAudience() : undefined;
    const events = world.advance(at);
    if (events.length) feed.publish(world, events, at, audience ? { audience } : undefined);
  };
  const requireLocal = (req: IncomingMessage) => {
    const address = server.address();
    const bound = typeof address === "object" && address ? address.port : port;
    const local = [`127.0.0.1:${bound}`, `localhost:${bound}`];
    if (!local.includes(req.headers.host?.toLowerCase() ?? "")
      || (req.headers.origin !== undefined && !local.some(value => req.headers.origin === `http://${value}`))) {
      throw new Problem("forbidden", "This cockpit accepts requests from its local origin.");
    }
  };
  const ws = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  ws.on("headers", headers => headers.push(`cockpit-contract: ${contractVersion}`));
  const server = createServer((req, res) => {
    void (async () => {
      requireLocal(req);
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
        const scope = command.type === "module.switch" && viewer.id === world.owner.id ? "owner" : `${world.module}:${viewer.id}`;
        const result = idempotency.run(scope, key, command, () => {
          if ("attachment" in command && command.attachment) {
            uploads.requireAttachment(command.attachment.url, viewer.id, viewer.id === world.owner.id);
          }
          const audience = world.notificationAudience(command.type === "decisionRight.set" ? command.rule : undefined);
          const effect = world.act(command, viewer);
          const settings = command.type.startsWith("pin.") || command.type === "prefs.set" || command.type === "topic.seen" || command.type === "since.edit";
          const privateTo = (event: (typeof effect.events)[number]) =>
            settings || event.type === "drafts.changed" || (command.type === "decisionRight.set" && event.type === "prefs.changed") ? viewer.id : undefined;
          const events = feed.publish(world, effect.events, now(), {
            caller: viewer.id,
            audience,
            privateTo,
            beforeSend: frames => {
              const check = validate(definition, { ...effect, events: frames });
              if (!check.ok) throw new Error(`Invalid ${definition}: ${check.errors.join(", ")}`);
            },
          });
          if (command.type === "module.switch" && active !== command.moduleId) {
            active = command.moduleId;
            feed.moduleSwitched();
          }
          return { ...effect, events };
        }, saved => world.authorizeReplay(command, saved, viewer));
        respond(res, 200, definition, {
          ...result,
          message: result.message && world.projectMessage(result.message, viewer),
          events: result.events.map(event => world.projectEvent(event, viewer)),
        });
      } else if (method === "post" && route.path === `${BASE}/uploads`) {
        if (viewer.membershipState === "invited") throw new Problem("forbidden", "Accept the invitation before uploading files.");
        const payload = await readJson(req);
        if (payload && typeof payload === "object" && "data" in payload && typeof payload.data === "string" && payload.data.length > 699052) {
          throw new Problem("payloadTooLarge", "Files are limited to 512 KiB.");
        }
        const result = validate<UploadInput>("UploadInput", payload);
        if (!result.ok) throw new Problem("badRequest", result.errors.join(", "));
        respond(res, 200, "Attachment", uploads.add(result.value, viewer.id));
      } else if (route.path === `${BASE}/uploads/{id}`) {
        const file = uploads.get(route.parameters[0] ?? "", viewer.id, viewer.id === world.owner.id);
        res.writeHead(200, {
          "content-type": "application/octet-stream", "content-disposition": "attachment",
          "x-content-type-options": "nosniff", "cockpit-contract": contractVersion,
        });
        res.end(file.bytes);
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
      requireLocal(req);
      const url = parseUrl(req);
      if (!matchRoute(url.pathname)?.operations.get?.["x-websocket-message"]) throw missing("route");
      const world = worldOf();
      const id = url.searchParams.get("as");
      const viewer = world.viewer(id);
      const after = afterParam(url.searchParams);
      tick(world);
      ws.handleUpgrade(req, socket, head, client => {
        feed.subscribe(client, { world: id ? () => world : worldOf, viewer: id ? () => viewer.id : () => worldOf().owner.id, named: Boolean(id) }, after);
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
  const cleanup = setInterval(() => {
    idempotency.sweep();
    uploads.sweep();
  }, 60000);
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : port;
  console.log(`cockpit-standin listening on http://127.0.0.1:${bound}`);
  return {
    port: bound,
    close: () => new Promise((resolve, reject) => {
      clearInterval(ping);
      clearInterval(updates);
      clearInterval(cleanup);
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
