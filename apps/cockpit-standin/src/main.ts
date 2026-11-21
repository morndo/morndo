import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate, type ValidationResult } from "@morndo/cockpit-api";
import { WebSocket, WebSocketServer } from "ws";
import type { Command } from "./model.ts";
import { World } from "./world.ts";

const BASE = "/api/cockpit";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? fallback;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
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
  const server = createServer((req, res) => {
    void handle(world, req, res, (event) => {
      const encoded = JSON.stringify(event);
      for (const client of feed.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(encoded);
      }
    });
  });
  const feed = new WebSocketServer({ server, path: `${BASE}/feed` });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
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
    const path = decodeURI(url.pathname.slice(BASE.length)) || "/";
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
    const message = err instanceof Error ? err.message : "The stand-in failed.";
    send(res, 500, refusal("internal", message));
  }
}

async function postAction(world: World, req: IncomingMessage, res: ServerResponse, broadcast: (event: unknown) => void): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    respond(res, 400, "ApiError", refusal("invalid_command", "The body is not JSON."));
    return;
  }
  const command = validate<Command>("Command", parsed);
  if (!command.ok) {
    respond(res, 400, "ApiError", refusal("invalid_command", command.errors.join("; ") || "The command was refused."));
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
