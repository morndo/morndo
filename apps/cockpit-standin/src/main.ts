import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commandErrors, validate, type ValidationResult } from "@morndo/cockpit-api";
import { WebSocket, WebSocketServer } from "ws";
import type { Command } from "@morndo/cockpit-api";
import { World } from "./world.ts";

const BASE = "/api/cockpit";
const MAX_BODY = 1024 * 1024;

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? fallback;
}

function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function refusal(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function checked(def: string, body: unknown): ValidationResult<unknown> {
  return validate(def, body);
}

export async function start(module: "gtm" | "dev", port: number): Promise<{ port: number; close: () => Promise<void> }> {
  const world = new World(module);
  const bound = { port };
  const server = createServer((req, res) => {
    void handle(world, req, res, (event) => {
      const encoded = JSON.stringify(event);
      for (const client of feed.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(encoded);
      }
    });
  });
  const feed = new WebSocketServer({
    server,
    path: `${BASE}/feed`,
    verifyClient: (info: { req: IncomingMessage }) => allowedOrigin(headerValue(info.req.headers.origin), bound.port),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  bound.port = actual;
  console.log(`cockpit-standin listening on http://127.0.0.1:${actual}`);
  return {
    port: actual,
    close: () => new Promise((resolve, reject) => {
      feed.close();
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

async function handle(world: World, req: IncomingMessage, res: ServerResponse, broadcast: (event: unknown) => void): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith(BASE)) {
      send(res, 404, refusal("not_found", "No route for that path."));
      return;
    }
    const path = decodePath(url.pathname);
    if (path === undefined) {
      respond(res, 404, "ApiError", refusal("not_found", "No route for that path."));
      return;
    }
    if (req.method === "POST" && path === "/actions") {
      await postAction(world, req, res, broadcast);
      return;
    }
    if (req.method !== "GET") {
      send(res, 404, refusal("not_found", "No route for that path."));
      return;
    }
    const outcome = world.get(path, url.searchParams);
    respond(res, outcome.status, outcome.definition, outcome.body);
  } catch (err) {
    if (err instanceof URIError) {
      respond(res, 404, "ApiError", refusal("not_found", "No route for that path."));
      return;
    }
    const message = err instanceof Error ? err.message : "The stand-in failed.";
    send(res, 500, refusal("internal", message));
  }
}

function decodePath(pathname: string): string | undefined {
  try {
    return decodeURI(pathname.slice(BASE.length)) || "/";
  } catch (err) {
    if (err instanceof URIError) return undefined;
    throw err;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function mediaType(req: IncomingMessage): string {
  return (headerValue(req.headers["content-type"]) ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function allowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

async function postAction(world: World, req: IncomingMessage, res: ServerResponse, broadcast: (event: unknown) => void): Promise<void> {
  if (mediaType(req) !== "application/json") {
    req.resume();
    respond(res, 415, "ApiError", refusal("unsupported_media_type", "Content-Type must be application/json."));
    return;
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    req.resume();
    respond(res, 413, "ApiError", refusal("payload_too_large", "The body is larger than 1 MiB."));
    return;
  }
  const raw = await readBody(req, MAX_BODY);
  if (raw === undefined) {
    if (!res.headersSent) respond(res, 413, "ApiError", refusal("payload_too_large", "The body is larger than 1 MiB."));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    respond(res, 400, "ApiError", refusal("invalid_command", "The body is not JSON."));
    return;
  }
  const command = validate<Command>("Command", parsed);
  if (!command.ok) {
    const specific = commandErrors(parsed);
    const message = (specific.length > 0 ? specific : command.errors).join("; ") || "The command was refused.";
    respond(res, 400, "ApiError", refusal("invalid_command", message));
    return;
  }
  const outcome = world.act(command.value);
  if (outcome.status === 200) {
    const events = eventsOf(outcome.body);
    for (const event of events) {
      const check = validate("Event", event);
      if (!check.ok) {
        respond(res, 500, "ApiError", refusal("invalid_response", check.errors.join("; ")));
        return;
      }
    }
    for (const event of events) broadcast(event);
  }
  respond(res, outcome.status, outcome.definition, outcome.body);
}

function respond(res: ServerResponse, status: number, def: string, body: unknown): void {
  const result = checked(def, body);
  if (!result.ok) {
    send(res, 500, refusal("invalid_response", result.errors.join("; ") || `Response is not a ${def}.`));
    return;
  }
  send(res, status, body);
}

function eventsOf(body: unknown): unknown[] {
  if (!body || typeof body !== "object" || !("events" in body) || !Array.isArray(body.events)) return [];
  return body.events;
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
  const module = arg("--module", "gtm");
  const port = Number(arg("--port", "0"));
  if (module !== "gtm" && module !== "dev") {
    console.error("module must be gtm or dev");
    process.exit(1);
  }
  if (!Number.isInteger(port) || port < 0) {
    console.error("port must be a whole number");
    process.exit(1);
  }
  start(module, port).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
