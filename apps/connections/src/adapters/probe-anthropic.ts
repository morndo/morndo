// One POST to the Messages endpoint of the given base URL (ADR-0037). The key is opened here and never returned.
// A success body is cancelled unread. An error body is read only up to a fixed byte limit, then reduced to a signal.
// A 404 whose kind is not_found_error, or a 400 invalid_request_error that names the model or the API version and is not a
// credit or spend refusal, is a configuration answer. Everything else stays a signal.
// A timeout, a network failure, a redirect, or a base URL that is not http(s) with a host is unreachable, and no error text is kept.
// The API version the docs list first and recommend: https://platform.claude.com/docs/en/api/versioning, read 2026-10-25.
import { CREDIT, SPEND, signalFromBody } from "./outcome-anthropic.ts";
import type { ProbeAnswer, ProbeRequest, ProviderProbe, ProviderSignal } from "../application/ports.ts";

export const PROBE_VERSION = "2026-10-21";
export const PROBE_TIMEOUT_MS = 5000;
const BODY_LIMIT = 8192;

const BLANK: Omit<ProviderSignal, "status"> = {
  kind: null, text: null, retryAfterSeconds: null, code: null, resumeDate: null,
};

function messagesUrl(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { return null; }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.host === "") return null;
  return `${trimmed.replace(/\/+$/u, "")}/v1/messages`;
}

function configuration(signal: ProviderSignal): "model" | "version" | null {
  if (signal.status === 404 && signal.kind === "not_found_error") return "model";
  if (signal.status !== 400 || signal.kind !== "invalid_request_error") return null;
  const text = signal.text ?? "";
  if (CREDIT.test(text) || SPEND.test(text)) return null;
  if (/anthropic-version/i.test(text)) return "version";
  if (/\bmodel\b/i.test(text)) return "model";
  return null;
}

function redact(signal: ProviderSignal, secret: string): ProviderSignal {
  if (secret === "") return signal;
  const hide = (value: string | null): string | null => value === null ? null : value.replaceAll(secret, "[redacted]");
  return { ...signal, kind: hide(signal.kind), text: hide(signal.text), code: hide(signal.code) };
}

async function limitedText(response: Response, limit: number): Promise<string> {
  const stream = response.body;
  if (stream === null) return "";
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let used = 0;
  try {
    while (used < limit) {
      const step = await reader.read();
      if (step.done) break;
      const room = limit - used;
      if (step.value.byteLength > room) {
        const copy = new Uint8Array(room);
        copy.set(step.value.subarray(0, room));
        parts.push(copy);
        used += room;
        break;
      }
      parts.push(step.value);
      used += step.value.byteLength;
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(used);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export class AnthropicProbe implements ProviderProbe {
  readonly #refOf: (connection: string) => string | null;
  readonly #open: (ref: string) => Promise<string>;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  constructor(deps: {
    refOf(connection: string): string | null;
    open(ref: string): Promise<string>;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.#refOf = connection => deps.refOf(connection);
    this.#open = ref => deps.open(ref);
    this.#fetch = deps.fetch ?? fetch;
    this.#timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  }

  async probe(request: ProbeRequest): Promise<ProbeAnswer> {
    const url = messagesUrl(request.baseUrl);
    if (url === null) return { unreachable: true };
    const ref = this.#refOf(request.connection);
    if (ref === null) return { unreachable: true };
    let secret: string;
    try { secret = await this.#open(ref); } catch { return { unreachable: true }; }
    try {
      const response = await this.#fetch(url, {
        method: "POST",
        headers: {
          "x-api-key": secret,
          "anthropic-version": PROBE_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: request.model, max_tokens: 1, messages: [{ role: "user", content: "." }] }),
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: "error",
      });
      if (response.ok) {
        await response.body?.cancel();
        return { signal: { status: response.status, ...BLANK } };
      }
      const body = await limitedText(response, BODY_LIMIT);
      const signal = signalFromBody(response.status, body, response.headers.get("retry-after"));
      const word = configuration(signal);
      if (word !== null) return { misconfigured: word };
      return { signal: redact(signal, secret) };
    } catch {
      return { unreachable: true };
    }
  }
}
