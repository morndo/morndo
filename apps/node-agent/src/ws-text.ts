// A WebSocket message as text. ws hands over a Buffer by default, a list of Buffers for a fragmented message, or an
// ArrayBuffer when asked to (ws 8.22.0 doc/ws.md, event 'message': `data` is Buffer | ArrayBuffer | Buffer[]).
import type { RawData } from "ws";

export function wsText(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}
