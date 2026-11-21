import { readFileSync } from "node:fs";
import type { ApiError, ErrorCode, FieldError } from "@morndo/cockpit-api";

export const BASE = "/api/cockpit";

interface Operation {
  responses: { "200"?: { content: { "application/json"?: { schema: { $ref: string } } } } };
  "x-websocket-message"?: { $ref: string };
}

const document = JSON.parse(readFileSync(new URL("../../../packages/cockpit-api/schema/cockpit.openapi.json", import.meta.url), "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
};

const routes = Object.entries(document.paths).map(([path, operations]) => ({
  path,
  pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, "([^/]+)")}$`),
  operations,
}));

export function matchRoute(path: string) {
  for (const route of routes) {
    const matches = route.pattern.exec(path);
    if (matches) return { path: route.path, parameters: matches.slice(1).map(decodeURIComponent), operations: route.operations };
  }
  return undefined;
}

export function definitionFor(operation: Operation): string | undefined {
  return operation.responses["200"]?.content["application/json"]?.schema.$ref.split("/").at(-1);
}

const problems = {
  badRequest: [400, "Bad request"],
  notFound: [404, "Not found"],
  forbidden: [403, "Forbidden"],
  conflict: [409, "Conflict"],
  limitReached: [409, "Limit reached"],
  skillDisabled: [409, "Skill disabled"],
  unsupportedMediaType: [415, "Unsupported media type"],
  payloadTooLarge: [413, "Payload too large"],
  methodNotAllowed: [405, "Method not allowed"],
  idempotencyKeyReused: [422, "Idempotency key reused"],
  internal: [500, "Internal error"],
} as const satisfies Partial<Record<ErrorCode, readonly [number, string]>>;

export class Problem extends Error {
  readonly body: ApiError;

  constructor(code: keyof typeof problems, detail: string, errors: FieldError[] = []) {
    super(detail);
    const [status, title] = problems[code];
    this.body = { type: `urn:morndo:cockpit:problem:${code}`, status, title, detail, code, errors };
  }
}

export function missing(record: string): Problem {
  return new Problem("notFound", `No ${record} with that id.`);
}

export function page<T>(
  newest: readonly T[], identify: (item: T) => string, scope: string, query: URLSearchParams, defaultLimit = 50,
): { items: T[]; nextCursor: string | null } {
  const raw = query.get("limit");
  const limit = raw === null ? defaultLimit : Number(raw);
  if ((raw !== null && !/^\d+$/.test(raw)) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Problem("badRequest", "limit must be an integer from 1 to 100.");
  }
  const cursor = query.get("cursor");
  let start = 0;
  if (cursor !== null) {
    if (cursor.length > 400 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Problem("badRequest", "Invalid cursor.");
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    } catch {
      throw new Problem("badRequest", "Invalid cursor.");
    }
    if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== scope || typeof decoded[1] !== "string") {
      throw new Problem("badRequest", "Cursor belongs to a different list.");
    }
    start = newest.findIndex((item) => identify(item) === decoded[1]) + 1;
    if (start === 0) throw new Problem("badRequest", "Cursor is no longer available.");
  }
  const items = newest.slice(start, start + limit);
  const last = items.at(-1);
  const nextCursor = last !== undefined && newest.length > start + items.length
    ? Buffer.from(JSON.stringify([scope, identify(last)])).toString("base64url")
    : null;
  return { items, nextCursor };
}

export type ThreadScope = { kind: "manager" | "general"; id: null } | { kind: "topic" | "lane" | "decision"; id: string };

export function threadScope(value: string): ThreadScope | undefined {
  if (value === "manager" || value === "general") return { kind: value, id: null };
  const [kind, id, extra] = value.split(":");
  if (extra === undefined && id && /^[a-z0-9][a-z0-9-]{0,199}$/.test(id)
    && (kind === "topic" || kind === "lane" || kind === "decision")) return { kind, id };
  return undefined;
}
