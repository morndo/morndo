// The node's exact filter (ADR-0022; design §8.1): the encodings a value is indexed in. Pure: no file system, no process.
export type SecretEncoding = "raw" | "hex" | "percent" | "json" | "base64" | "base64url";
export type EncodedForm = { encoding: SecretEncoding; alignment: 0 | 1 | 2 | null; bytes: Uint8Array; before: number; after: number };

export function encodedForms(_value: Uint8Array): EncodedForm[] {
  return [];
}
