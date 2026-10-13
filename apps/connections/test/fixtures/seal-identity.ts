import { readFileSync } from "node:fs";
import { SecretMaterial } from "../../src/adapters/secret-material.ts";
import { AgeVault } from "../../src/adapters/vault-age.ts";
import { keysBeside } from "./keys.ts";

const [dir, identity, ref] = process.argv.slice(2);
if (!dir || !identity || !ref) throw new Error("usage");
const vault = new AgeVault(dir, identity, keysBeside(identity));
await vault.seal(ref, new SecretMaterial(new TextEncoder().encode("synthetic-key-0123456789ab")));
process.stdout.write(readFileSync(identity, "utf8"));
