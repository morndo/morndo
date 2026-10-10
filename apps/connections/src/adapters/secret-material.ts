// Bytes of a sealed secret. Application code cannot import this file. It never serialises.
export class SecretMaterial {
  readonly #bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.#bytes = bytes; }
  bytes(): Uint8Array { return this.#bytes; }
  toJSON(): string { return "[secret]"; }
  toString(): string { return "[secret]"; }
}
