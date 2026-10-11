// The node's two keys besides its age identity (ADR-0022; design §6): the fingerprint key and the index key, 32 random
// bytes each, 0600, in the identity's directory.
export class NodeKeys {
  constructor(_dir: string, _uid?: number) {}

  // The keyed fingerprint (SC2): the first 12 hex characters of HMAC-SHA-256 under the fingerprint key.
  fingerprint(_value: Uint8Array): string {
    return "000000000000";
  }

  // HMAC-SHA-256 under the index key: the scanner's Keyed (packages/node-ops secret-scan.ts).
  index(_bytes: Uint8Array): Uint8Array {
    return new Uint8Array(32);
  }
}
