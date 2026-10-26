// The signed documents are the bytes, so every writer emits the same text: insertion-ordered keys,
// two-space JSON, one trailing newline. Times are UTC with a Z and no fraction, which is what the
// wire schemas accept (packages/protocol/src/releases.ts).

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function isoUtc(ms: number): string {
  if (!Number.isInteger(ms)) throw new Error(`refusing a non-integer instant ${String(ms)}`);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
