// The two vault adapters share this shape. seal, open and fingerprint are promises, so a caller
// cannot treat one vault's result as the other's bytes.
import type { SecretMaterial } from "./secret-material.ts";

export interface Vault {
  seal(ref: string, material: SecretMaterial): Promise<void>;
  open(ref: string): Promise<SecretMaterial>;
  has(ref: string): boolean;
  fingerprint(ref: string): Promise<string | null>;
  remove(ref: string): void;
}
